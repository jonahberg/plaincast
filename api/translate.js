// Vercel serverless function: AI translation of AFD sections via Claude Haiku
// Uses AI Gateway for model routing, failover, and cost tracking

import { createHash } from 'node:crypto';
import { generateText } from 'ai';
import { OFFICE_TIMEZONES, SECTION_NAMES } from '../docs/js/offices.js';
import { fetchAFDList, fetchAFDProduct, productUrlFromItem } from './_utils.js';
import { sendError } from './_errors.js';
import { extractSections } from './_afd-sections.js';
import { MODEL, PROVIDER_OPTIONS } from './_model.js';
// The client parser, imported so verification matches what browsers send.
// Pure module (relative imports only); shadcn/package.json is type:module.
import { parseSections } from '../shadcn/src/lib/afd.js';

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
const DEGRADED_MAX_TOKENS = 1024;  // output tokens (normal mode: 2048)

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
const afdTextCache = new Map(); // office -> { products: [{sections, issuanceTime}], time }
const AFD_TEXT_TTL = 10 * 60 * 1000; // 10 min

// Case-sensitive on purpose: the cache key is built from this same
// normalization, so any variation it tolerates is variation that can't be a
// cache-bust lever.
function normalizeForMatch(s) {
    return String(s).replace(/\$\$|&&/g, ' ').replace(/\s+/g, ' ').trim();
}

// Exact-section verification (Sep 28 2026 audit). The old check accepted any
// 20+ char contiguous slice of a recent product, so every distinct slice (and
// every one of ~12 section labels) was a fresh billed model call. Now the text
// must EQUAL — after whitespace normalisation — one whole section body, and
// the section label comes from the matched section, never the client.
//
// The index is built with the CLIENT parser first (shadcn/src/lib/afd.js
// parseSections: exactly what the React app POSTs — it also strips forecaster
// signatures, which extractSections does not), then the server parser, so a
// section either parser produces verifies. Measured against the live latest
// AFD of all 68 offices: see tests/translate-section-parity.test.js.
const UNTRANSLATED_SECTIONS = new Set(['Active Alerts']);

export function buildSectionIndex(productText) {
    const index = new Map(); // normalized section text -> canonical section key
    const add = (key, text) => {
        const sectionKey = canonicalSectionKey(key);
        if (UNTRANSLATED_SECTIONS.has(sectionKey)) return;
        const n = normalizeForMatch(text);
        if (n.length < 20 || index.has(n)) return;
        index.set(n, sectionKey);
    };
    if (typeof productText !== 'string' || !productText) return index;
    try {
        for (const s of parseSections(productText).sections) add(s.key, s.text);
    } catch { /* fall through to the server parser */ }
    for (const s of extractSections(productText)) add(s.key, s.text);
    return index;
}

