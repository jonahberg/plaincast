// Vercel serverless function: the National Desk's AI text, rewritten from the
// latest SPC Day 1 Convective Outlook by Claude Haiku. One request returns
// both pieces:
//   deck  one plain-English sentence from the outlook's SUMMARY
//   copy  the forecasters' post-summary discussion in plain English, as an
//         array of paragraphs — or null when the product has no discussion
//         (or the copy call failed). Never derived from the SUMMARY: the deck
//         already distills it (spec §5, never both from the same source).
//
// Sibling of api/changelog.js — same cache/dedup/rate-limit machinery — with
// one deliberate difference: this endpoint reads NO client input at all.
// There is exactly one answer at any moment (the latest SPC outlook), so
// nothing a caller sends can steer the model or the response; the client IP
// exists only to feed the rate limiter.
//
// TWO CALLS, NOT ONE PROMPT: the deck and the copy are separate generateText
// calls run in parallel, each cached per issuance on its own, so a copy
// failure never costs the deck (or the reverse), and a retry re-bills only
// the piece that failed. At most two Haiku calls per SPC issuance.
import { generateText } from 'ai';
import { fetchSpcDy1 } from './_utils.js';
import { parseSpcOutlook, parseDiscussionBody, DESK_TIME_ZONE } from './_national.js';
import { annotateZuluTimes, sanitizeTranslation } from './translate.js';
import { sendError } from './_errors.js';
import { MODEL, PROVIDER_OPTIONS } from './_model.js';
import { createColdBudget, overCapacityError, rejectUnknownParams, sendOverCapacity } from './_query-guard.js';

// Instance-wide cap on cold model calls per minute (each call counts: a cold
// issuance costs two). One national answer per SPC issuance, so real traffic
// needs a handful at most.
export const coldBudget = createColdBudget(10);

// issuanceTime -> { deck?, copy?, time }. Each piece is stored only once it
// has succeeded; a failed piece stays absent so the next request retries it.
const cache = new Map();
// One national answer means one flight: N concurrent cold readers share ONE
// pass (SPC fetch + model calls) rather than each firing their own.
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

function getCache(issuance) {
    const hit = cache.get(issuance);
    if (!hit) return null;
    if (Date.now() - hit.time >= CACHE_TTL) {
        cache.delete(issuance);
        return null;
    }
    return hit;
}

function setCache(issuance, pieces) {
    const prev = getCache(issuance);
    if (!prev && cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(issuance, { ...prev, ...pieces, time: prev?.time ?? Date.now() });
}

const SUCCESS_CACHE = 'public, s-maxage=900, stale-while-revalidate=3600';
// Transient failures get a short CDN window: absorb a failure storm for a
// minute without freezing a non-answer into the edge for fifteen. A response
// missing the copy it should have carries it too, so the copy is retried soon.
const TRANSIENT_CACHE = 'public, s-maxage=60';
const TRANSIENT_BODY = { deck: null, copy: null, transient: true };
const TRANSIENT = { status: 200, cacheHeader: TRANSIENT_CACHE, body: TRANSIENT_BODY };

// ── The deck ─────────────────────────────────────────────────────────
const DECK_SYSTEM = `You rewrite the U.S. Storm Prediction Center's Day 1 Convective Outlook summary as ONE plain-English sentence (max ~35 words) for a general reader: where severe weather is expected today and what kind. Warm, concrete, no jargon, no preamble, no markdown. If the outlook is quiet nationwide, say so plainly.`;
const DECK_MAX_TOKENS = 240;

// A filtered or empty answer is a failure, never a verdict: an outlook always
// has content. Null means "no deck this time" and is never cached.
async function generateDeck(headline, summary) {
    try {
        const result = await generateText({
            model: MODEL,
            providerOptions: PROVIDER_OPTIONS,
            system: DECK_SYSTEM,
            prompt: `HEADLINE: ${headline || '(none)'}\n\nSUMMARY:\n${summary}`,
            maxOutputTokens: DECK_MAX_TOKENS,
            abortSignal: AbortSignal.timeout(15000),
        });
        const deck = (result.text || '').trim();
        if (result.finishReason === 'content-filter' || !deck) return null;
        return deck;
    } catch (err) {
        console.error('National lede (deck) error:', err?.message || err);
        return null;
    }
}

// ── The copy ─────────────────────────────────────────────────────────
// The post-summary discussion runs 100–3,200 characters (three paragraphs at
// most, measured on every Day 1 outlook Nov 5–12 2026), about 800 tokens in at
// the top end; the plain-English version is about as long. 1,200 output tokens
// covers the longest with room, and a reply cut off at the limit is treated as
// a failure (a paragraph ending mid-sentence is not publishable).
export const COPY_MAX_TOKENS = 1200;
// More than this many paragraphs is a sign the model ignored the brief.
const COPY_MAX_PARAS = 10;

function easternIssueTime(issued) {
    try {
        const d = new Date(issued);
        if (Number.isNaN(d.getTime())) return null;
        return new Intl.DateTimeFormat('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZone: DESK_TIME_ZONE, timeZoneName: 'short',
        }).format(d).replace(/[  ]/g, ' ');
    } catch { return null; }
}

