// Vercel serverless function: AI translation of AFD sections via Claude Haiku
// Uses AI Gateway for model routing, failover, and cost tracking

import { createHash } from 'node:crypto';
import { generateText } from 'ai';
import { OFFICE_TIMEZONES, SECTION_NAMES } from '../docs/js/offices.js';
import { fetchAFDList, fetchAFDProduct, productUrlFromItem } from './_utils.js';
import { sendError } from './_errors.js';

// Translation cache: keyed on sha256(whitespace-normalized text + canonical
// section + office), 4-hour TTL
// Fluid Compute shares instances across concurrent requests, so this persists.
// The key deliberately EXCLUDES client-supplied issuanceTime and uses a bucketed
// section label: any client-varied key component is a cache-bust lever where each
// variant of otherwise-identical text forces a fresh billable AI call.
const translationCache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours (NWS issues AFDs ~3-4x daily)
const CACHE_MAX = 500; // max entries to prevent unbounded growth

function cacheKey(text, sectionKey, office) {
    // Whitespace-normalized so reflowing a real section can't bust the cache;
    // a cryptographic hash so no crafted text can collide with a real entry.
    return createHash('sha256')
        .update(`${normalizeForMatch(text)}|${sectionKey}|${office}`)
        .digest('base64url');
}

// Bucket a free-text section label into a bounded set of canonical keys for
// caching. The prompt gets the canonical label too (promptSectionLabel), never
// the raw one: the raw label isn't in the cache key, so letting it steer the
// output would let one caller poison the entry every reader shares.
const DISPLAY_SECTIONS = new Map(
    Object.values(SECTION_NAMES).map(v => [v.toUpperCase(), v])
);
export function canonicalSectionKey(label) {
    if (typeof label !== 'string' || !label.trim()) return 'OTHER';
    let u = label.toUpperCase()
        .replace(/\s*\([^)]*\)\s*$/, '')   // trailing (TDY-TUE) qualifiers
        .replace(/\s*\/[^/]*\/\s*$/, '')   // trailing /THROUGH TONIGHT/ qualifiers
        .replace(/\s+/g, ' ')
        .trim();
    if (DISPLAY_SECTIONS.has(u)) return DISPLAY_SECTIONS.get(u);
    if (SECTION_NAMES[u]) return SECTION_NAMES[u];
    for (const [k, v] of Object.entries(SECTION_NAMES)) {
        if (u.startsWith(k)) return v;
    }
    return 'OTHER';
}

// The section name the prompt sees: the canonical display name, or null
// (→ "Unknown") for labels that bucket to OTHER.
export function promptSectionLabel(sectionKey) {
    return sectionKey && sectionKey !== 'OTHER' ? sectionKey : null;
}

function getCachedTranslation(text, sectionKey, office) {
    const key = cacheKey(text, sectionKey, office);
    const entry = translationCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.time > CACHE_TTL) {
        translationCache.delete(key);
        return null;
    }
    // LRU touch: move to end of Map iteration order
    translationCache.delete(key);
    translationCache.set(key, entry);
    return entry.translation;
}

function setCachedTranslation(text, sectionKey, office, translation) {
    // Evict oldest entries if at capacity
    if (translationCache.size >= CACHE_MAX) {
        const oldest = translationCache.keys().next().value;
        translationCache.delete(oldest);
    }
    const key = cacheKey(text, sectionKey, office);
    translationCache.set(key, { translation, time: Date.now() });
}

// Rate limiting: per-IP sliding window (defense-in-depth alongside gateway limits)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 30;

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

// Degraded mode (NWS unreachable, so text can't be verified against an AFD):
// fail open so a real outage doesn't kill translation, but clamp every knob —
// this is the only path that will translate unverified text.
const degradedRateLimitMap = new Map();
const DEGRADED_RATE_LIMIT_MAX = 5; // per IP per minute (normal mode: 30)
// Instance-wide budget for degraded mode: during an NWS outage the endpoint
// translates UNVERIFIED text, so cap the whole instance, not just each IP —
// rotating IPs must not turn an outage into an open LLM proxy.
let degradedGlobal = { windowStart: 0, count: 0 };
const DEGRADED_GLOBAL_MAX = 30; // unverified translations per minute per instance