// The matched product AND section — the product's issuanceTime is the
// trusted calendar context; the section key is the trusted label.
export function findMatchingSection(text, products) {
    const n = normalizeForMatch(text);
    if (n.length < 20) return null;
    for (const product of products) {
        const sectionKey = product.sections?.get(n);
        if (sectionKey) return { product, sectionKey };
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
                sections: buildSectionIndex(prod.productText),
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
// 15Z rendered as "3 PM").
//
// Forms (Sep 28 2026 audit; upper- or lowercase z): HZ / HHZ / HHMMZ, ranges H-HZ / HH-HHZ /
// HHMM-HHMMZ (both ends annotated: "6-9Z (1-4 AM CDT Tue)"), and a DD/ day
// prefix ("29/12Z", "29/12-18Z") that pins the UTC day. DDHHMMZ stamps, 3-digit
// tokens, TAF DDHH/DDHH ranges and wind/visibility/flight-level groups
// (27015G25KT, P6SM, FL250 — no trailing Z, or glued to letters) never match.
//
// The instant is the FIRST occurrence of that UTC clock time at-or-after the
// issuance (not on the issuance's UTC date), so an afternoon "00Z" is this
// evening and DST/day rollover come out right. One exception, measured on the
// 68 live AFDs of Sep 28 2026: tokens up to 1 h BEFORE issuance were all past
// references ("12Z TAFS", "until 11Z" in a 1150Z product — the aviation text
// is written before the AFD goes out), while those 1-6 h before were mostly
// future ("06-08Z tonight"). So the search starts 1 h before issuance. When
// the local calendar date differs from the issuance's, the weekday is added
// ("00Z (7 PM CDT Mon)"). A range end is the first occurrence at-or-after its
// start ("20-06Z" crosses midnight). A TAF cycle label names the current or
// next cycle, which may sit hours either side of issuance ("(12Z TAF
// Issuance)" in a 1357Z product; "/00Z TAFS/" in a 2030Z one), so it resolves
// to the NEAREST occurrence instead.
const ZULU_RE = /(?<![\w.])(?:(\d{1,2})\/)?(\d{4}|\d{1,2})(?:[-\u2013](\d{4}|\d{1,2}))?Z\b(?!\s*\()/gi;
const ZULU_LOOKBACK_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseZuluClock(tok) {
    const h = Number(tok.length === 4 ? tok.slice(0, 2) : tok);
    const m = tok.length === 4 ? Number(tok.slice(2)) : 0;
    return h > 23 || m > 59 ? null : { h, m };
}

function localParts(date, timeZone) {
    const parts = {};
    for (const p of new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
        hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
    }).formatToParts(date)) parts[p.type] = p.value;
    return {
        clock: parts.minute === '00' ? parts.hour : `${parts.hour}:${parts.minute}`,
        ampm: (parts.dayPeriod || '').toUpperCase(),
        tz: parts.timeZoneName,
        weekday: parts.weekday,
        dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    };
}

// Opt-in options (no existing caller passes them, so office callers behave
// exactly as before):
//   timeZone     an explicit IANA zone instead of the office's (the National
//                Desk is national, so it annotates in America/New_York).
//   weekdayPins  a weekday written right after the token ("by 12Z Friday",
//                SPC's habit) pins its UTC day, the way a DD/ prefix does.
//                Without it, "12Z Friday" in a Thursday-night product is
//                annotated as Thursday morning. The annotation then follows
//                the weekday and always names the local day:
//                "12Z Friday (7 AM EST Fri)", "00Z Friday (7 PM EST Thu)".
const ZULU_WEEKDAY = 'Sun(?:day)?|Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?';
// The trailing lookaheads keep an already-annotated "12Z Friday (...)" whole.
const ZULU_WEEKDAY_RE = new RegExp(
    `(?<![\\w.])(?:(\\d{1,2})\\/)?(\\d{4}|\\d{1,2})(?:[-\\u2013](\\d{4}|\\d{1,2}))?Z\\b`
    + `(?:[ \\t]+(${ZULU_WEEKDAY})\\b(?!\\s*\\())?(?!\\s*\\()(?![ \\t]+(?:${ZULU_WEEKDAY})\\b\\s*\\()`, 'gi');
const WEEKDAY_PREFIX = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function annotateZuluTimes(text, office, issuanceTime, { timeZone: zoneOverride, weekdayPins = false } = {}) {
    const timeZone = zoneOverride || OFFICE_TIMEZONES[office];
    if (!timeZone || typeof text !== 'string') return text;
    const base = getSafeIssueDate(issuanceTime);
    const issueDateKey = localParts(base, timeZone).dateKey;
    const y = base.getUTCFullYear(), mo = base.getUTCMonth(), d0 = base.getUTCDate();

    const firstAtOrAfter = ({ h, m }, notBefore) => {
        let t = Date.UTC(y, mo, d0, h, m) - DAY_MS;
        while (t < notBefore) t += DAY_MS;
        return t;
    };
    const nearest = ({ h, m }) => {
        const b = base.getTime();
        return [-1, 0, 1].map(off => Date.UTC(y, mo, d0 + off, h, m))
            .reduce((best, t) => (Math.abs(t - b) < Math.abs(best - b) ? t : best));
    };
    const onDayOfMonth = ({ h, m }, dom) => {
        // The nearest UTC date with that day-of-month (a DD/ prefix names it).
        for (const off of [0, 1, -1, 2, -2, 3, -3, 4, 5, 6, 7, 8, 9, 10]) {
            const t = Date.UTC(y, mo, d0 + off, h, m);
            if (new Date(t).getUTCDate() === dom) return t;
        }
        return null;
    };
    // The first UTC instant at that clock time on the named UTC weekday, from
    // the same 1 h lookback as an unpinned token.
    const onWeekday = ({ h, m }, wd) => {
        let t = firstAtOrAfter({ h, m }, base.getTime() - ZULU_LOOKBACK_MS);
        for (let i = 0; i < 7 && new Date(t).getUTCDay() !== wd; i++) t += DAY_MS;
        return t;
    };
    const label = (p, withDay = true) => `${p.clock} ${p.ampm} ${p.tz}`
        + (withDay && p.dateKey !== issueDateKey ? ` ${p.weekday}` : '');

    const re = weekdayPins ? ZULU_WEEKDAY_RE : ZULU_RE;
    return text.replace(re, (tok, dd, t1, t2, ...rest) => {
        // ZULU_WEEKDAY_RE has one more capture group (the weekday) than ZULU_RE.
        const [wdName, offset, whole] = weekdayPins ? rest : [undefined, ...rest];
        const c1 = parseZuluClock(t1);
        const c2 = t2 === undefined ? null : parseZuluClock(t2);
        if (!c1 || (t2 !== undefined && !c2)) return tok;
        const dom = dd === undefined ? null : Number(dd);
        if (dom !== null && (dom < 1 || dom > 31)) return tok;
        const wd = wdName === undefined ? -1 : WEEKDAY_PREFIX.indexOf(wdName.slice(0, 3).toLowerCase());
        const pinned = wd !== -1 && dom === null;
        const tafLabel = /^\s*TAFS?\b/i.test(whole.slice(offset + tok.length));
        const start = (dom !== null ? onDayOfMonth(c1, dom) : null)
            ?? (pinned ? onWeekday(c1, wd) : null)
            ?? (tafLabel ? nearest(c1) : firstAtOrAfter(c1, base.getTime() - ZULU_LOOKBACK_MS));
        const p1 = localParts(new Date(start), timeZone);
        if (!c2) return `${tok} (${pinned ? `${p1.clock} ${p1.ampm} ${p1.tz} ${p1.weekday}` : label(p1)})`;
        const p2 = localParts(new Date(firstAtOrAfter(c2, start)), timeZone);
        let local;
        if (p1.tz === p2.tz && p1.dateKey === p2.dateKey) {
            const span = p1.ampm === p2.ampm
                ? `${p1.clock}-${p2.clock} ${p1.ampm}`
                : `${p1.clock} ${p1.ampm}-${p2.clock} ${p2.ampm}`;
            local = `${span} ${p1.tz}` + (pinned || p1.dateKey !== issueDateKey ? ` ${p1.weekday}` : '');
        } else {
            local = `${label(p1)}-${label(p2)}`;
        }
        return `${tok} (${local})`;
    });
}

// Forecaster header stamp at the top of a section: "11/220 PM." = day 11,
// 2:20 PM (LOX writes one after every header; "03/428 PM.", "11/459 PM.").
// The model read "11/22" out of it as a date (LOX Long Term, Nov 11 2026:
// "Sunday, November 22"; that Sunday was Nov 15), so it leaves the PROMPT
// only. The cache key and AFD verification keep the exact section text, which
// is parity-locked to the client parser. Same shape as the lede stripper in
// _afd-sections.js sectionProse, but AM/PM is required: a Zulu stamp
// ("12/0454Z.") already gets a correct local time from annotateZuluTimes.
// Anchored to the start of the text (no m flag): a mid-text "11/220" stays.
const HEADER_STAMP_RE = /^\s*(?:\d{1,2}\/\d{3,4}\s*(?:AM|PM)\b\.?\s*)+/i;

export function stripHeaderStamp(text) {
    if (typeof text !== 'string') return text;
    const out = text.replace(HEADER_STAMP_RE, '');
    return out.trim() ? out : text;
}

// ── Output guard ─────────────────────────────────────────────────────
// Deterministic check on model output, applied before caching in both AI
// endpoints. LOX, Nov 11 2026: "Sunday, November 22 should be..." and "Note
// that the source text reads ..." both reached readers. Returns the input
// string unchanged unless an invalid date pair or an aside matched.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_INDEX = {
    January: 0, Jan: 0, February: 1, Feb: 1, March: 2, Mar: 2, April: 3, Apr: 3,
    May: 4, June: 5, Jun: 5, July: 6, Jul: 6, August: 7, Aug: 7,
    September: 8, Sept: 8, Sep: 8, October: 9, Oct: 9, November: 10, Nov: 10,
    December: 11, Dec: 11,
};
const MONTH_ALT = Object.keys(MONTH_INDEX).sort((a, b) => b.length - a.length).join('|');
const WEEKDAY_ALT = WEEKDAYS.join('|');
const DAY_NUM = '(?:[12]\\d|3[01]|0?[1-9])';
const ORDINAL = '(?:st|nd|rd|th)?';
const YEAR_TAIL = '(?:,?\\s+20\\d{2}\\b)?';
const BOLD = '(?:\\*\\*)?';
// The first date: "November 22", "Nov. 22nd", "November 22, 2026".
const FIRST_DATE = `${BOLD}(?:${MONTH_ALT})\\.?\\s+\\d{1,2}${ORDINAL}\\b${YEAR_TAIL}${BOLD}`;
// A later day of a range or list: "19", "December 1", "**20**".
const MORE_DAY = `${BOLD}(?:(?:${MONTH_ALT})\\.?\\s+)?${DAY_NUM}${ORDINAL}`;
// Two kinds of link between days. A dash or slash touching both numbers
// ("19–20", "19-20", "19/20") is range syntax: the day after it only has to
// be a day, not a quantity or a time (DAY_END).
const TIGHT_LINK = '[–/-]';
// A word ("and", "through", "to", "or"), an em dash or a spaced dash ("19 –
// 20", "19 — 2 rounds of storms") is ordinary prose too, so the day after it
// counts only where the clause ends or goes on as it would after a date
// (CLAUSE_END). "and 24 hours", "— 2 rounds" and "to 25 mph" stay prose.
const LOOSE_LINK = '(?:,?[ \\t]+(?:and|or|through|thru|to|into|until|till|&)[ \\t]+|[ \\t]*—[ \\t]*|[ \\t]+[–-][ \\t]*|[ \\t]*[–-][ \\t]+)';
// After a tight link: not a letter or clock time ("10:30"), not a compound
// ("24-hour"), not a unit or count ("25 mph", "2 inches", "6 hours") and not
// a second number ("1-2 inches"). Those make the number a quantity or a time,
// and the expression stops at the first date as it always has.
const DAY_END = '(?!\\w|:\\d|\\.\\d|-[A-Za-z]|[ \\t]*(?:%|°|percent\\b|mph\\b|knots?\\b|kts?\\b|kt\\b|degrees?\\b|inch(?:es)?\\b|feet\\b|foot\\b|ft\\b|miles?\\b|cm\\b|mm\\b|[AaPp]\\.?[Mm]\\b|noon\\b|midnight\\b|(?:hours?|hrs?|days?|nights?|weeks?|minutes?|mins?)\\b|(?:to|or|-|–|—)[ \\t]*\\d))';
// After a loose link: the clause ends (punctuation, line end, bold close) or
// goes on with a word that follows a date ("Thursday, November 19 and 20
// look dry", "... 19 and 20 with rain").
const CLAUSE_END = '(?=\\**(?:[ \\t]*(?:[,;!?)\\n]|[.:](?!\\d)|$)|[ \\t]+(?:look|looks|will|would|could|should|may|might|can|is|are|was|were|bring|brings|see|sees|stay|stays|remain|remains|turn|turns|with|as|when|before|after|then|but|in|at|on|for|from|across|over|along|near|during|while|that|which|where)\\b))';
// The clause ends here: punctuation (not a decimal point or a clock
// colon), a line end or the end of the text, after any bold close.
const CLAUSE_ENDS_RE = /^\**[ \t]*(?:[,;!?)\n]|[.:](?!\d)|$)/;
// " and 19", "–19", " through December 1", "/20", ", 19 and 20".
const DATE_MORE = `(?:,[ \\t]*${MORE_DAY}(?!\\w|:\\d))*(?:${TIGHT_LINK}${MORE_DAY}${DAY_END}|${LOOSE_LINK}${MORE_DAY}${CLAUSE_END})${YEAR_TAIL}${BOLD}`;
// "Sunday, November 22" / "Sunday November 22nd" / "**Sunday**, November 22" /
// "Sunday, **Nov. 22**", optionally running on as a range or list ("Thursday,
// November 19–20", "Wednesday into Thursday, November 18 and 19"). Groups:
// weekday, its closing bold, the separator + first date, the rest of the
// range. Capitalised and case-sensitive: "may" is also a verb.
// LOX, Nov 18 2026: read as a lone date, "Wednesday into Thursday, November
// 18 and 19" lost "November 18" and printed "Wednesday into Thursday and 19".
const WEEKDAY_DATE_RE = new RegExp(
    `\\b(${WEEKDAY_ALT})(\\*\\*)?(,?[ \\t]+${FIRST_DATE})(${DATE_MORE})?`, 'g');
