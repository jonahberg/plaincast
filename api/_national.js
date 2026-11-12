// Pure logic for the National Desk. No I/O here — fetchers live in _utils.js,
// rendering in national-desk.js — so every branch is unit-testable.

// Office code = last 3 chars of the AWIPS identifier (e.g. SVRPUB -> PUB).
// Verified against the live feed 2026-08-15; senderName is NOT parseable
// ("NWS El Paso Tx/Santa Teresa NM" has no code in it).
export function officeFromAlert(props) {
    const awips = props?.parameters?.AWIPSidentifier;
    const id = Array.isArray(awips) ? String(awips[0] || '') : '';
    const code = id.slice(-3);
    return /^[A-Z]{3}$/.test(code) && id.length >= 6 ? code : null;
}

// One Wire row per office under an active Severe/Extreme *Warning*.
// Worst first: any Extreme outranks all Severe; ties break on count desc.
// The leading event for an office is its worst warning (extreme beats
// severe), first-seen on ties — the feed is already newest-first.
//
// areaDesc/expires are RAW passthrough fields captured from the office's
// LEADING warning (whichever alert currently backs `event`) — no formatting
// here; Task 3 renders them via digestArea/formatExpiry.
export function groupDispatches(features, officeNames) {
    const byOffice = new Map();
    for (const feat of features || []) {
        const p = feat?.properties || {};
        if (!/warning/i.test(p.event || '')) continue;
        const code = officeFromAlert(p);
        if (!code) continue;
        const extreme = /extreme/i.test(p.severity || '');
        const row = byOffice.get(code);
        if (!row) {
            byOffice.set(code, {
                code,
                city: officeNames[code] || null,
                event: p.event,
                count: 1,
                extreme,
                areaDesc: p.areaDesc || null,
                expires: p.expires || p.ends || null,
            });
        } else {
            row.count += 1;
            if (extreme && !row.extreme) {
                row.extreme = true;
                row.event = p.event;
                row.areaDesc = p.areaDesc || null;
                row.expires = p.expires || p.ends || null;
            }
        }
    }
    return [...byOffice.values()].sort((a, b) =>
        (b.extreme - a.extreme) || (b.count - a.count) || a.code.localeCompare(b.code));
}

const CENSUS_MAX = 6;

// Event-class counts across the whole Severe/Extreme feed (warnings AND
// watches — the census reports the sky, the Wire reports the offices).
// `max` defaults to the strip's cap; the calm-face check passes Infinity so a
// rare tropical class below the top six still counts.
export function buildCensus(features, max = CENSUS_MAX) {
    const counts = new Map();
    for (const feat of features || []) {
        const event = feat?.properties?.event;
        if (!event) continue;
        counts.set(event, (counts.get(event) || 0) + 1);
    }
    return [...counts.entries()]
        .map(([event, count]) => ({ event, count }))
        .sort((a, b) => (b.count - a.count) || a.event.localeCompare(b.event))
        .slice(0, max);
}

// Tropical-cyclone products. They never appear in an SPC convective outlook,
// so a day with no thunderstorm risk can still be a day with a hurricane
// watch up — and the headline must not call that sky quiet.
const TROPICAL_EVENT = /hurricane|tropical storm|typhoon|storm surge/i;

// The desk headline when SPC outlines no convective risk. "Quiet skies" is a
// claim about the WHOLE sky, so it is only true when the severe/extreme feed
// is empty too. Otherwise the headline narrows to what the outlook actually
// says (no thunderstorm risk) and the note names what IS in effect —
// tropical classes first, since those are the ones a reader would be most
// misled about. Returns plain text; the caller escapes.
export function calmHeadline(census) {
    const all = (census || []).filter(c => c?.event && c.count > 0);
    if (all.length === 0) return { title: 'Quiet skies nationally', note: null };
    const tropical = all.filter(c => TROPICAL_EVENT.test(c.event));
    const lead = (tropical.length ? tropical : all).slice(0, 3)
        .map(c => `${c.event} ×${c.count}`).join(' · ');
    return {
        title: 'No severe thunderstorm risk outlined',
        note: tropical.length
            ? `The tropics are active: ${lead}`
            : `Other hazards in effect: ${lead}`,
    };
}

