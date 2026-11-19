// Vercel serverless function: translate a WHOLE issuance once, keyed by
// (office, productId), and serve it CDN-cached. This converts AI spend from
// traffic-bounded (per user × per section POSTs) to issuance-bounded: an AFD's
// text never changes for a given product id, so one translation pass serves
// every reader from cache — a front-page spike hits the CDN, not the model.
import { generateText } from 'ai';
import { OFFICE_NAMES } from '../docs/js/offices.js';
import { fetchAFDList, fetchAFDProduct, productUrlFromItem } from './_utils.js';
import { displayKey, translatableSections } from './_translatable.js';
import { annotateZuluTimes, buildSystemPrompt, sanitizeTranslation, stripHeaderStamp } from './translate.js';
import { getSnapshot, putSnapshot } from './_snapshots.js';
import { sendError } from './_errors.js';
import { sharedGet, sharedSetReported, translationKey, TRANSLATION_TTL } from './_shared-cache.js';
import { MODEL, PROVIDER_OPTIONS } from './_model.js';
import { createColdBudget, overCapacityError, rejectUnknownParams, sendOverCapacity } from './_query-guard.js';
import { PRETRANSLATE, switchOn } from './_store.js';
import { storeReusedSection, withReusedSections } from './_section-reuse.js';

// Instance-wide cap on cold model calls per minute (each cold issuance costs
// one call per section, so it is charged sections.length at once).
export const coldBudget = createColdBudget(60);

// Thrown statusCode → machine code. 404 = an id this office never issued.
function issuanceErrorCode(status) {
    if (status === 404) return 'invalid_id';
    if (status === 503) return 'over_capacity';
    return 'upstream_error';
}
function sendIssuanceError(res, e) {
    if (e?.code === 'over_capacity') return sendOverCapacity(res, e);
    if (e.statusCode === 404) res.setHeader('Cache-Control', 'public, s-maxage=60');
    return sendError(res, e.statusCode, issuanceErrorCode(e.statusCode), e.publicMessage || 'Translation unavailable');
}

// `${office}|${id}` -> { payload, time }. A completed issuance is immutable,
// so the TTL exists only to bound memory, not for freshness.
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
const CACHE_MAX = 200;
const inFlight = new Map(); // cacheKey -> Promise<payload> during the fan-out

function setCache(key, payload) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { payload, time: Date.now() });
}

// Per-IP rate limit: a cold (office,id) pair fans out to ~8 model calls, so
// this endpoint gets a tighter budget than single-section /api/translate.
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 6; // each cold request fans out to ~8 model calls

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

// A shared-store entry is served only when it is a complete translation of
// exactly this office + id (the store is keyed by hash; the value proves
// itself). Anything else is a miss.
function completeSharedPayload(entry, office, id) {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.office !== office || entry.id !== id || entry.complete !== true) return null;
    const s = entry.sections;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    const values = Object.values(s);
    if (values.length === 0 || !values.every(v => typeof v === 'string' && v)) return null;
    return entry;
}

// Which sections are translated, and under which key (pure; shared with the
// page functions, which join stored translations to the sections they render).
export { displayKey, translatableSections };

// ── The translation core ─────────────────────────────────────────────
// Shared by this endpoint and the scheduled poller (api/cron-refresh.js):
// one code path, one prompt and one sanitizer (both from translate.js), and
// the same shared-cache keys, so whichever runs first pays and the other is
// served the stored result.

// One model call for one section: the sanitized translation, or null for a
// refusal, an empty answer, an error or a timeout. Individual failures
// degrade gracefully: the client falls back to per-section POST
// /api/translate for any key missing from the edition's map.
// The prompt and sanitizer live in translate.js: bump the version in
// api/_shared-cache.js when this output's rules change.
// `maxRetries` (the AI SDK's retry count) is passed only by the poller,
// which sets 0 so one reserved call is one request; the endpoint keeps the
// SDK default.
export async function translateSection({ office, issuanceTime, key, text, maxRetries }) {
    try {
        const result = await generateText({
            model: MODEL,
            providerOptions: PROVIDER_OPTIONS,
            system: buildSystemPrompt({ section: key, office, issuanceTime, text }),
            prompt: annotateZuluTimes(stripHeaderStamp(text), office, issuanceTime),
            maxOutputTokens: 2048,
            abortSignal: AbortSignal.timeout(15000),
            ...(maxRetries === undefined ? {} : { maxRetries }),
        });
        if (result.finishReason === 'content-filter') return null;
        // Same output guard as /api/translate, before cache + snapshot.
        const out = sanitizeTranslation((result.text || '').trim(), { office, issuanceTime });
        return out || null;
    } catch (e) {
        return null;
    }
}

