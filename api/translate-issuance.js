// Vercel serverless function: translate a WHOLE issuance once, keyed by
// (office, productId), and serve it CDN-cached. This converts AI spend from
// traffic-bounded (per user × per section POSTs) to issuance-bounded: an AFD's
// text never changes for a given product id, so one translation pass serves
// every reader from cache — a front-page spike hits the CDN, not the model.
import { generateText } from 'ai';
import { OFFICE_NAMES, SECTION_NAMES } from '../docs/js/offices.js';
import { fetchAFDList, fetchAFDProduct, productUrlFromItem } from './_utils.js';
import { extractSections } from './_afd-sections.js';
import { buildSystemPrompt } from './translate.js';
import { getSnapshot, putSnapshot } from './_snapshots.js';

// `${office}|${id}` -> { payload, time }. A completed issuance is immutable,
// so the TTL exists only to bound memory, not for freshness.
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
const CACHE_MAX = 200;

function setCache(key, payload) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { payload, time: Date.now() });
}

// Per-IP rate limit: a cold (office,id) pair fans out to ~8 model calls, so
// this endpoint gets a tighter budget than single-section /api/translate.
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 20;

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

// Mirror the client parser's section keying (SECTION_NAMES map, else Title Case)
// so returned keys line up with what app.js renders.
function displayKey(rawKey) {
    return SECTION_NAMES[rawKey] || rawKey.charAt(0) + rawKey.slice(1).toLowerCase();
}

// Sections that are never AI-translated: alerts render from the live alerts
// API, and sub-minimum fragments aren't worth a model call.
const SKIP_KEYS = new Set(['Active Alerts']);
const MIN_SECTION_CHARS = 20;
const MAX_SECTION_CHARS = 10000;
const MAX_SECTIONS = 10;

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

    const office = (req.query.office || '').toUpperCase();
    if (!OFFICE_NAMES[office]) return res.status(400).json({ error: 'Invalid office' });

    const id = typeof req.query.id === 'string' ? req.query.id.trim() : '';
    if (!id || id.length > 64 || !/^[\w.:-]+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid id' });
    }

    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIp)) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    const cacheKey = `${office}|${id}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.time < CACHE_TTL) {
        res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=2592000');
        return res.status(200).json({ ...hit.payload, cached: true });
    }

    // Durable snapshot (if Blob is provisioned): serves permalinks even after
    // the issuance ages out of NWS retention, and skips re-translation.
    const snap = await getSnapshot(office, id);
    if (snap && snap.sections) {
        setCache(cacheKey, snap);
        res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=2592000');
        return res.status(200).json({ ...snap, cached: true });
    }

    try {
        // The id must name a genuinely retained issuance of this office — the
        // list lookup is what makes this endpoint's input unforgeable.
        const list = (await fetchAFDList(office, { signal: AbortSignal.timeout(8000) })).slice(0, 40);
        const item = list.find(it => (it?.id || it?.['@id']) === id);
        if (!item) {
            res.setHeader('Cache-Control', 'public, s-maxage=600');
            return res.status(404).json({ error: 'Unknown edition' });
        }

        const prod = await fetchAFDProduct(productUrlFromItem(item), { signal: AbortSignal.timeout(8000) });
        const productText = typeof prod?.productText === 'string' ? prod.productText : '';
        if (!productText) return res.status(502).json({ error: 'Empty product' });
        const issuanceTime = typeof prod.issuanceTime === 'string' ? prod.issuanceTime : null;

        const sections = extractSections(productText)
            .map(s => ({ key: displayKey(s.key), text: s.text }))
            .filter(s => !SKIP_KEYS.has(s.key))
            .filter(s => s.text.length >= MIN_SECTION_CHARS && s.text.length <= MAX_SECTION_CHARS)
            .slice(0, MAX_SECTIONS);
        if (sections.length === 0) return res.status(502).json({ error: 'No translatable sections' });

        // Translate the whole issuance in one parallel pass. Individual section
        // failures degrade gracefully — the client falls back to per-section
        // POST /api/translate for any key missing from the response.
        const settled = await Promise.all(sections.map(async (s) => {
            try {
                const result = await generateText({
                    model: 'anthropic/claude-haiku-4.5',
                    system: buildSystemPrompt({ section: s.key, office, issuanceTime }),
                    prompt: s.text,
                    maxOutputTokens: 1024,
                    abortSignal: AbortSignal.timeout(15000),
                });
                if (result.finishReason === 'content-filter') return null;
                const text = (result.text || '').trim();
                return text ? { key: s.key, text } : null;
            } catch (e) {
                return null;
            }
        }));

        const translations = {};
        for (const t of settled) {
            if (t) translations[t.key] = t.text;
        }
        if (Object.keys(translations).length === 0) {
            return res.status(502).json({ error: 'Translation unavailable' });
        }

        // productText rides along so a snapshot can reconstruct the full
        // edition (facsimile column included) after NWS deletes the product.
        const payload = { office, id, issuanceTime, productText, sections: translations };
        setCache(cacheKey, payload);
        await putSnapshot(office, id, payload);
        res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=2592000');
        return res.status(200).json({ ...payload, cached: false });
    } catch (err) {
        console.error('Issuance translation error:', err);
        return res.status(500).json({ error: 'Internal error' });
    }
}
