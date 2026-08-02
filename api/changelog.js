// Vercel serverless function: one-line plain-English "what changed since the
// last AFD issuance" per office. Diffs the latest two AFDs at the paragraph
// level and summarizes the delta via DeepSeek V4 Flash (AI Gateway), cached per
// issuance so AI runs at most once per (office, issuance).
import { generateText } from 'ai';
import { OFFICE_NAMES } from '../docs/js/offices.js';
import { fetchAFDList, fetchAFDProduct, productUrlFromItem } from './_utils.js';

// currentProductId -> { changelog, since, updated, time }
const cache = new Map();
// office -> { payload, time }: skips the NWS list fetch on the hot no-id path.
// 5 minutes is well inside the CDN's own s-maxage=3600 staleness window.
const latestMemo = new Map();
const LATEST_MEMO_TTL = 5 * 60 * 1000;
const inFlight = new Map(); // office|id -> Promise<payload> (dedup concurrent misses)

// Per-IP rate limit — every other model-calling endpoint has one; the ledger
// fans this endpoint out per timeline entry, so it must not be the soft spot.
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 30; // one AI call per cache-cold issuance pair

function checkRateLimit(ip) {
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry) {
        rateLimitMap.set(ip, { timestamps: [now] });
        return true;
    }
    entry.timestamps = entry.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
    if (entry.timestamps.length >= RATE_LIMIT_MAX) return false;
    entry.timestamps.push(now);
    return true;
}

const rateLimitCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
        entry.timestamps = entry.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
        if (entry.timestamps.length === 0) rateLimitMap.delete(ip);
    }
    if (rateLimitMap.size > 10_000) rateLimitMap.clear();
}, 5 * 60 * 1000);
rateLimitCleanupTimer.unref?.();
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4h (an AFD is stable until the next issuance)
const CACHE_MAX = 300;

function setCache(id, payload) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(id, { ...payload, time: Date.now() });
}