// Translate a whole edition in one parallel pass. `sections` defaults to
// translatableSections(productText); a section that carries `reused` (a
// stored translation of the same text, see api/_store.js) costs no call.
// `onTranslated(section, text)` sees every fresh section translation (the
// poller stores them for reuse). Throws a 502 when nothing translated.
// productText rides along so a snapshot can reconstruct the full edition
// (facsimile column included) after NWS deletes the product.
export async function translateEdition({
    office, id, issuanceTime, productText,
    sections = translatableSections(productText),
    onTranslated = null,
    maxRetries,
}) {
    const settled = await Promise.all(sections.map(async (s) => {
        if (typeof s.reused === 'string' && s.reused) return { key: s.key, text: s.reused };
        const text = await translateSection({ office, issuanceTime, key: s.key, text: s.text, maxRetries });
        if (text && onTranslated) {
            try { await onTranslated(s, text); } catch { /* reuse is an optimisation */ }
        }
        return text ? { key: s.key, text } : null;
    }));
    const translations = {};
    for (const t of settled) {
        if (t) translations[t.key] = t.text;
    }
    if (Object.keys(translations).length === 0) {
        throw Object.assign(new Error('all sections failed'), { statusCode: 502, publicMessage: 'Translation unavailable' });
    }
    const complete = Object.keys(translations).length === sections.length;
    return { office, id, issuanceTime, productText, sections: translations, complete };
}

// A COMPLETE result is kept in this instance's memory, the durable
// snapshot and the shared store. A partial one must not be frozen: the
// caller never passes it here. The shared write is awaited: a write left
// running after the response can be lost when the function is frozen.
// Resolves true when the shared-store write landed (the poller marks an
// edition done only then; the snapshot is best-effort and not reported).
export async function persistTranslation(office, id, payload, { timeoutMs } = {}) {
    setCache(`${office}|${id}`, payload);
    const [, stored] = await Promise.all([
        putSnapshot(office, id, payload),
        sharedSetReported(translationKey(office, id), { ...payload, office, id, complete: true },
            { ttl: TRANSLATION_TTL, ...(timeoutMs ? { timeoutMs } : {}) }),
    ]);
    return stored;
}

