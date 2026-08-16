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
            });
        } else {
            row.count += 1;
            if (extreme && !row.extreme) {
                row.extreme = true;
                row.event = p.event;
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