function checkDegradedGlobalBudget() {
    const now = Date.now();
    if (now - degradedGlobal.windowStart > RATE_LIMIT_WINDOW) {
        degradedGlobal = { windowStart: now, count: 0 };
    }
    if (degradedGlobal.count >= DEGRADED_GLOBAL_MAX) return false;
    degradedGlobal.count += 1;
    return true;
}
const DEGRADED_TEXT_MAX = 6000;    // chars (normal mode: 10000)
const DEGRADED_MAX_TOKENS = 512;   // output tokens (normal mode: 1024)

function checkDegradedRateLimit(ip) {
    const now = Date.now();
    const entry = degradedRateLimitMap.get(ip);
    if (!entry) {
        degradedRateLimitMap.set(ip, { timestamps: [now] });
        return true;
    }
    entry.timestamps = entry.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
    if (entry.timestamps.length >= DEGRADED_RATE_LIMIT_MAX) return false;
    entry.timestamps.push(now);
    return true;
}

// Periodically clean up stale rate limit entries without pinning the event loop
const rateLimitCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const map of [rateLimitMap, degradedRateLimitMap]) {
        for (const [ip, entry] of map) {
            entry.timestamps = entry.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
            if (entry.timestamps.length === 0) map.delete(ip);
        }
        if (map.size > 10_000) map.clear();
    }
}, 5 * 60 * 1000);
rateLimitCleanupTimer.unref?.();

// ── AFD-source verification ──────────────────────────────────────────
// Only translate text that actually appears in the office's recent AFD, so the
// public endpoint can't be used to translate arbitrary (billable) text.
// An AFD is identical for everyone for hours, so this is cached per office.
const afdTextCache = new Map(); // office -> { products: [{norm, issuanceTime}], time }
const AFD_TEXT_TTL = 10 * 60 * 1000; // 10 min

// Case-sensitive on purpose: the cache key is built from this same
// normalization, so any variation it tolerates is variation that can't be a
// cache-bust lever.
function normalizeForMatch(s) {
    return String(s).replace(/\$\$|&&/g, ' ').replace(/\s+/g, ' ').trim();
}

// True when `text` is a contiguous chunk of the normalized product text.
// parseSections() output is always a contiguous slice of productText (headers,
// $$/&& markers and the forecaster tail are removed), so this does not reject
// legitimate section text — measured Sep 25 2026: 722/722 sections across all
// 68 offices' two latest AFDs matched exactly. There is deliberately no
// head+tail fallback: it let arbitrary text through between a real first and
// last 160 characters.
export function textMatchesAFD(text, normalizedProductTexts) {
    const n = normalizeForMatch(text);
    if (n.length < 20) return false;
    return normalizedProductTexts.some(p => p.includes(n));
}

// The matched product (not just a boolean) — its issuanceTime is the trusted,
// server-derived calendar context for the prompt.
export function findMatchingAFD(text, products) {
    for (const prod of products) {
        if (textMatchesAFD(text, [prod.norm])) return prod;
    }
    return null;
}

async function getOfficeAFDProducts(office) {
    const entry = afdTextCache.get(office);
    if (entry && Date.now() - entry.time < AFD_TEXT_TTL) return entry.products;
    // Cover the last few issuances so history-browsing still verifies.
    const items = (await fetchAFDList(office, { signal: AbortSignal.timeout(8000) })).slice(0, 4);
    const settled = await Promise.all(items.map(async (item) => {
        try {
            const url = productUrlFromItem(item);
            if (!url) return null;
            const prod = await fetchAFDProduct(url, { signal: AbortSignal.timeout(8000) });
            if (typeof prod?.productText !== 'string') return null;
            return {
                norm: normalizeForMatch(prod.productText),
                issuanceTime: typeof prod.issuanceTime === 'string' ? prod.issuanceTime : null,
            };
        } catch { return null; }
    }));
    const products = settled.filter(Boolean);
    if (products.length) afdTextCache.set(office, { products, time: Date.now() });
    return products;
}

function ordinal(day) {
    const mod100 = day % 100;
    if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
    const mod10 = day % 10;
    if (mod10 === 1) return `${day}st`;
    if (mod10 === 2) return `${day}nd`;
    if (mod10 === 3) return `${day}rd`;
    return `${day}th`;
}

function getSafeIssueDate(issuanceTime) {
    const parsed = issuanceTime ? new Date(issuanceTime) : new Date();
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function getLocalDateParts(issueDate, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    }).formatToParts(issueDate);

    return {
        year: Number(parts.find(part => part.type === 'year')?.value),
        monthName: parts.find(part => part.type === 'month')?.value || 'January',
        day: Number(parts.find(part => part.type === 'day')?.value),
    };
}

