// Vercel serverless function: one plain-English sentence describing today's
// national severe-weather picture, rewritten from the SPC Day 1 Convective
// Outlook summary by Claude Haiku (AI Gateway). Sibling of api/changelog.js —
// same cache/dedup/rate-limit machinery — with one deliberate difference: this
// endpoint reads NO client input at all. There is exactly one answer at any
// moment (the latest SPC outlook), so nothing a caller sends can steer the
// model or the response; the client IP exists only to feed the rate limiter.
import { generateText } from 'ai';
import { fetchSpcDy1 } from './_utils.js';
import { parseSpcOutlook } from './_national.js';
import { sendError } from './_errors.js';

// issuanceTime -> { deck, time }
const cache = new Map();
// One national answer means one flight: N concurrent cold readers share ONE
// pass (SPC fetch + generateText) rather than each firing a model call.
const inFlight = new Map();
const FLIGHT_KEY = 'dy1';

// Per-IP rate limit — every model-calling endpoint has one. A page load costs
// at most one call here (the answer is national, not per-office), so 10/min is
// generous for a reader and tight for an abuser.
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 10;

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

const CACHE_TTL = 4 * 60 * 60 * 1000; // 4h (an outlook is stable until the next issuance)
const CACHE_MAX = 50; // one key per issuance nationwide — a day's worth is ~5

function setCache(issuance, deck) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(issuance, { deck, time: Date.now() });
}

const SUCCESS_CACHE = 'public, s-maxage=900, stale-while-revalidate=3600';
// Transient failures get a short CDN window: absorb a failure storm for a
// minute without freezing a non-answer into the edge for fifteen.
const TRANSIENT_CACHE = 'public, s-maxage=60';
const TRANSIENT = { status: 200, cacheHeader: TRANSIENT_CACHE, body: { deck: null, transient: true } };

export default async function handler(req, res) {
    if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', 'GET only', { allow: ['GET'] });

    const clientIp = req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIp)) {
        return sendError(res, 429, 'rate_limited', 'Too many requests. Please try again later.');
    }

    const pending = inFlight.get(FLIGHT_KEY);
    if (pending) {
        try {
            const r = await pending;
            if (r.cacheHeader) res.setHeader('Cache-Control', r.cacheHeader);
            return res.status(r.status).json({ ...r.body, cached: true });
        } catch (err) {
            // Mirror the cold-path soft-fail so a shared failure doesn't leak
            // an error status to piggybacking readers.
            res.setHeader('Cache-Control', TRANSIENT_CACHE);
            return res.status(200).json({ deck: null, transient: true });
        }
    }

    // The shared promise wraps the WHOLE cold path (fetch + parse +
    // generateText) and is registered synchronously below, so there is no
    // await-window for a duplicate run to start.
    const work = (async () => {
        const spc = await fetchSpcDy1({ signal: AbortSignal.timeout(8000) });
        const issued = spc?.issuanceTime || null;
        const { headline, summary } = parseSpcOutlook(spc?.productText);
        // No product, or no summary to rewrite: nothing to say and nothing to
        // cache. Not a verdict — the next issuance may parse fine.
        if (!summary) return TRANSIENT;

        if (issued) {
            const hit = cache.get(issued);
            if (hit && Date.now() - hit.time < CACHE_TTL) {
                return { status: 200, cacheHeader: SUCCESS_CACHE, body: { deck: hit.deck, issued, cached: true } };
            }
        }

        const system = `You rewrite the U.S. Storm Prediction Center's Day 1 Convective Outlook summary as ONE plain-English sentence (max ~35 words) for a general reader: where severe weather is expected today and what kind. Warm, concrete, no jargon, no preamble, no markdown. If the outlook is quiet nationwide, say so plainly.`;
        const prompt = `HEADLINE: ${headline || '(none)'}\n\nSUMMARY:\n${summary}`;

        const result = await generateText({
            model: 'anthropic/claude-haiku-4.5',
            system,
            prompt,
            maxOutputTokens: 120,
            abortSignal: AbortSignal.timeout(15000),
        });

        const deck = (result.text || '').trim();
        // An outlook always has content, so there is no "trivial" verdict here:
        // a filtered or empty answer is a failure. Never cache it, or the page
        // prints a permanent blank where the national lede belongs.
        if (result.finishReason === 'content-filter' || !deck) return TRANSIENT;

        if (issued) setCache(issued, deck);
        return { status: 200, cacheHeader: SUCCESS_CACHE, body: { deck, issued, cached: false } };
    })();
    inFlight.set(FLIGHT_KEY, work); // no await between creation and registration

    try {
        let r;
        try {
            r = await work;
        } finally {
            inFlight.delete(FLIGHT_KEY);
        }
        if (r.cacheHeader) res.setHeader('Cache-Control', r.cacheHeader);
        return res.status(r.status).json(r.body);
    } catch (err) {
        console.error('National lede error:', err);
        // Soft-fail: the deck simply doesn't render rather than erroring the
        // page. `transient` tells the client this was a failure, not a verdict.
        res.setHeader('Cache-Control', TRANSIENT_CACHE);
        return res.status(200).json({ deck: null, transient: true });
    }
}