export default async function handler(req, res) {
    if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', 'GET only', { allow: ['GET'] });
    if (rejectUnknownParams(req, res, ['office', 'id'])) return;

    const office = String(req.query.office ?? '').toUpperCase(); // String(): a repeated ?office= arrives as an array
    if (!OFFICE_NAMES[office]) return sendError(res, 400, 'invalid_office', 'Invalid office');

    const id = typeof req.query.id === 'string' ? req.query.id.trim() : '';
    if (!id || id.length > 64 || !/^[\w.:-]+$/.test(id)) {
        return sendError(res, 400, 'invalid_id', 'Invalid id');
    }

    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIp)) {
        return sendError(res, 429, 'rate_limited', 'Too many requests. Please try again later.');
    }

    const cacheKey = `${office}|${id}`;
    const memoryHit = () => {
        const hit = cache.get(cacheKey);
        return hit && Date.now() - hit.time < CACHE_TTL ? hit.payload : null;
    };
    let payloadHit = memoryHit();

    // Shared store (api/_shared-cache.js): an issuance another instance in
    // this region already translated is served like an in-memory hit, so a
    // cold instance never re-bills it. Only complete payloads are ever
    // written there. Re-check memory after the await: a concurrent request
    // in this instance may have finished the cold path meanwhile.
    if (!payloadHit) {
        const shared = completeSharedPayload(await sharedGet(translationKey(office, id)), office, id);
        payloadHit = memoryHit();
        if (!payloadHit && shared) {
            setCache(cacheKey, shared);
            payloadHit = shared;
        }
    }
    if (payloadHit) {
        res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=2592000');
        return res.status(200).json({ ...payloadHit, cached: true });
    }

    // In-flight dedup: N readers arriving in the cold window (a new issuance,
    // a launch spike) must share ONE pipeline run, not trigger N×8 model calls.
    // Fluid Compute shares this module across concurrent requests. The shared
    // promise covers the WHOLE cold path (snapshot check → NWS fetches →
    // fan-out); it is registered synchronously, so there is no await-window in
    // which a second request can start a duplicate run.
    const pending = inFlight.get(cacheKey);
    if (pending) {
        try {
            const payload = await pending;
            res.setHeader('Cache-Control', payload.complete
                ? 'public, s-maxage=86400, stale-while-revalidate=2592000'
                : 'public, s-maxage=300');
            return res.status(200).json({ ...payload, cached: true });
        } catch (e) {
            return sendIssuanceError(res, { ...e, statusCode: e?.statusCode || 502, code: e?.code, publicMessage: e?.publicMessage });
        }
    }

    const work = (async () => {
        // Durable snapshot (if Blob is provisioned): serves permalinks even
        // after the issuance ages out of NWS retention, skips re-translation.
        const snap = await getSnapshot(office, id);
        if (snap && snap.sections) return { ...snap, complete: true };

        // The id must name a genuinely retained issuance of this office — the
        // list lookup is what makes this endpoint's input unforgeable.
        const list = (await fetchAFDList(office, { signal: AbortSignal.timeout(8000) })).slice(0, 40);
        const item = list.find(it => (it?.id || it?.['@id']) === id);
        if (!item) {
            // Short CDN window on the 404: an NWS list flap must not poison a
            // real edition for long.
            throw Object.assign(new Error('unknown edition'), { statusCode: 404, publicMessage: 'Unknown edition' });
        }

        const prod = await fetchAFDProduct(productUrlFromItem(item), { signal: AbortSignal.timeout(8000) });
        const productText = typeof prod?.productText === 'string' ? prod.productText : '';
        if (!productText) throw Object.assign(new Error('empty product'), { statusCode: 502, publicMessage: 'Empty product' });
        const issuanceTime = typeof prod.issuanceTime === 'string' ? prod.issuanceTime : null;

        let sections = translatableSections(productText);
        if (sections.length === 0) throw Object.assign(new Error('no sections'), { statusCode: 502, publicMessage: 'No translatable sections' });
        // Section reuse (api/_section-reuse.js) only with PLAINCAST_PRETRANSLATE=1:
        // a section translated before, for the same prompt, costs no call.
        // Off, every section is charged and translated exactly as before.
        const reuse = switchOn(PRETRANSLATE);
        if (reuse) sections = await withReusedSections(office, issuanceTime, sections);
        const needed = sections.filter(s => !s.reused).length;
        if (needed > 0 && !coldBudget.take(needed)) throw overCapacityError();

        return translateEdition({
            office, id, issuanceTime, productText, sections,
            onTranslated: reuse ? (s, text) => storeReusedSection(office, issuanceTime, s, text) : null,
        });
    })();
    inFlight.set(cacheKey, work); // no await between creation and registration

    try {
        let payload;
        try {
            payload = await work;
        } finally {
            inFlight.delete(cacheKey);
        }

        // A PARTIAL result (some sections failed) must not be frozen: no
        // snapshot, no shared entry, no long CDN window, no in-memory entry —
        // a retry heals it. The shared write is awaited: a write left running
        // after the response can be lost when the function is frozen.
        if (payload.complete) {
            await persistTranslation(office, id, payload);
            res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=2592000');
        } else {
            res.setHeader('Cache-Control', 'public, s-maxage=300');
        }
        return res.status(200).json({ ...payload, cached: false });
    } catch (err) {
        if (err?.statusCode) return sendIssuanceError(res, err);
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
            return sendError(res, 504, 'timeout', 'Translation timed out');
        }
        console.error('Issuance translation error:', err);
        return sendError(res, 500, 'internal_error', 'Internal error');
    }
}