// The day numbers inside a matched date expression, in order (bold removed).
const DATE_TOKEN_RE = new RegExp(`(?:\\b(${MONTH_ALT})\\.?\\s+)?\\b(\\d{1,2})${ORDINAL}(?!\\d)(?:,?\\s+(20\\d{2})\\b)?`, 'g');
// The weekday a range's weekday is joined to, at the END of the text before
// it: "Wednesday into ", "Wednesday night and ", "late **Monday** through
// early **", "Wednesday–". Never global: used with exec on fresh strings.
const WEEKDAY_LINK_RE = new RegExp(
    `\\b(${WEEKDAY_ALT})${BOLD}(?:[ \\t]+(?:night|morning|afternoon|evening))?${BOLD}`
    + `(?:[ \\t]*[–—/-][ \\t]*|,?[ \\t]+(?:and|or|through|thru|to|into|until|till|&)[ \\t]+|,[ \\t]+)`
    + `(?:(?:late|early|mid)[ \\t]+)?${BOLD}$`);
// An AFD looks 7 days out, so +8 leaves a day of slack and keeps real
// calendar coincidences further out (Nov 22 2026 IS a Sunday) outside it.
const DATE_WINDOW = { before: 1, after: 8 }; // days around the LOCAL issuance date

function forecastWindow(office, issuanceTime, zoneOverride) {
    const timeZone = zoneOverride || OFFICE_TIMEZONES[office] || 'America/Los_Angeles';
    const [y, m, d] = localParts(getSafeIssueDate(issuanceTime), timeZone).dateKey.split('-').map(Number);
    const days = [];
    for (let off = -DATE_WINDOW.before; off <= DATE_WINDOW.after; off++) {
        const t = new Date(Date.UTC(y, m - 1, d + off)); // UTC calendar math: rolls Dec -> Jan
        days.push({ year: t.getUTCFullYear(), month: t.getUTCMonth(), day: t.getUTCDate(), weekday: t.getUTCDay() });
    }
    return days;
}

