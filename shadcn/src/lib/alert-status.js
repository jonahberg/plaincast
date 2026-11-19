// ─── Alert status line + section order ──────────────────────────────
// Alerts are live client data that arrive after the page has painted. Where
// they appear is chosen so their arrival never moves painted content:
//   - a one-line status in the intro's fixed-height second meta row;
//   - the full Active Alerts section LAST, so a late arrival appends below.
// The one exception is safety: while a Severe/Extreme Warning is live
// (`severe`), the section is pinned FIRST, as it always was.

import { classifyAlertKind, groupAlerts } from './nws.js';

export const ALERTS_KEY = 'Active Alerts';

const KIND_RANK = { warning: 0, watch: 1, advisory: 2, statement: 3 };
const SEVERITY_RANK = { extreme: 0, severe: 1, moderate: 2, minor: 3 };

function rank(group) {
    const kind = KIND_RANK[classifyAlertKind(group.event)] ?? 9;
    const sev = SEVERITY_RANK[String(group.severity || '').toLowerCase()] ?? 4;
    return kind * 10 + sev;
}

// Live alerts → the status line's content, or null when there are none.
//   count  distinct alerts (the same grouping as the Active Alerts card)
//   text   "5 active alerts: Coastal Flood Watch, High Surf Advisory +3"
//   label  accessible name: the count and EVERY event name, in full
export function alertStatusSummary(alerts, { names = 2 } = {}) {
    const groups = groupAlerts(alerts);
    if (!groups.length) return null;
    // Most severe first; a stable sort keeps the feed's order within a rank.
    const ranked = groups
        .map((g, i) => ({ g, i }))
        .sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i)
        .map(x => x.g);
    const events = [];
    for (const g of ranked) {
        if (g.event && !events.includes(g.event)) events.push(g.event);
    }
    const shown = events.slice(0, names);
    const more = groups.length - groups.filter(g => shown.includes(g.event)).length;
    const count = groups.length;
    const noun = count === 1 ? 'active alert' : 'active alerts';
    const text = shown.length
        ? `${count} ${noun}: ${shown.join(', ')}${more > 0 ? ` +${more}` : ''}`
        : `${count} ${noun}`;
    const label = events.length
        ? `${count} ${noun}: ${events.join(', ')}. Jump to the alerts.`
        : `${count} ${noun}. Jump to the alerts.`;
    return { count, events, shown, more, text, label };
}

// The status line's text at decreasing lengths, for whatever room the row
// has: two event names, one, then the count alone. Whole names only, each
// with an accurate "+N", so the line condenses instead of cutting a word.
export function alertStatusVariants(alerts) {
    const out = [];
    for (const names of [2, 1, 0]) {
        const s = alertStatusSummary(alerts, { names });
        if (s && !out.includes(s.text)) out.push(s.text);
    }
    return out;
}

// The page's section order (and so the section nav's): forecast sections in
// their reading order, then live alerts — or alerts first while a severe
// warning is live.
export function withAlertsSection(forecastKeys, { liveAlerts, severe }) {
    if (!liveAlerts) return [...forecastKeys];
    return severe ? [ALERTS_KEY, ...forecastKeys] : [...forecastKeys, ALERTS_KEY];
}

// The link's accessible name must contain its visible text (WCAG 2.5.3,
// Label in Name), or voice control cannot activate it by what is on screen.
// The row condenses the visible text to fit ("13 active alerts: Flood Watch
// +9") while the full label lists every event, so when the label does not
// already contain the text shown, the name leads with it.
export function alertLinkName(visible, label) {
    const shown = String(visible ?? '').trim();
    const full = String(label ?? '').trim();
    if (!shown) return full;
    if (!full || full.includes(shown)) return full || shown;
    return `${shown}. ${full}`;
}