// SPC Day 1 Convective Outlook shape (verified live 2026-08-15):
//   ...THERE IS A SLIGHT RISK OF SEVERE THUNDERSTORMS PORTIONS OF...
//   ...SUMMARY...
//   <prose paragraph(s)>
//   ...<NEXT SECTION>...
export function parseSpcOutlook(productText) {
    const text = String(productText || '');
    const headlineMatch = text.match(/^\.\.\.(THERE IS [^.].*?)\.\.\.\s*$/ims);
    const headline = headlineMatch
        ? headlineMatch[1].replace(/\s+/g, ' ').trim()
        : null;
    const summaryMatch = text.match(/\.\.\.SUMMARY\.\.\.\s*\n([\s\S]*?)(?=\n\s*\.\.\.|\n\s*\$\$|$)/i);
    const summary = summaryMatch
        ? summaryMatch[1].replace(/\s+/g, ' ').trim() || null
        : null;
    return { headline, summary };
}

const RISK_LEVELS = ['MARGINAL', 'SLIGHT', 'ENHANCED', 'MODERATE', 'HIGH'];

// Day-1 categorical risk from the THERE-IS headline. `regions` is the prose
// after "OF SEVERE THUNDERSTORMS" with one leading connective trimmed (the
// rail's caption). `area` is that same tail untouched ("TODAY ACROSS PARTS
// OF ..."), which is what the risk line needs to read as a sentence.
export function parseRiskCategory(headline) {
    const text = String(headline || '');
    const m = text.match(/THERE IS AN? (MARGINAL|SLIGHT|ENHANCED|MODERATE|HIGH) RISK OF SEVERE THUNDERSTORMS\s*(.*)$/i);
    if (!m) return null;
    const level = m[1].toUpperCase();
    if (!RISK_LEVELS.includes(level)) return null;
    const area = m[2].replace(/\s+/g, ' ').trim();
    const regions = area
        .replace(/^(ACROSS|FOR|OVER|PORTIONS OF|PARTS OF)\s+/i, '')
        .trim();
    return { level, regions, area };
}

// ── Area casing ─────────────────────────────────────────────────────
// SPC headlines are SHOUTED and joined with "..." ("PARTS OF SOUTHEASTERN
// PENNSYLVANIA...MUCH OF DELAWARE"). caseArea turns that into prose: commas
// for the "..." joins, everything lowercase, then the proper names below put
// back. The list is explicit on purpose: a guess ("capitalise any word that
// follows 'the'") would capitalise "the middle" and miss "southern Indiana".
//
// Compass words stay lowercase as adjectives ("southeastern Pennsylvania",
// "central High Plains"). The four compass REGIONS (Northeast, Northwest,
// Southeast, Southwest) are capitalised only when they stand alone ("the
// Southeast"); followed by a place they are adjectives ("northwest
// Washington", "far southeast Virginia" — both live Nov 2026 headlines).
const STATE_NAMES = [
    'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut',
    'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa',
    'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan',
    'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire',
    'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio',
    'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota',
    'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia',
    'Wisconsin', 'Wyoming', 'District of Columbia',
];
// Geographic names SPC routinely writes. Hyphen and space are interchangeable
// when matching ("MID-ATLANTIC" and "MID ATLANTIC" both match "Mid-Atlantic");
// the source's own separator is kept.
const REGION_NAMES = [
    'Mid-Atlantic', 'Mid-South', 'Deep South', 'New England', 'Great Lakes', 'Great Plains',
    'High Plains', 'Plains', 'Great Basin', 'Ohio Valley', 'Tennessee Valley',
    'Mississippi Valley', 'Missouri Valley', 'Red River', 'Rio Grande', 'Gulf Coast',
    'Gulf of America', 'Gulf of Mexico', 'Gulf', 'Atlantic Seaboard', 'Eastern Seaboard',
    'Atlantic', 'Pacific', 'Appalachians', 'Ozarks', 'Rockies', 'Black Hills', 'Carolinas',
    'Dakotas', 'Virginias', 'Florida Peninsula', 'Florida Panhandle', 'Florida Keys',
    'Texas Panhandle', 'Oklahoma Panhandle', 'Big Bend', 'Delmarva', 'Arklatex', 'Ark-La-Tex',
    'Arklamiss', 'Four Corners', 'Intermountain West', 'Midwest', 'Northeast', 'Southeast',
    'Southwest', 'Northwest', 'Pacific Northwest', 'Hudson Valley', 'Chesapeake',
    'Great Salt Lake', 'Sierra Nevada', 'Cascades', 'Front Range', 'Edwards Plateau',
    'Lake Michigan', 'Lake Superior', 'Lake Erie', 'Lake Huron', 'Lake Ontario',
    'Lake Okeechobee', 'Upper Peninsula', 'Piedmont', 'Tidewater', 'Blue Ridge',
    'Cumberland Plateau', 'Allegheny Plateau', 'Permian Basin', 'Hill Country', 'Lowcountry',
    'Sandhills', 'Llano Estacado', 'Central Valley', 'Columbia Basin', 'Snake River Plain',
    'Puget Sound', 'Long Island', 'Cape Cod', 'Outer Banks', 'Mogollon Rim', 'Wasatch',
    'Bootheel', 'Coastal Bend', 'Concho Valley', 'Big Country', 'Rolling Plains',
    'Continental Divide', 'Canadian Prairies', 'Alleghenies',
];
// A river or landform word right after a proper name is part of that name:
// "western Tennessee Valleys", "Kansas River", "Nebraska Panhandle".
const NAME_SUFFIXES = new Set(['valley', 'valleys', 'river', 'rivers', 'basin', 'panhandle', 'peninsula', 'plateau', 'delta']);
// Postal codes stay uppercase. Codes that are also everyday words are left
// out, because in an all-caps headline "IN" is far likelier to be the
// preposition than Indiana (likewise OR, ME, HI, OK).
const POSTAL_CODES = new Set(('AL AK AZ AR CA CO CT DE DC FL GA IA ID IL KS KY LA MA MD MI MN MO MS MT NC '
    + 'ND NE NH NJ NM NV NY OH PA RI SC SD TN TX UT VA VT WA WI WV WY').split(' '));