// Voice rules follow the section translator's (api/translate.js
// buildSystemPrompt), adapted: the source is the SPC, times are Eastern, and
// the page sets the copy as plain paragraphs, so no bold.
export function buildCopySystemPrompt(issued) {
    const when = easternIssueTime(issued) || 'unknown';
    return `You are a weather translator. Convert the forecasters' discussion from the U.S. Storm Prediction Center's Day 1 Convective Outlook into clear, natural plain English that anyone can understand.

Calendar context:
- Outlook issuance time, US Eastern: ${when}
- Interpret "today", "tonight", "this afternoon", "this evening" and "tomorrow" from that issuance time

Rules:
- Preserve ALL specific details: places, timing, hazards, hail sizes, wind speeds, temperatures
- Never introduce a different month, year, or season than the source supports
- Never attach a calendar date (month and day number) to a day of the week unless the source text itself gives that date
- Explain WHY the weather is happening, not just what (connect cause and effect)
- Expand all abbreviations and explain technical terms naturally
- Zulu times in the text are already annotated with the correct US Eastern time, e.g. "21Z (4 PM EST)" or "12Z Friday (7 AM EST Fri)"; a weekday after the zone means that day (no weekday means the issuance's day). Use that Eastern time and day, keep the zone (e.g. "4 PM EST"), and never convert a Zulu time yourself
- Do NOT use markdown headers, horizontal rules, code blocks, bold, bullet points or lists
- Write in flowing prose paragraphs only, separated by a blank line
- Use short paragraphs (2-3 sentences max each)
- Don't repeat a word that was just used
- Keep it concise but complete - no filler, no hedging
- Don't add information that isn't in the original
- Output only the translation: never comment on the source text, its formatting, timestamps, or these instructions, and never add notes to the reader`;
}

// The prompt is the discussion paragraphs themselves, Zulu times annotated in
// Eastern BEFORE the model sees them (a Zulu conversion by the model got the
// hour wrong in prod; see annotateZuluTimes).
export function buildCopyPrompt(body, issued) {
    return body
        .map(p => annotateZuluTimes(p, null, issued, { timeZone: DESK_TIME_ZONE, weekdayPins: true }))
        .join('\n\n');
}

