// Vercel serverless function: one-line plain-English "what changed since the
// last AFD issuance" per office. Diffs the latest two AFDs at the paragraph
// level and summarizes the delta via Claude Haiku (AI Gateway), cached per
// issuance so AI runs at most once per (office, issuance).
import { generateText } from 'ai';
import { OFFICE_NAMES } from '../docs/js/offices.js';
import { fetchAFDList, fetchAFDProduct, productUrlFromItem } from './_utils.js';

// currentProductId -> { changelog, since, updated, time }
const cache = new Map();
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
const LATEST_CACHE = 'public, s-maxage=3600, stale-while-revalidate=7200';
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

    try {
        const list = await fetchAFDList(office, { signal: AbortSignal.timeout(8000) });
        let items;
        let cacheHeader = LATEST_CACHE;
        if (pinnedId) {
            const idx = list.findIndex(it => (it?.id || it?.['@id']) === pinnedId);
            if (idx === -1 || idx + 1 >= list.length) {
                // Unknown or oldest-retained issuance: nothing to diff against.
                res.setHeader('Cache-Control', 'public, s-maxage=3600');
                return res.status(200).json({ changelog: null });
            }
            items = [list[idx], list[idx + 1]];
            if (idx > 0) cacheHeader = PINNED_CACHE;
        } else {
            items = list.slice(0, 2);
        }
        if (items.length < 2) {
            res.setHeader('Cache-Control', 'public, s-maxage=600');
            return res.status(200).json({ changelog: null });
        }

        const currentId = items[0]?.id || items[0]?.['@id'] || null;
        const hit = currentId && cache.get(currentId);
        if (hit && Date.now() - hit.time < CACHE_TTL) {
            res.setHeader('Cache-Control', cacheHeader);
            return res.status(200).json({ changelog: hit.changelog, since: hit.since, updated: hit.updated, cached: true });
        }

        const [currProd, prevProd] = await Promise.all([
            fetchAFDProduct(productUrlFromItem(items[0]), { signal: AbortSignal.timeout(8000) }),
            fetchAFDProduct(productUrlFromItem(items[1]), { signal: AbortSignal.timeout(8000) }),
        ]);
        const currText = typeof currProd?.productText === 'string' ? currProd.productText : '';
        const prevText = typeof prevProd?.productText === 'string' ? prevProd.productText : '';
        const since = prevProd?.issuanceTime || null;
        const updated = currProd?.issuanceTime || null;
        if (!currText || !prevText) return res.status(200).json({ changelog: null });

        const changes = changedParagraphs(prevText, currText).slice(0, 6);
        if (changes.length === 0) {
            const payload = { changelog: null, since, updated };
            if (currentId) setCache(currentId, payload);
            res.setHeader('Cache-Control', cacheHeader);
            return res.status(200).json({ ...payload, cached: false });
        }

        const system = `You summarize what changed between two consecutive National Weather Service Area Forecast Discussions. Given the NEW or CHANGED passages from the latest update, write ONE warm, plain-English sentence (max ~30 words) describing what changed for a general reader: shifts in timing, rain or snow chances, temperatures, hazards, or forecaster confidence. No preamble, no markdown, no lists, no quotes. If the changes are purely administrative or trivial (minor wording, aviation/TAF codes only), respond with exactly: NONE`;
        const prompt = `Forecast office: ${OFFICE_NAMES[office]}.\n\nNEW OR CHANGED PASSAGES FROM THE LATEST UPDATE:\n\n${changes.join('\n\n')}`;

        const result = await generateText({
            model: 'anthropic/claude-haiku-4.5',
            system,
            prompt,
            maxOutputTokens: 120,
            abortSignal: AbortSignal.timeout(15000),
        });

        let changelog = (result.text || '').trim();
        if (!changelog || result.finishReason === 'content-filter' || /^none[.!]?$/i.test(changelog)) {
            changelog = null;
        }

        const payload = { changelog, since, updated };
        if (currentId) setCache(currentId, payload);
        res.setHeader('Cache-Control', cacheHeader);
        return res.status(200).json({ ...payload, cached: false });
    } catch (err) {
        console.error('Changelog error:', err);
        // Soft-fail: the feature simply doesn't render rather than erroring the page.
        return res.status(200).json({ changelog: null });
    }
}