// Acronyms that must not be lowercased.
const ACRONYMS = new Map([['us', 'US'], ['u.s', 'U.S'], ['conus', 'CONUS']]);

export const AREA_PROPER_NOUNS = [...STATE_NAMES, ...REGION_NAMES];

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameKey = (s) => s.toLowerCase().split(/[\s-]+/).join(' ');
const NAME_BY_KEY = new Map(AREA_PROPER_NOUNS.map(n => [nameKey(n), n]));
// One alternation, longest first: at each position the regex takes the first
// alternative that matches, so "North Carolina" beats "north", "Pacific
// Northwest" beats "Pacific", "West Virginia" beats "Virginia", and a matched
// name is never rescanned for a shorter one inside it.
const NAME_RE = new RegExp(`(?<!\\w)(?:${[...AREA_PROPER_NOUNS]
    .sort((a, b) => b.length - a.length)
    .map(n => n.split(/[\s-]+/).map(escRe).join('[\\s-]+'))
    .join('|')})(?!\\w)`, 'gi');
const capWord = (w) => w.charAt(0).toUpperCase() + w.slice(1);
// The words a suffix may follow: the last word of every listed name, and the
// suffixes themselves once capitalised ("Connecticut River Valley").
const NAME_LAST_WORDS = new Set([
    ...AREA_PROPER_NOUNS.map(n => n.split(/[\s-]+/).pop()),
    ...[...NAME_SUFFIXES].map(capWord),
]);
const SUFFIX_RE = /(?<=(?<!\w)([A-Z]\w*)[\s-]+)([a-z]+)(?!\w)/g;
// A compass region followed by a name (or a postal code) is an adjective.
const COMPASS_REGION_RE = /(?<!Pacific[\s-]+)\b(Northeast|Northwest|Southeast|Southwest)(?=[\s-]+[A-Z])/g;

// Lowercased prose with the proper names restored; no sentence casing.
// Plain text in, plain text out — the caller escapes.
export function caseArea(text) {
    let s = String(text ?? '')
        .replace(/\s*\.{2,}\s*/g, ', ')    // SPC's "..." joins
        .replace(/\s+/g, ' ')
        .replace(/^[,\s]+|[,\s]+$/g, '')
        .toLowerCase();
    if (!s) return '';
    s = s.replace(NAME_RE, (m) => {
        const canon = NAME_BY_KEY.get(nameKey(m));
        if (!canon) return m;
        const words = canon.split(/[\s-]+/);
        let i = 0;
        return m.replace(/[^\s-]+/g, () => words[i++] ?? '');
    });
    // Suffix words after a name ("western Tennessee valleys" -> Valleys);
    // repeated so a chain resolves left to right.
    for (let prev = null; prev !== s;) {
        prev = s;
        s = s.replace(SUFFIX_RE, (word, name) =>
            (NAME_SUFFIXES.has(word) && NAME_LAST_WORDS.has(name) ? capWord(word) : word));
    }
    s = s.replace(/(?<![\w.])[a-z]{2}(?![\w.])/g, (m) => (POSTAL_CODES.has(m.toUpperCase()) ? m.toUpperCase() : m));
    s = s.replace(/(?<![\w.])(?:u\.s|us|conus)(?!\w)/g, (m) => ACRONYMS.get(m) ?? m);
    s = s.replace(COMPASS_REGION_RE, (m) => m.toLowerCase());
    return s;
}

