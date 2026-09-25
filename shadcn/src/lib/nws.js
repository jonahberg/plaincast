// ─── NWS API client ─────────────────────────────────────────────────
// Same public api.weather.gov endpoints the vanilla client uses, plus the
// deployed site's /api helpers (conditions, changelog) which soft-fail when
// unavailable (standalone dev).

import { OFFICE_COORDS, OFFICE_STATES, OFFICE_SENDER } from '../../../docs/js/offices.js';

const HEADERS = { 'User-Agent': 'Plaincast/1.0 (plaincast.live; shadcn edition)' };

// AFD product list, cached for 60s per office (shared by loads, the editions
// selector, and refresh polling — same shape as app.js fetchAFDListShared).
let afdListCache = { office: null, time: 0, graph: null };

export async function fetchAFDList(office, { force = false } = {}) {
    if (!force && afdListCache.office === office && afdListCache.graph
        && Date.now() - afdListCache.time < 60 * 1000) {
        return afdListCache.graph;
    }
    const res = await fetch(`https://api.weather.gov/products/types/AFD/locations/${office}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`NWS API error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const graph = data['@graph'] || [];
    afdListCache = { office, time: Date.now(), graph };
    return graph;
}

export function historyItems(graph, limit = 10) {
    return graph.slice(0, limit).map(item => ({
        id: item.id,
        url: item['@id'] || `https://api.weather.gov/products/${item.id}`,
        time: new Date(item.issuanceTime),
    }));
}

export async function fetchProduct(url) {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`NWS API error: ${res.status} ${res.statusText}`);
    return res.json();
}

// Latest AFD product (full text) for an office, plus its list metadata.
export async function fetchLatestAFD(office, { force = false } = {}) {
    const graph = await fetchAFDList(office, { force });
    if (!graph.length) throw new Error('No forecast discussions found for this office.');
    const latest = graph[0];
    const prodUrl = latest['@id'] || `https://api.weather.gov/products/${latest.id}`;
    const product = await fetchProduct(prodUrl);
    return { product, rawUrl: prodUrl, list: graph };
}

// Active alerts for the office's state, filtered to this office's sender
// name. Returns { alerts, severe } — `severe` is an active Severe/Extreme
// Warning (tightens the refresh poll, same as the vanilla client).
export async function fetchAlerts(office) {
    const state = OFFICE_STATES[office];
    if (!state) return { alerts: [], severe: false };
    try {
        const res = await fetch(`https://api.weather.gov/alerts/active?area=${state}`, {
            headers: HEADERS,
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return { alerts: [], severe: false };
        const data = await res.json();
        const senderMatch = OFFICE_SENDER[office] || '';
        const alerts = [];
        for (const f of (data.features || [])) {
            const p = f.properties;
            if (senderMatch && !(p.senderName || '').includes(senderMatch)) continue;
            alerts.push({
                id: p.id || f.id || '',
                event: p.event || '',
                headline: p.headline || p.event || '',
                description: p.description || '',
                instruction: p.instruction || '',
                severity: p.severity || '',
                onset: p.onset || '',
                ends: p.ends || '',        // event end — expires is only the message expiry
                expires: p.expires || '',
                areaDesc: p.areaDesc || '',
            });
        }
        const order = { warning: 0, watch: 1, advisory: 2, statement: 3 };
        alerts.sort((a, b) => order[classifyAlertKind(a.event)] - order[classifyAlertKind(b.event)]);
        const severe = alerts.some(a =>
            /warning/i.test(a.event) && /severe|extreme/i.test(a.severity));
        return { alerts, severe };
    } catch (e) {
        console.debug('Alert fetch failed', e);
        return { alerts: [], severe: false };
    }
}

// One row per distinct (event, end time): a tropical system puts the same
// "Tropical Storm Watch until 1:00 PM" on every zone (HFO listed 38 rows, 19
// of them one watch). Groups keep first-seen order (fetchAlerts already sorts
// warnings first); the lead alert's fields stand for the group, `members`
// keeps every alert, `areas` is the de-duplicated zone list and
// `descriptions` the distinct texts (usually one).
export function alertGroupKey(alert) {
    return `${alert.event || ''}|${alert.ends || alert.expires || ''}`;
}

export function groupAlerts(alerts) {
    const groups = new Map();
    for (const a of alerts || []) {
        const key = alertGroupKey(a);
        let g = groups.get(key);
        if (!g) {
            g = { ...a, key, count: 0, members: [], areas: [], descriptions: [] };
            groups.set(key, g);
        }
        g.count++;
        g.members.push(a);
        for (const area of String(a.areaDesc || '').split(';').map(s => s.trim()).filter(Boolean)) {
            if (!g.areas.includes(area)) g.areas.push(area);
        }
        const text = (a.description || a.headline || '').trim();
        if (text && !g.descriptions.includes(text)) g.descriptions.push(text);
    }
    return [...groups.values()];
}

// Warning → warning, Watch → watch, Statement → statement, everything else →
// advisory (same default as the vanilla client's classifyAlertKind).
export function classifyAlertKind(eventName) {
    const e = eventName || '';
    if (/warning/i.test(e)) return 'warning';
    if (/watch/i.test(e)) return 'watch';
    if (/statement/i.test(e)) return 'statement';
    return 'advisory';
}

// An ISO instant as a short local clock: 'Thu 8:00 PM', or '8:00 PM' when it
// falls on the same local day as `nowMs`. '' for a falsy/unparseable instant.
export function formatAlertTime(iso, tz, nowMs = Date.now()) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const zone = tz || 'America/Los_Angeles';
    const dayOf = (ms) => new Intl.DateTimeFormat('en-US',
        { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(ms));
    const time = new Intl.DateTimeFormat('en-US',
        { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(d);
    if (dayOf(d.getTime()) === dayOf(nowMs)) return time;
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(d);
    return `${wd} ${time}`;
}

// The alert's time window: future onset → 'starts X → until Y'; already in
// effect → 'until Y'; nothing to show → null. (The vanilla formatUntilCell
// distinction the first shadcn pass lost.)
export function alertWindow(alert, tz, nowMs = Date.now()) {
    const end = formatAlertTime(alert.ends || alert.expires || '', tz, nowMs);
    if (!end) return null;
    const onsetMs = alert.onset ? new Date(alert.onset).getTime() : NaN;
    if (!isNaN(onsetMs) && onsetMs > nowMs) {
        return { upcoming: true, label: `${formatAlertTime(alert.onset, tz, nowMs)} → ${end}` };
    }
    return { upcoming: false, label: `until ${end}` };
}

// ─── Deployed-site helpers (soft-fail off-platform) ─────────────────

export async function fetchConditions(office) {
    try {
        const res = await fetch(`/api/conditions?office=${office}`);
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        return null;
    }
}

export async function fetchChangelog(office) {
    try {
        const res = await fetch(`/api/changelog?office=${office}`);
        if (!res.ok) return null;
        const data = await res.json();
        return data && data.changelog ? data : null;
    } catch (e) {
        return null;
    }
}

// ─── Geolocation → nearest office ───────────────────────────────────

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function findNearestOffice(lat, lon) {
    let best = null;
    let bestDist = Infinity;
    for (const [code, [olat, olon]] of Object.entries(OFFICE_COORDS)) {
        const d = haversineDistance(lat, lon, olat, olon);
        if (d < bestDist) { bestDist = d; best = code; }
    }
    return best;
}