export function getTranslationCalendarContext(office, issuanceTime) {
    const timeZone = OFFICE_TIMEZONES[office] || 'America/Los_Angeles';
    const issueDate = getSafeIssueDate(issuanceTime);
    const localIssueTime = new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone,
        timeZoneName: 'short',
    }).format(issueDate);

    const { year, monthName, day } = getLocalDateParts(issueDate, timeZone);
    const monthIndex = new Date(`${monthName} 1, ${year}`).getMonth();
    const lastDayOfMonth = new Date(year, monthIndex + 1, 0).getDate();
    const nextMonthName = new Intl.DateTimeFormat('en-US', { month: 'long' })
        .format(new Date(year, monthIndex + 1, 1));

    return {
        timeZone,
        localIssueTime,
        localDateLabel: `${monthName} ${day}, ${year}`,
        monthBoundaryExample: `If the source says "${ordinal(lastDayOfMonth)} and 1st", that means ${monthName} ${lastDayOfMonth} and ${nextMonthName} 1 for this forecast.`,
    };
}

// Deterministically annotate Zulu clock times with the office's local time
// before the model sees them ("VCSH through 15Z" → "VCSH through 15Z (10 AM
// CDT)"). Haiku converting Zulu itself got it wrong in prod (LOT, Sep 25 2026:
// 15Z rendered as "3 PM"). Only 2- or 4-digit HH/HHMM + Z tokens; DDHHMMZ and
// TAF day/hour ranges are left alone. The local label is taken on the issuance
// date so DST is right for the forecast window.
export function annotateZuluTimes(text, office, issuanceTime) {
    const timeZone = OFFICE_TIMEZONES[office];
    if (!timeZone || typeof text !== 'string') return text;
    const base = getSafeIssueDate(issuanceTime);
    const fmt = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short',
    });
    return text.replace(/\b(\d{2})(\d{2})?Z\b(?!\s*\()/g, (tok, hh, mm) => {
        const h = Number(hh), m = mm === undefined ? 0 : Number(mm);
        if (h > 23 || m > 59) return tok;
        const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h, m));
        const local = fmt.format(d).replace(':00 ', ' ').replace(/ /g, ' ');
        return `${tok} (${local})`;
    });
}

export function buildSystemPrompt({ section, office, issuanceTime }) {
    const calendarContext = getTranslationCalendarContext(office, issuanceTime);

    return `You are a weather translator. Convert NWS Area Forecast Discussion text into clear, natural plain English that anyone can understand.

Calendar context:
- AFD issuance time in the local office timezone: ${calendarContext.localIssueTime}
- Office timezone: ${calendarContext.timeZone}
- Interpret relative dates from that issuance time: "today", "tonight", "tomorrow", "this weekend", "this month", and "next month"
- Resolve bare day-of-month references relative to that issuance date and forecast window
- ${calendarContext.monthBoundaryExample}
- If a day number is still genuinely ambiguous, keep the original day number instead of inventing a month

Rules:
- Preserve ALL specific details: dates, temperatures, amounts, locations, timing
- Never introduce a different month, year, or season than the source supports
- Explain WHY weather is happening, not just what (connect cause and effect)
- Bold key info using **markdown bold** only: days of week, temperatures, rainfall amounts, wind speeds, hazard terms
- Do NOT use markdown headers (##, ###), horizontal rules (---), code blocks, or bullet lists
- Write in flowing prose paragraphs only
- Expand all NWS abbreviations naturally
- Zulu times in the text are already annotated with the correct local time, e.g. "15Z (10 AM CDT)": use that local time, and never convert a Zulu time yourself
- Airport and station identifiers (e.g., DPA, ORD, MDW, KMKE): never replace one with an airport or city name unless the text itself names it; write "the DPA airport" instead
- Don't repeat a word that was just used (write "good flying conditions", never "conditions conditions")
- Keep it concise but complete - no filler, no hedging
- Use short paragraphs (2-3 sentences max each)
- If there are hazards or watches/warnings, lead with those
- Don't add information that isn't in the original
- Don't use bullet points - write in natural prose paragraphs
- Section name for context: ${section || 'Unknown'}
- NWS Office: ${office || 'Unknown'}
- Local issue date for calendar references: ${calendarContext.localDateLabel}`;
}