// Words that already make the tail read as a sentence after "Risk of severe
// thunderstorms". Anything else ("PORTIONS OF THE OHIO VALLEY", swody1 of Aug
// 15) is a bare place and gets "across", SPC's own usual preposition.
const AREA_LEAD = /^(?:today|tonight|tomorrow|this|through|across|over|for|from|in|into|along|near|around|within|on|at|between|off|during|late|early|mainly|mostly|primarily|especially|by|with)\b/i;

// The risk line under the categorical word, as one sentence:
//   "Risk of severe thunderstorms today across parts of southeastern
//    Pennsylvania, much of Delaware, adjacent eastern Maryland and southern
//    through central New Jersey."
// Accepts a parseRiskCategory result; falls back to `regions` for a risk
// object built without `area`. Plain text — the caller escapes.
export function riskAreaLine(risk) {
    const raw = risk?.area ?? risk?.regions ?? '';
    const area = caseArea(raw).replace(/[.,;:\s]+$/, '');
    if (!area) return 'Risk of severe thunderstorms.';
    return `Risk of severe thunderstorms ${AREA_LEAD.test(area) ? '' : 'across '}${area}.`;
}

// A rail caption from `regions`: the same casing, sentence-cased.
export function areaCaption(regions) {
    const s = caseArea(regions);
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : null;
}

// Dot-prefixed structural markers: section headers ("...SUMMARY...",
// "...20Z Update..."), forecaster bylines ("..Squitieri.. 08/15/2026"), and
// the "PREV DISCUSSION" reissue marker (".PREV DISCUSSION... /ISSUED.../")
// all open with 1-3 literal dots immediately followed by a letter/digit —
// none of them are prose. Broadened past a strict full-header (three dots
// on both ends) match, because the live DY1 fixture carries single- and
// double-dot marker lines too, so paragraph filtering below excludes ALL
// of them, not just the full ...SECTION... headers.
const SECTION_MARK = /^\s*\.{1,3}[A-Z0-9]/;
const HEADER_LINE = /^\s*\.\.\./;

// A reissued outlook republishes the discussion it supersedes verbatim under
// ".PREV DISCUSSION... /ISSUED <time>/" — the 20Z update's own prose comes
// FIRST, the stale 1135 AM copy after. Everything from that line down is
// last issuance's forecast; printing it as running copy would date the front
// page by hours. Dot count varies in the live products (1-3), hence {1,3}.
const PREV_DISCUSSION = /^\s*\.{1,3}PREV DISCUSSION/im;

// Reissue housekeeping, not forecast. An update paragraph that OPENS by
// referring the reader to the previous forecast ("The previous forecast (see
// below) remains generally on track...") is talking about the outlook process,
// and its "see below" points at the PREV block we just cut — a dangling
// reference. Spec: running copy must open with forecast prose directly.
//
// Deliberately narrow, and deliberately whole-paragraph. Anchored at the
// paragraph start and bounded to a short window, so prose that merely mentions
// a previous forecast mid-sentence survives; and we drop the paragraph rather
// than trying to salvage the meteorology buried later in it, because
// sentence-level surgery on forecaster prose is how you publish half a
// sentence. If that empties the list, the caller's summary fallback covers it.
const REISSUE_PREAMBLE = /^(?:the )?previous (?:forecast|outlook|discussion)\b.{0,120}?\b(?:remains?|see below|on track|unchanged)\b/i;

// The other shape of reissue housekeeping: a 20Z update that says what (if
// anything) changed and then sends the reader to the discussion below — the
// PREV block we cut, so the pointer dangles. Every 20Z Day 1 of Nov 5–12 2026
// that the preamble rule missed ended this way ("No changes are needed to the
// current D1 Convective Outlook. See previous discussion below for more
// information."). Same whole-paragraph policy; an update paragraph with real
// meteorology and no pointer (Nov 8: "The Marginal Risk along the lower Texas
// coast was removed...") is kept.
const REISSUE_POINTER = /\bsee (?:the )?(?:previous|prior) (?:discussion|outlook|forecast) below\b/i;