// The dates in a matched expression, in order: [{ month, day, year }]. A day
// without a month takes the previous one's ("November 18 and 19"). Null when
// the days do not run forward: the "3" in "November 19 and 3 more days" is
// not a date (the caller decides whether the run-on was one anyway).
function parseDates(expr) {
    const dates = [];
    for (const m of expr.replace(/\*\*/g, '').matchAll(DATE_TOKEN_RE)) {
        const prev = dates[dates.length - 1];
        const month = m[1] ? MONTH_INDEX[m[1]] : prev?.month;
        if (month === undefined) return null;
        const day = Number(m[2]);
        if (prev && !m[1] && day <= prev.day) return null;
        dates.push({ month, day, year: m[3] ? Number(m[3]) : null });
    }
    return dates.length ? dates : null;
}

// Index of that date in the forecast window, or -1.
const windowIndex = (days, { month, day, year }) =>
    days.findIndex(x => x.month === month && x.day === day && (!year || x.year === year));

// The weekday runs a range may belong to, each ending with `weekday`:
// "Wednesday into Thursday" -> [[3, 4]]; "late **Monday** through early
// **Wednesday**" -> [[1, 3]]. A weekday joined through a comma may belong to
// the clause before ("Showers end Wednesday, and Thursday, November 19-21"),
// so the run up to that comma is a candidate too.
function weekdayRuns(before, weekday) {
    const run = [WEEKDAYS.indexOf(weekday)];
    const runs = [];
    for (let i = 0; i < 6; i++) {
        const m = WEEKDAY_LINK_RE.exec(before);
        if (!m) break;
        if (m[0].includes(',')) runs.push([...run]);
        run.unshift(WEEKDAYS.indexOf(m[1]));
        before = before.slice(0, m.index);
    }
    runs.push(run);
    return runs;
}