export default async function handler(req, res) {
    // CORS
    const allowedOrigins = ['https://plaincast.live', 'https://www.plaincast.live'];
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed', 'POST only', { allow: ['POST'] });

    // Rate limiting
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIp)) {
        return sendError(res, 429, 'rate_limited', 'Too many requests. Please try again later.');
    }

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return sendError(res, 400, 'invalid_request', 'Invalid request body');
    }

    const { text, section, office, issuanceTime } = req.body;
    const officeCode = typeof office === 'string' ? office.toUpperCase() : office;
    const hasSection = section !== undefined && section !== null && section !== '';
    const hasOffice = office !== undefined && office !== null && office !== '';
    const sectionLabel = typeof section === 'string' ? section.trim().replace(/[ \t]+/g, ' ') : section;
    if (typeof text !== 'string' || text.length < 20) return sendError(res, 400, 'invalid_request', 'Text too short');
    if (text.length > 10000) return sendError(res, 400, 'invalid_request', 'Text too long');

    // Validate section and office to prevent prompt injection via system prompt
    if (hasSection && (typeof section !== 'string' || !sectionLabel || sectionLabel.length > 100 || /[\r\n\u0000-\u001F\u007F]/.test(section))) {
        return sendError(res, 400, 'invalid_request', 'Invalid section');
    }
    if (hasOffice && (typeof office !== 'string' || !OFFICE_TIMEZONES[officeCode])) {
        return sendError(res, 400, 'invalid_office', 'Invalid office');
    }
    // Office is required — it's the key for AFD-source verification below.
    if (!hasOffice) {
        return sendError(res, 400, 'invalid_office', 'Office required');
    }
    if (issuanceTime !== undefined && (typeof issuanceTime !== 'string' || issuanceTime.length > 50)) {
        return sendError(res, 400, 'invalid_request', 'Invalid issuanceTime');
    }

    // Check translation cache first
    const sectionKey = canonicalSectionKey(sectionLabel);
    const cached = getCachedTranslation(text, sectionKey, officeCode);
    if (cached) {
        return res.status(200).json({ translation: cached, cached: true });
    }

    // Anti-abuse: only translate text that appears in this office's recent AFD.
    // Fail open if NWS is unreachable so a real outage doesn't kill translation,
    // but clamp rate/size/output in that unverified (degraded) mode.
    let afdProducts = [];
    try { afdProducts = await getOfficeAFDProducts(officeCode); } catch { afdProducts = []; }
    const degraded = afdProducts.length === 0;
    let matchedProduct = null;
    if (!degraded) {
        matchedProduct = findMatchingAFD(text, afdProducts);
        if (!matchedProduct) {
            return sendError(res, 403, 'forbidden', 'Text does not match a current forecast');
        }
    } else {
        console.warn(`[translate] degraded mode (AFD source unavailable): office=${officeCode}`);
        if (!checkDegradedRateLimit(clientIp) || !checkDegradedGlobalBudget()) {
            return res.status(429).json({ error: 'Too many requests. Please try again later.' });
        }
        if (text.length > DEGRADED_TEXT_MAX) {
            return res.status(400).json({ error: 'Text too long' });
        }
    }

    // Calendar context: trust the matched product's issuance time over the
    // client's claim; the client value is only a hint when NWS is unreachable.
    const promptIssuanceTime = matchedProduct?.issuanceTime || issuanceTime;
    const systemPrompt = buildSystemPrompt({ section: promptSectionLabel(sectionKey), office: officeCode, issuanceTime: promptIssuanceTime });

    try {
        const result = await generateText({
            model: 'anthropic/claude-haiku-4.5',
            system: systemPrompt,
            prompt: annotateZuluTimes(text, officeCode, promptIssuanceTime),
            maxOutputTokens: degraded ? DEGRADED_MAX_TOKENS : 1024,
            abortSignal: AbortSignal.timeout(15000),
        });

        const translation = result.text || '';

        // Check for model refusal (safety filter triggered) before empty-text guard,
        // since filter refusals typically come back with empty or stubbed text.
        if (result.finishReason === 'content-filter') {
            return res.status(503).json({ error: 'Translation skipped for this section', reason: 'content-filter' });
        }

        if (!translation) {
            return res.status(502).json({ error: 'Empty translation' });
        }

        // Cache successful translation for future requests
        setCachedTranslation(text, sectionKey, officeCode, translation);

        return res.status(200).json({ translation, cached: false });
    } catch (err) {
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
            return res.status(504).json({ error: 'Translation timed out' });
        }
        console.error('Translation error:', err);
        return res.status(500).json({ error: 'Internal error' });
    }
}
