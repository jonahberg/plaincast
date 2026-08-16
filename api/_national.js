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
export function buildCensus(features) {
    const counts = new Map();
    for (const feat of features || []) {
        const event = feat?.properties?.event;
        if (!event) continue;
        counts.set(event, (counts.get(event) || 0) + 1);
    }
    return [...counts.entries()]
        .map(([event, count]) => ({ event, count }))
        .sort((a, b) => (b.count - a.count) || a.event.localeCompare(b.event))
        .slice(0, CENSUS_MAX);
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

// Day-1 categorical risk from the THERE-IS headline. Regions is the prose
// after "OF SEVERE THUNDERSTORMS" (or the whole tail), title-cased lightly
// by the caller's CSS (small caps), so we just trim connective noise.
export function parseRiskCategory(headline) {
    const text = String(headline || '');
    const m = text.match(/THERE IS AN? (MARGINAL|SLIGHT|ENHANCED|MODERATE|HIGH) RISK OF SEVERE THUNDERSTORMS\s*(.*)$/i);
    if (!m) return null;
    const level = m[1].toUpperCase();
    if (!RISK_LEVELS.includes(level)) return null;
    const regions = m[2]
        .replace(/^(ACROSS|FOR|OVER|PORTIONS OF|PARTS OF)\s+/i, '')
        .replace(/\s+/g, ' ')
        .trim();
    return { level, regions };
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