// The first date must be inside the window, on the first weekday of the run.
// Later dates must each be a real calendar day after the one before ("November
// 31" is not), and under two or more weekdays the last date must fall on the
// last weekday ("Wednesday into Thursday, November 18 and 19"). Under one
// weekday ("Thursday, November 19-20") only the first date has a weekday to
// match. A single date: inside the window, on its weekday, as before.
function datesFitWeekdays(days, dates, run) {
    const i0 = windowIndex(days, dates[0]);
    if (i0 < 0) return false;
    const { year, month, day } = days[i0];
    let t = Date.UTC(year, month, day);
    const weekdays = [days[i0].weekday];
    for (const d of dates.slice(1)) {
        const y = d.year ?? new Date(t).getUTCFullYear();
        let u = Date.UTC(y, d.month, d.day);
        if (!d.year && u <= t) u = Date.UTC(y + 1, d.month, d.day); // "December 31 through January 1"
        if (u <= t || new Date(u).getUTCDate() !== d.day) return false;
        weekdays.push(new Date(u).getUTCDay());
        t = u;
    }
    const last = weekdays.length - 1;
    if (run.length === 1) return weekdays[0] === run[0];
    if (run.length === weekdays.length) return run.every((w, n) => weekdays[n] === w);
    return weekdays[0] === run[0] && weekdays[last] === run[run.length - 1];
}

