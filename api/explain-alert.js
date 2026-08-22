// Vercel serverless function: plain-English explanation of one NWS alert.
// The alert modal shows p.description + p.instruction verbatim — the highest-
// stakes text on the page was the only text that never got the plain-language
// treatment. This endpoint fetches the alert SERVER-SIDE by its URN id, so the
// model's input is unforgeable (nothing client-supplied is translated), then
// caches per alert id — NWS issues updated alerts under new ids, so an id's
// content is effectively immutable.
import { generateText } from 'ai';
import { fetchAlertById } from './_utils.js';
import { sendError as sendJsonError } from './_errors.js';

const cache = new Map(); // alert id -> { explanation, time }
const CACHE_TTL = 4 * 60 * 60 * 1000;
const CACHE_MAX = 300;
const inFlight = new Map(); // alert id -> Promise<string> (dedup concurrent misses)

function setCache(id, explanation) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(id, { explanation, time: Date.now() });
}

// Alerts are urgent-path requests; keep the budget tight anyway — every miss
// is a model call, and alert ids are enumerable from the public alerts feed.
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

const SYSTEM = `You translate National Weather Service alerts into calm, plain English for a general reader. Given an alert's official text, write a short explanation covering: what is happening, exactly where and until when, and what a person there should actually do. Rules:
- Preserve ALL specifics: place names, times, amounts, wind speeds, road names
- Calm and factual — no hype, no exclamation points, no alarmist framing beyond what the alert itself states
- Plain prose in 1-3 short paragraphs, 120 words maximum
- Bold the single most important action with **markdown bold**; no headers, lists, or quotes
- Do not add information that is not in the alert`;

// Translate a structured error (or a raw fetch/model failure) into the exact
// HTTP responses the endpoint has always produced. Shared by the fresh path
// and the piggybacking-awaiter path so both react to a shared failure identically.
function sendError(res, e) {
    if (e?.statusCode) {
        if (e.cacheHeader) res.setHeader('Cache-Control', e.cacheHeader);
        // Map the thrown status onto a machine code; `error` and `reason` keep
        // the exact values this endpoint has always returned.
        const code = e.statusCode === 429 ? 'rate_limited'
            : e.statusCode === 404 ? 'not_found'
            : e.statusCode >= 500 ? 'upstream_error'
            : 'invalid_request';
        return sendJsonError(res, e.statusCode, code, e.publicMessage,
            e.reason ? { reason: e.reason } : {});
    }
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
        return sendJsonError(res, 504, 'timeout', 'Explanation timed out');
    }
    console.error('Explain-alert error:', e);
    return sendJsonError(res, 500, 'internal_error', 'Internal error');
}

export default async function handler(req, res) {
    if (req.method !== 'GET') return sendJsonError(res, 405, 'method_not_allowed', 'GET only', { allow: ['GET'] });

    const id = typeof req.query.id === 'string' ? req.query.id.trim() : '';
    // NWS alert ids are URNs like urn:oid:2.49.0.1.840.0.<digits>...
    if (!id || id.length > 300 || !/^urn:oid:[\w.:,-]+$/.test(id)) {
        return sendJsonError(res, 400, 'invalid_id', 'Invalid alert id');
    }

    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIp)) {
        return sendJsonError(res, 429, 'rate_limited', 'Too many requests. Please try again later.');
    }

    const hit = cache.get(id);
    if (hit && Date.now() - hit.time < CACHE_TTL) {
        res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');
        return res.status(200).json({ explanation: hit.explanation, cached: true });
    }

    // Dedup concurrent misses: everyone opening the same Warning's modal in
    // the same minute shares one model call. The server fetch and prompt build
    // live INSIDE the shared promise, which is registered synchronously right
    // after this get-miss — so concurrent requests arriving in the fetch window
    // can't each start their own fetch+model run, and no later .set() can
    // clobber an earlier in-flight promise.
    const pending = inFlight.get(id);
    if (pending) {
        try {
            const explanation = await pending;
            res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');
            return res.status(200).json({ explanation, cached: true });
        } catch (e) {
            return sendError(res, e);
        }
    }

    const work = (async () => {
        const alert = await fetchAlertById(id, { signal: AbortSignal.timeout(8000) });
        if (!alert) {
            throw Object.assign(new Error('not found'), { statusCode: 404, publicMessage: 'Alert not found', cacheHeader: 'public, s-maxage=600' });
        }

        const parts = [
            alert.event && `Event: ${alert.event}`,
            alert.headline && `Headline: ${alert.headline}`,
            alert.areaDesc && `Areas: ${alert.areaDesc}`,
            alert.expires && `Expires: ${alert.expires}`,
            alert.description && `Description:\n${alert.description}`,
            alert.instruction && `Instructions:\n${alert.instruction}`,
        ].filter(Boolean);
        const prompt = parts.join('\n\n').slice(0, 12000);
        if (prompt.length < 40) {
            throw Object.assign(new Error('no text'), { statusCode: 502, publicMessage: 'Alert has no explainable text' });
        }

        const result = await generateText({
            model: 'anthropic/claude-haiku-4.5',
            system: SYSTEM,
            prompt,
            maxOutputTokens: 400,
            abortSignal: AbortSignal.timeout(15000),
        });
        if (result.finishReason === 'content-filter') {
            throw Object.assign(new Error('filtered'), { statusCode: 503, publicMessage: 'Explanation skipped', reason: 'content-filter' });
        }
        const text = (result.text || '').trim();
        if (!text) throw Object.assign(new Error('empty'), { statusCode: 502, publicMessage: 'Empty explanation' });
        return text;
    })();
    inFlight.set(id, work); // no await between creation and registration

    let explanation;
    try {
        explanation = await work;
    } catch (e) {
        return sendError(res, e);
    } finally {
        inFlight.delete(id);
    }

    setCache(id, explanation);
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json({ explanation, cached: false });
}