// Narrative paragraphs AFTER the ...SUMMARY... block — the standfirst already
// covers the summary, so the running copy must never repeat it (spec §5).
export function parseDiscussionBody(productText) {
    const raw = String(productText || '');
    // Truncate BEFORE anything else: a PREV marker sitting ahead of the
    // summary leaves no searchable text at all, which the sumIdx === -1 guard
    // below turns into [] — the running-copy fallback, exactly right.
    const prevIdx = raw.search(PREV_DISCUSSION);
    const text = prevIdx === -1 ? raw : raw.slice(0, prevIdx);
    const sumIdx = text.search(/\.\.\.SUMMARY\.\.\./i);
    if (sumIdx === -1) return [];
    const after = text.slice(sumIdx);
    // The summary may span multiple paragraphs; the reliable cut point is the
    // next ...SECTION... header line after SUMMARY — body prose starts there.
    const lines = after.split('\n');
    let bodyStart = -1;
    for (let i = 1; i < lines.length; i++) {
        if (HEADER_LINE.test(lines[i])) { bodyStart = i; break; }
    }
    if (bodyStart === -1) return [];
    const body = lines.slice(bodyStart).join('\n');
    return body
        .split(/\n\s*\n+/)
        .map(p => p.split('\n')
            .filter(l => !SECTION_MARK.test(l) && !/^\s*\$\$|^\s*&&/.test(l))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim())
        .filter(p => p.length >= 40 && !/^(ATTN|\.\.\.)/.test(p))
        .filter(p => !REISSUE_PREAMBLE.test(p) && !REISSUE_POINTER.test(p))
        .slice(0, 3);
}

// areaDesc digest: NWS separates areas with ';'. Two names + overflow count.
export function digestArea(areaDesc) {
    const parts = String(areaDesc || '').split(';').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    const head = `${parts[0]} & ${parts[1]}`;
    return parts.length > 2 ? `${head} +${parts.length - 2} more` : head;
}

export function formatExpiry(iso, tz) {
    try {
        if (!iso) return null; // new Date(null) resolves to the epoch, not NaN
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return null;
        const t = d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' });
        return `until ${t}`;
    } catch { return null; }
}

// Fixed SPC Day-1 issuance slots (UTC). Next slot strictly after `nowIso`.
const SPC_SLOTS = [1, 6, 13, 16.5, 20]; // 0100, 0600, 1300, 1630, 2000 UTC
export function nextOutlookTime(nowIso) {
    const d = new Date(nowIso);
    const nowH = d.getUTCHours() + d.getUTCMinutes() / 60;
    const next = SPC_SLOTS.find(s => s > nowH) ?? SPC_SLOTS[0];
    const h = Math.floor(next), m = Math.round((next - h) * 60);
    return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')} UTC`;
}

// The same slot as an instant (ISO string), rolling to tomorrow's 0100 UTC
// after the day's last slot — what a <time datetime> needs. Null on a bad date.
export function nextOutlookAt(nowIso) {
    const d = new Date(nowIso);
    if (Number.isNaN(d.getTime())) return null;
    const nowH = d.getUTCHours() + d.getUTCMinutes() / 60;
    const i = SPC_SLOTS.findIndex(s => s > nowH);
    const slot = i === -1 ? SPC_SLOTS[0] : SPC_SLOTS[i];
    const h = Math.floor(slot), m = Math.round((slot - h) * 60);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (i === -1 ? 1 : 0), h, m)).toISOString();
}

// The page is national and CDN-cached, so the server cannot know a reader's
// zone: it prints US Eastern, and /js/national.js re-renders each <time> in
// the reader's own zone. Built from formatToParts, not toLocaleString, so the
// separator before AM/PM is always a plain space (newer ICU emits U+202F).
export const DESK_TIME_ZONE = 'America/New_York';

// "12:23 AM EST", or null — never a broken string — for a missing or
// unparseable timestamp (`new Date(null)` is the epoch, not Invalid Date).
export function formatClock(iso, timeZone = DESK_TIME_ZONE) {
    if (!iso) return null;
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return null;
        const parts = {};
        for (const p of new Intl.DateTimeFormat('en-US', {
            timeZone, hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
        }).formatToParts(d)) parts[p.type] = p.value;
        if (!parts.hour || !parts.minute || !parts.dayPeriod) return null;
        return `${parts.hour}:${parts.minute} ${parts.dayPeriod.toUpperCase()}`
            + (parts.timeZoneName ? ` ${parts.timeZoneName}` : '');
    } catch { return null; }
}