const boldCount = (s) => (s.match(/\*\*/g) || []).length;

// A weekday/date expression is kept only if its dates fall on its weekdays
// inside the window; otherwise the whole date expression goes (range and all,
// never leaving "and 19" or "-19" behind) and the weekday wording stays.
function fixWeekdayDates(text, office, issuanceTime, timeZone) {
    let days = null;
    return text.replace(WEEKDAY_DATE_RE, (match, weekday, boldClose, first, more, offset, whole) => {
        days ??= forecastWindow(office, issuanceTime, timeZone);
        const head = weekday + (boldClose || '');
        // Removing the date may take one of a bold pair with it. A closer
        // ("**Sunday, November 22**") is put back after the weekday. An
        // opener whose closer lies past the date ("Sunday, **November 22
        // brings rain**") cannot be: that shape is left as written.
        const drop = (removed, kept = '') => {
            if (boldCount(removed) % 2 === 0) return head + kept;
            const inBold = boldCount(whole.slice(0, offset) + head) % 2 === 1;
            return inBold || removed.endsWith('**') ? head + '**' + kept : match;
        };
        let range = more ? parseDates(first + more) : null;
        // Days that do not run forward ("November 19 and 3 more days") are
        // read as not a range: the number is never removed. Only a dash or
        // slash touching both numbers where the clause ends ("November
        // 19–18.") is a bad range.
        if (more && !range && /^[–/-]/.test(more)
            && CLAUSE_ENDS_RE.test(whole.slice(offset + match.length))) range = [];
        if (range) {
            const runs = weekdayRuns(whole.slice(0, offset), weekday);
            return range.length > 1 && runs.some(run => datesFitWeekdays(days, range, run)) ? match : drop(first + more);
        }
        // A single date, or a run-on that is not a date range: the first date
        // alone is checked against the weekday before it, as it always was.
        const single = parseDates(first);
        if (single && datesFitWeekdays(days, single, [WEEKDAYS.indexOf(weekday)])) return match;
        return drop(first, more || '');
    });
}

