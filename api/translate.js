// Vercel serverless function: AI translation of AFD sections via Claude Haiku
// Uses AI Gateway for model routing, failover, and cost tracking

import { generateText } from 'ai';
import { OFFICE_TIMEZONES, SECTION_NAMES } from '../docs/js/offices.js';
import { fetchAFDList, fetchAFDProduct, productUrlFromItem } from './_utils.js';

// Translation cache: keyed on hash(text + canonical section + office), 4-hour TTL
// Fluid Compute shares instances across concurrent requests, so this persists.
// The key deliberately EXCLUDES client-supplied issuanceTime and uses a bucketed
// section label: any client-varied key component is a cache-bust lever where each
// variant of otherwise-identical text forces a fresh billable AI call.
const translationCache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours (NWS issues AFDs ~3-4x daily)
const CACHE_MAX = 500; // max entries to prevent unbounded growth

function cacheKey(text, sectionKey, office) {
    let hash = 0;
    const str = `${text}|${sectionKey}|${office}`;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return hash.toString(36);
}

// Bucket a free-text section label into a bounded set of canonical keys for
// caching. The raw label still feeds the prompt (legitimate context); this only
// bounds how many cache entries one text can occupy.
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

function normalizeForMatch(s) {
    return String(s).toLowerCase().replace(/\$\$|&&/g, ' ').replace(/\s+/g, ' ').trim();
}

// True when `text` is a contiguous chunk of the normalized product text.
// parseSections() output is always a contiguous slice of productText (headers,
// $$/&& markers and the forecaster tail are removed), so this does not reject
// legitimate section text. The head+tail fallback tolerates rare edge trims.
export function textMatchesAFD(text, normalizedProductTexts) {
    const n = normalizeForMatch(text);
    if (n.length < 20) return false;
    return normalizedProductTexts.some(p =>
        p.includes(n)
        || (n.length > 160 && p.includes(n.slice(0, 160)) && p.includes(n.slice(-160)))
    );
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
- Convert Zulu times to context (e.g., "early morning", "Tuesday afternoon")
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
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    // Rate limiting
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIp)) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({ error: 'Invalid request body' });
    }

    const { text, section, office, issuanceTime } = req.body;
    const officeCode = typeof office === 'string' ? office.toUpperCase() : office;
    const hasSection = section !== undefined && section !== null && section !== '';
    const hasOffice = office !== undefined && office !== null && office !== '';
    const sectionLabel = typeof section === 'string' ? section.trim().replace(/[ \t]+/g, ' ') : section;
    if (typeof text !== 'string' || text.length < 20) return res.status(400).json({ error: 'Text too short' });
    if (text.length > 10000) return res.status(400).json({ error: 'Text too long' });

    // Validate section and office to prevent prompt injection via system prompt
    if (hasSection && (typeof section !== 'string' || !sectionLabel || sectionLabel.length > 100 || /[\r\n\u0000-\u001F\u007F]/.test(section))) {
        return res.status(400).json({ error: 'Invalid section' });
    }
    if (hasOffice && (typeof office !== 'string' || !OFFICE_TIMEZONES[officeCode])) {
        return res.status(400).json({ error: 'Invalid office' });
    }
    // Office is required — it's the key for AFD-source verification below.
    if (!hasOffice) {
        return res.status(400).json({ error: 'Office required' });
    }
    if (issuanceTime !== undefined && (typeof issuanceTime !== 'string' || issuanceTime.length > 50)) {
        return res.status(400).json({ error: 'Invalid issuanceTime' });
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
            return res.status(403).json({ error: 'Text does not match a current forecast' });
        }
    } else {
        console.warn(`[translate] degraded mode (AFD source unavailable): office=${officeCode}`);
        if (!checkDegradedRateLimit(clientIp)) {
            return res.status(429).json({ error: 'Too many requests. Please try again later.' });
        }
        if (text.length > DEGRADED_TEXT_MAX) {
            return res.status(400).json({ error: 'Text too long' });
        }
    }

    // Calendar context: trust the matched product's issuance time over the
    // client's claim; the client value is only a hint when NWS is unreachable.
    const promptIssuanceTime = matchedProduct?.issuanceTime || issuanceTime;
    const systemPrompt = buildSystemPrompt({ section: sectionLabel, office: officeCode, issuanceTime: promptIssuanceTime });

    try {
        const result = await generateText({
            model: 'anthropic/claude-haiku-4.5',
            system: systemPrompt,
            prompt: text,
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