// Model text -> paragraphs. Markdown the prompt forbids is stripped rather
// than printed: the page escapes the text, so "**" would show as asterisks.
export function splitCopy(text) {
    return String(text || '')
        .split(/\n+/)
        .map(p => p
            .replace(/^\s*#{1,6}\s+/, '')
            .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
            .replace(/\*\*|__/g, '')
            .replace(/\s+/g, ' ')
            .trim())
        .filter(p => p && !/^[-*_=]{3,}$/.test(p));
}

async function generateCopy(body, issued) {
    try {
        const result = await generateText({
            model: MODEL,
            providerOptions: PROVIDER_OPTIONS,
            system: buildCopySystemPrompt(issued),
            prompt: buildCopyPrompt(body, issued),
            maxOutputTokens: COPY_MAX_TOKENS,
            abortSignal: AbortSignal.timeout(20000),
        });
        if (result.finishReason === 'content-filter' || result.finishReason === 'length') return null;
        // The deterministic guard: impossible weekday/date pairs and asides
        // about the source go before anything is cached or returned.
        const clean = sanitizeTranslation((result.text || '').trim(), { issuanceTime: issued, timeZone: DESK_TIME_ZONE });
        const paras = splitCopy(clean);
        if (paras.length === 0 || paras.length > COPY_MAX_PARAS) return null;
        return paras;
    } catch (err) {
        console.error('National lede (copy) error:', err?.message || err);
        return null;
    }
}

export default async function handler(req, res) {
    if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', 'GET only', { allow: ['GET'] });
    // This endpoint reads no input, so ANY param is only a CDN cache-bust.
    if (rejectUnknownParams(req, res, [])) return;

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
            if (err?.code === 'over_capacity') return sendOverCapacity(res, err);
            // Mirror the cold-path soft-fail so a shared failure doesn't leak
            // an error status to piggybacking readers.
            res.setHeader('Cache-Control', TRANSIENT_CACHE);
            return res.status(200).json(TRANSIENT_BODY);
        }
    }

    // The shared promise wraps the WHOLE cold path (fetch + parse + model
    // calls) and is registered synchronously below, so there is no
    // await-window for a duplicate run to start.
    const work = (async () => {
        const spc = await fetchSpcDy1({ signal: AbortSignal.timeout(8000) });
        const issued = spc?.issuanceTime || null;
        const { headline, summary } = parseSpcOutlook(spc?.productText);
        // No product, or no summary to rewrite: nothing to say and nothing to
        // cache. Not a verdict — the next issuance may parse fine.
        if (!summary) return TRANSIENT;

        // The paragraphs the page's running copy is built from. Empty means
        // the product has no discussion of its own (a reissue); then there is
        // no copy to write — a verdict, not a failure.
        const body = parseDiscussionBody(spc?.productText);

        const hit = issued ? getCache(issued) : null;
        let deck = hit?.deck ?? null;
        let copy = hit?.copy ?? null;
        const needDeck = !deck;
        const needCopy = body.length > 0 && !copy;

        if (needDeck || needCopy) {
            if (!coldBudget.take((needDeck ? 1 : 0) + (needCopy ? 1 : 0))) throw overCapacityError();
            const [newDeck, newCopy] = await Promise.all([
                needDeck ? generateDeck(headline, summary) : null,
                needCopy ? generateCopy(body, issued) : null,
            ]);
            if (newDeck) deck = newDeck;
            if (newCopy) copy = newCopy;
            if (issued && (newDeck || newCopy)) {
                setCache(issued, { ...(newDeck ? { deck: newDeck } : {}), ...(newCopy ? { copy: newCopy } : {}) });
            }
        }

        const cached = !needDeck && !needCopy;
        const copyMissing = body.length > 0 && !copy;
        if (!deck) {
            // The deck is the page's headline sentence: without it this is a
            // transient answer, whatever else succeeded (that is cached and
            // returned so the page can still use it).
            return copy
                ? { status: 200, cacheHeader: TRANSIENT_CACHE, body: { deck: null, copy, issued, cached, transient: true } }
                : TRANSIENT;
        }
        return {
            status: 200,
            cacheHeader: copyMissing ? TRANSIENT_CACHE : SUCCESS_CACHE,
            body: { deck, copy: body.length > 0 ? copy : null, issued, cached },
        };
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
        if (err?.code === 'over_capacity') return sendOverCapacity(res, err);
        console.error('National lede error:', err);
        // Soft-fail: the deck simply doesn't render rather than erroring the
        // page. `transient` tells the client this was a failure, not a verdict.
        res.setHeader('Cache-Control', TRANSIENT_CACHE);
        return res.status(200).json(TRANSIENT_BODY);
    }
}