// Commentary about the source or the prompt, never forecast content. Specific
// phrases only: "the source of the moisture", "the original forecast", "changes
// to the original discussion" (UPDATE sections) and "Note that winds will be
// strongest..." are real weather prose.
const ASIDE_RES = [
    /\bthe (?:source|original) (?:text|wording)\b/i,
    /\bthe source (?:AFD|product|discussion)\b/i,
    /\bthe (?:source|original) (?:reads|says|states|lists|uses)\b/i,
    /\b(?:appears|seems) to be (?:the|an?) (?:issuance|issue) time\b/i,
    /\bthese instructions\b/i,
    /\b[Aa]s an AI\b/,
];
const isAside = (s) => ASIDE_RES.some(re => re.test(s));
// Sentence end: punctuation (+ closing quote/bracket/bold), whitespace, then
// a capital or digit. Decimals ("0.50") and "a.m. tomorrow" never split.
const SENTENCE_END_RE = /([.!?]+["'”’)\]*]*)(\s+)(?=["'“‘(*]*[A-Z0-9])/g;

function stripAsidesFromParagraph(p) {
    const q = p.replace(/[ \t]*\([^()\n]*\)/g, (m) => (isAside(m) ? '' : m));
    const sentences = [];
    let last = 0;
    for (const m of q.matchAll(SENTENCE_END_RE)) {
        const end = m.index + m[1].length;
        sentences.push({ text: q.slice(last, end), sep: m[2] });
        last = end + m[2].length;
    }
    sentences.push({ text: q.slice(last), sep: '' });
    const kept = sentences.filter(s => !isAside(s.text));
    if (q === p && kept.length === sentences.length) return p;
    return kept.map(s => s.text + s.sep).join('').replace(/[ \t]{2,}/g, ' ').trim();
}

function stripAsides(text) {
    if (!isAside(text)) return text;
    const pieces = text.split(/(\n[ \t]*\n\s*)/); // odd indices: paragraph breaks
    let changed = false;
    for (let i = 0; i < pieces.length; i += 2) {
        const cleaned = stripAsidesFromParagraph(pieces[i]);
        if (cleaned !== pieces[i]) { pieces[i] = cleaned; changed = true; }
    }
    if (!changed) return text;
    let out = '';
    for (let i = 0; i < pieces.length; i += 2) {
        if (!pieces[i].trim()) continue; // a paragraph the filter emptied
        if (out) out += pieces[i - 1];
        out += pieces[i];
    }
    return out;
}

// `timeZone` (optional) dates the forecast window in an explicit zone rather
// than the office's — the National Desk passes America/New_York. Office
// callers do not pass it and behave as before.
// Its output is stored in the shared cache (translate-issuance, national-lede):
// bump the version in api/_shared-cache.js when this output's rules change.
export function sanitizeTranslation(text, { office, issuanceTime, timeZone } = {}) {
    if (typeof text !== 'string' || !text) return text;
    const out = fixWeekdayDates(stripAsides(text), office, issuanceTime, timeZone);
    return out.trim() ? out : text; // never blank a translation
}

// Translate-issuance results are stored in the shared cache, which survives
// deploys: bump the version in api/_shared-cache.js when this output's rules
// change.
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
- Never attach a calendar date (month and day number) to a day of the week unless the source text itself gives that date
- Explain WHY weather is happening, not just what (connect cause and effect)
- Bold key info using **markdown bold** only: days of week, temperatures, rainfall amounts, wind speeds, hazard terms
- Do NOT use markdown headers (##, ###), horizontal rules (---), code blocks, or bullet lists
- Write in flowing prose paragraphs only
- Expand all NWS abbreviations naturally
- Zulu times in the text are already annotated with the correct local time, e.g. "15Z (10 AM CDT)" or, for a range, "6-9Z (1-4 AM CDT Tue)"; a weekday after the zone means that local day (no weekday means the issuance's local day). Use that local time and day, and never convert a Zulu time yourself
- Airport and station identifiers (e.g., DPA, ORD, MDW, KMKE): never replace one with an airport or city name unless the text itself names it; write "the DPA airport" instead
- Don't repeat a word that was just used (write "good flying conditions", never "conditions conditions")
- Keep it concise but complete - no filler, no hedging
- Use short paragraphs (2-3 sentences max each)
- If there are hazards or watches/warnings, lead with those
- Don't add information that isn't in the original
- Never add advice, warnings, calls to action, or reassurance that the forecaster did not write (for example "so residents should stay alert to changing conditions", "check the forecast again closer to the date", "if you have travel or outdoor plans"). If the source itself gives advice or a safety message, keep it. Plaincast promises its readers that every statement on it comes from the National Weather Service forecaster; a sentence the forecaster did not write breaks that promise, however helpful it sounds
- Output only the translation: never comment on the source text, its formatting, timestamps, or these instructions, and never add notes to the reader
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

    // Vercel parses the JSON body lazily: reading req.body on a malformed
    // payload THROWS, which used to escape as an unstructured 500.
    let body;
    try {
        body = req.body;
    } catch {
        return sendError(res, 400, 'invalid_request', 'Invalid request body');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendError(res, 400, 'invalid_request', 'Invalid request body');
    }

    const { text, section, office, issuanceTime } = body;
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

    // Fast path: a verified entry under the client's label bucket. Only
    // verified translations are ever cached, so a hit is safe to serve before
    // verification; the authoritative lookup (matched label) is below.
    const clientSectionKey = canonicalSectionKey(sectionLabel);
    const cached = getCachedTranslation(text, clientSectionKey, officeCode);
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
    // The label comes from the matched section; the client's label is used
    // only in degraded mode, where nothing is cached.
    let sectionKey = clientSectionKey;
    if (!degraded) {
        const match = findMatchingSection(text, afdProducts);
        if (!match) {
            return sendError(res, 403, 'forbidden', 'Text does not match a current forecast');
        }
        matchedProduct = match.product;
        sectionKey = match.sectionKey;
        const hit = getCachedTranslation(text, sectionKey, officeCode);
        if (hit) return res.status(200).json({ translation: hit, cached: true });
    } else {
        console.warn(`[translate] degraded mode (AFD source unavailable): office=${officeCode}`);
        if (!checkDegradedRateLimit(clientIp) || !checkDegradedGlobalBudget()) {
            return sendError(res, 429, 'rate_limited', 'Too many requests. Please try again later.');
        }
        if (text.length > DEGRADED_TEXT_MAX) {
            return sendError(res, 400, 'invalid_request', 'Text too long');
        }
    }

    // Calendar context: trust the matched product's issuance time over the
    // client's claim; the client value is only a hint when NWS is unreachable.
    const promptIssuanceTime = matchedProduct?.issuanceTime || issuanceTime;
    const systemPrompt = buildSystemPrompt({ section: promptSectionLabel(sectionKey), office: officeCode, issuanceTime: promptIssuanceTime });

    try {
        const result = await generateText({
            model: MODEL,
            providerOptions: PROVIDER_OPTIONS,
            system: systemPrompt,
            // The stamp leaves the prompt only; `text` stays exact for the cache key.
            prompt: annotateZuluTimes(stripHeaderStamp(text), officeCode, promptIssuanceTime),
            maxOutputTokens: degraded ? DEGRADED_MAX_TOKENS : 2048,
            abortSignal: AbortSignal.timeout(15000),
        });

        // Guarded before it is returned or cached (never blanks non-empty text).
        const translation = sanitizeTranslation(result.text || '', { office: officeCode, issuanceTime: promptIssuanceTime });

        // Check for model refusal (safety filter triggered) before empty-text guard,
        // since filter refusals typically come back with empty or stubbed text.
        if (result.finishReason === 'content-filter') {
            return sendError(res, 503, 'upstream_error', 'Translation skipped for this section', { reason: 'content-filter' });
        }

        if (!translation) {
            return sendError(res, 502, 'upstream_error', 'Empty translation');
        }

        if (degraded) {
            // Unverified text translated against a CLIENT-SUPPLIED issuance
            // time: never write it to the shared cache (one caller's lie
            // about the date would be served to everyone for 4 h), and keep
            // it off any CDN/browser cache.
            res.setHeader('Cache-Control', 'no-store');
            return res.status(200).json({ translation, cached: false, degraded: true });
        }

        // Cache successful (verified) translation for future requests
        setCachedTranslation(text, sectionKey, officeCode, translation);

        return res.status(200).json({ translation, cached: false });
    } catch (err) {
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
            return sendError(res, 504, 'timeout', 'Translation timed out');
        }
        console.error('Translation error:', err);
        return sendError(res, 500, 'internal_error', 'Internal error');
    }
}