function paragraphs(text) {
    return String(text || '')
        .split(/\n\s*\n+/)
        .map(p => p.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
}

function normPara(p) {
    return p.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

// Paragraphs present in the current AFD but not the previous one (added or
// reworded), skipping short lines, headers, signatures and "None." noise.
export function changedParagraphs(prevText, currText) {
    const prevSet = new Set(paragraphs(prevText).map(normPara));
    return paragraphs(currText).filter(p => {
        if (/^\$\$|^&&/.test(p)) return false;
        const n = normPara(p);
        if (n.length < 60) return false; // headers, short lines, "none", TAF stubs
        return !prevSet.has(n);
    });
}

// Requests for a specific (non-latest) issuance pair get long CDN caching —
// a completed pair of AFDs never changes, so the summary is effectively
// immutable. The latest pair keeps a shorter window (a newer AFD supersedes it).
const LATEST_CACHE = 'public, s-maxage=900, stale-while-revalidate=3600';
const PINNED_CACHE = 'public, s-maxage=86400, stale-while-revalidate=604800';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

    const office = (req.query.office || '').toUpperCase();
    if (!OFFICE_NAMES[office]) return res.status(400).json({ error: 'Invalid office' });

    // Optional: pin the summary to a specific issuance (?id=<productId>) so the
    // changelog timeline can label every retained edition, not just the latest.
    const pinnedId = typeof req.query.id === 'string' ? req.query.id.trim() : '';
    if (pinnedId && (pinnedId.length > 64 || !/^[\w.:-]+$/.test(pinnedId))) {
        return res.status(400).json({ error: 'Invalid id' });
    }

    const clientIp = req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIp)) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    if (!pinnedId) {
        const memo = latestMemo.get(office);
        if (memo && Date.now() - memo.time < LATEST_MEMO_TTL) {
            res.setHeader('Cache-Control', LATEST_CACHE);
            return res.status(200).json({ ...memo.payload, cached: true });
        }
    }

    // In-flight dedup: N readers hitting the same cold (office, issuance) in the
    // memo window must share ONE cold pass (list + product fetches + diff +
    // generateText), not each fire a model call. The pinned path knows its id
    // up front (that id IS the current of the diff pair); the latest path keys
    // on office. The shared promise wraps the WHOLE cold path and is registered
    // synchronously, so there is no await-window for a duplicate run to start.
    const flightKey = pinnedId ? `${office}|${pinnedId}` : office;
    const pending = inFlight.get(flightKey);
    if (pending) {
        try {
            const r = await pending;
            if (r.cacheHeader) res.setHeader('Cache-Control', r.cacheHeader);
            return res.status(r.status).json({ ...r.body, cached: true });
        } catch (err) {
            // Mirror the cold-path soft-fail so a shared failure doesn't leak
            // an error status to piggybacking readers.
            res.setHeader('Cache-Control', 'public, s-maxage=60');
            return res.status(200).json({ changelog: null, transient: true });
        }
    }

    // Each branch returns a { status, cacheHeader, body } descriptor; the body
    // carries its own `cached` flag where the original responses set one.
    const work = (async () => {
        const list = await fetchAFDList(office, { signal: AbortSignal.timeout(8000) });
        let items;
        let cacheHeader = LATEST_CACHE;
        if (pinnedId) {
            const idx = list.findIndex(it => (it?.id || it?.['@id']) === pinnedId);
            if (idx === -1 || idx + 1 >= list.length) {
                // Unknown or oldest-retained issuance: nothing to diff against.
                return { status: 200, cacheHeader: 'public, s-maxage=3600', body: { changelog: null } };
            }
            items = [list[idx], list[idx + 1]];
            if (idx > 0) cacheHeader = PINNED_CACHE;
        } else {
            items = list.slice(0, 2);
        }
        if (items.length < 2) {
            return { status: 200, cacheHeader: 'public, s-maxage=600', body: { changelog: null } };
        }

        const currentId = items[0]?.id || items[0]?.['@id'] || null;
        const hit = currentId && cache.get(currentId);
        if (hit && Date.now() - hit.time < CACHE_TTL) {
            return { status: 200, cacheHeader, body: { changelog: hit.changelog, since: hit.since, updated: hit.updated, cached: true } };
        }

        const [currProd, prevProd] = await Promise.all([
            fetchAFDProduct(productUrlFromItem(items[0]), { signal: AbortSignal.timeout(8000) }),
            fetchAFDProduct(productUrlFromItem(items[1]), { signal: AbortSignal.timeout(8000) }),
        ]);
        const currText = typeof currProd?.productText === 'string' ? currProd.productText : '';
        const prevText = typeof prevProd?.productText === 'string' ? prevProd.productText : '';
        const since = prevProd?.issuanceTime || null;
        const updated = currProd?.issuanceTime || null;
        if (!currText || !prevText) return { status: 200, cacheHeader: null, body: { changelog: null } };

        const changes = changedParagraphs(prevText, currText).slice(0, 6);
        if (changes.length === 0) {
            const payload = { changelog: null, since, updated };
            if (currentId) setCache(currentId, payload);
            if (!pinnedId) latestMemo.set(office, { payload, time: Date.now() });
            return { status: 200, cacheHeader, body: { ...payload, cached: false } };
        }

        const system = `You summarize what changed between two consecutive National Weather Service Area Forecast Discussions. Given the NEW or CHANGED passages from the latest update, write ONE warm, plain-English sentence (max ~30 words) describing what changed for a general reader: shifts in timing, rain or snow chances, temperatures, hazards, or forecaster confidence. No preamble, no markdown, no lists, no quotes. If the changes are purely administrative or trivial (minor wording, aviation/TAF codes only), respond with exactly: NONE`;
        const prompt = `Forecast office: ${OFFICE_NAMES[office]}.\n\nNEW OR CHANGED PASSAGES FROM THE LATEST UPDATE:\n\n${changes.join('\n\n')}`;

        const result = await generateText({
            model: 'deepseek/deepseek-v4-flash-0731',
            system,
            prompt,
            maxOutputTokens: 120,
            abortSignal: AbortSignal.timeout(15000),
        });

        let changelog = (result.text || '').trim();
        let trivial = false;
        if (result.finishReason === 'content-filter' || /^none[.!]?$/i.test(changelog)) {
            changelog = null;
            trivial = true; // a real verdict: the changes aren't newsworthy
        } else if (!changelog) {
            // Empty model output is a transient failure, not a verdict — do
            // not cache it anywhere or the ledger fabricates "minor refinements".
            return { status: 200, cacheHeader: 'public, s-maxage=60', body: { changelog: null, since, updated, transient: true } };
        }

        const payload = { changelog, since, updated, ...(trivial ? { trivial } : {}) };
        if (currentId) setCache(currentId, payload);
        if (!pinnedId) latestMemo.set(office, { payload, time: Date.now() });
        return { status: 200, cacheHeader, body: { ...payload, cached: false } };
    })();
    inFlight.set(flightKey, work); // no await between creation and registration

    try {
        let r;
        try {
            r = await work;
        } finally {
            inFlight.delete(flightKey);
        }
        if (r.cacheHeader) res.setHeader('Cache-Control', r.cacheHeader);
        return res.status(r.status).json(r.body);
    } catch (err) {
        console.error('Changelog error:', err);
        // Soft-fail: the feature simply doesn't render rather than erroring the
        // page — but let the CDN absorb failure storms for a minute. transient
        // tells the client this was a failure, not a "nothing changed" verdict.
        res.setHeader('Cache-Control', 'public, s-maxage=60');
        return res.status(200).json({ changelog: null, transient: true });
    }
}
