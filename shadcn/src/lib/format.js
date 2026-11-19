// Small time/format helpers (ported from docs/js/app.js).

export function timeAgo(date) {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

// date.toLocaleString('en-US', options), except for the two US zones Intl
// has no short name for: it prints an offset ("GMT+10", "GMT-11") where NWS
// writes ChST (Guam and the Northern Marianas) and SST (American Samoa).
// Every office time label goes through this — the client, docs/js/app.js
// (code-identical copy, tests/shadcn-parity.test.js) and the server pages.
export function formatInZone(date, options) {
    const ZONE_NAMES = { 'Pacific/Guam': 'ChST', 'Pacific/Saipan': 'ChST', 'Pacific/Pago_Pago': 'SST' };
    const name = options && options.timeZoneName === 'short' ? ZONE_NAMES[options.timeZone] : null;
    if (!name) return date.toLocaleString('en-US', options);
    return new Intl.DateTimeFormat('en-US', options).formatToParts(date)
        .map(p => (p.type === 'timeZoneName' ? name : p.value))
        .join('')
        // Newer ICU puts a narrow no-break space (U+202F) before AM/PM; the
        // reading font has no glyph for it, so it falls back mid-line.
        .replace(/\u202f/g, ' ');
}

// The short zone name formatInZone prints for this instant ("PST", "ChST",
// "SST"), for callers that assemble a label from formatToParts (the server's
// Zulu annotations, the National Desk clock): the same mapping, one source.
export function shortZoneName(date, timeZone) {
    const label = formatInZone(date, { hour: 'numeric', timeZone, timeZoneName: 'short' });
    return label.slice(label.lastIndexOf(' ') + 1);
}

export function formatIssueTime(date, tz) {
    try {
        return formatInZone(date, {
            weekday: 'long', month: 'long', day: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short',
        });
    } catch (e) {
        return date.toLocaleString();
    }
}

// Local hour (0–23) of an instant in the office's timezone.
export function localHour(date, tz) {
    try {
        return parseInt(date.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: tz }), 10) % 24;
    } catch (e) { return date.getHours(); }
}

// NWS issues AFDs roughly 4×/day; name the edition by local issuance hour
// (same bands as the vanilla client's editionName).
export function editionName(hour) {
    if (hour >= 3 && hour < 9) return 'Morning';
    if (hour >= 9 && hour < 14) return 'Midday';
    if (hour >= 14 && hour < 20) return 'Evening';
    return 'Late';
}

// A reading from /api/conditions as a finite number, or null when absent.
// The endpoint returns `null` for an unavailable reading, and +null === 0, so
// a bare Number.isFinite(+x) rendered "Now 0°" (HFO, Sep 2026). A real 0° is
// still a reading.
export function readingOrNull(x) {
    if (x === null || x === undefined) return null;
    if (typeof x === 'string' && x.trim() === '') return null;
    const n = typeof x === 'number' ? x : Number(x);
    return Number.isFinite(n) ? n : null;
}
