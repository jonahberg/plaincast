// ─── NWS API client ─────────────────────────────────────────────────
// Same public api.weather.gov endpoints the vanilla client uses.

import { OFFICE_STATES, OFFICE_SENDER } from '@data/offices.js';

const HEADERS = { 'User-Agent': 'Plaincast/1.0 (plaincast.live; shadcn edition)' };

// Latest AFD product (full text) for an office, plus its list metadata.
export async function fetchLatestAFD(office) {
    const res = await fetch(`https://api.weather.gov/products/types/AFD/locations/${office}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`NWS API error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const graph = data['@graph'] || [];
    if (!graph.length) throw new Error('No forecast discussions found for this office.');
    const latest = graph[0];
    const prodUrl = latest['@id'] || `https://api.weather.gov/products/${latest.id}`;
    const prodRes = await fetch(prodUrl, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
    if (!prodRes.ok) throw new Error(`NWS API error: ${prodRes.status} ${prodRes.statusText}`);
    const product = await prodRes.json();
    return { product, rawUrl: prodUrl, list: graph };
}

// Active alerts for the office's state, filtered to this office's sender
// name. Returns a flat array sorted by severity kind.
export async function fetchAlerts(office) {
    const state = OFFICE_STATES[office];
    if (!state) return [];
    try {
        const res = await fetch(`https://api.weather.gov/alerts/active?area=${state}`, {
            headers: HEADERS,
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return [];
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
                ends: p.ends || '',
                expires: p.expires || '',
                areaDesc: p.areaDesc || '',
            });
        }
        const order = { warning: 0, watch: 1, advisory: 2 };
        const kindRank = (e) => {
            const s = e.toLowerCase();
            if (s.includes('warning')) return order.warning;
            if (s.includes('watch')) return order.watch;
            if (s.includes('advisory')) return order.advisory;
            return 3;
        };
        alerts.sort((a, b) => kindRank(a.event) - kindRank(b.event));
        return alerts;
    } catch (e) {
        console.debug('Alert fetch failed', e);
        return [];
    }
}

export function classifyAlertKind(eventName) {
    const s = (eventName || '').toLowerCase();
    if (s.includes('warning')) return 'warning';
    if (s.includes('watch')) return 'watch';
    if (s.includes('advisory')) return 'advisory';
    return 'statement';
}
