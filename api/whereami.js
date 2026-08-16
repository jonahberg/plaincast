// Client-side geolocation helper for the National Desk. The desk page itself
// is CDN-cached and geo-agnostic (a server-rendered pointer would bake the
// first visitor's city into the cached body for a whole edge region), so the
// pointer is fetched from here with no-store. IP-level only — no permission
// prompt, no client input trusted: coordinates come from Vercel's headers.
import { OFFICE_NAMES } from '../docs/js/offices.js';

const NWS_USER_AGENT = 'Plaincast/1.0 (plaincast.live)';

function coord(raw, min, max) {
    const n = Number.parseFloat(String(raw || ''));
    return Number.isFinite(n) && n >= min && n <= max ? n.toFixed(4) : null;
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
    const lat = coord(req.headers['x-vercel-ip-latitude'], -90, 90);
    const lon = coord(req.headers['x-vercel-ip-longitude'], -180, 180);
    if (!lat || !lon) return res.status(204).end();
    try {
        const r = await fetch(`https://api.weather.gov/points/${lat},${lon}`, {
            headers: { 'User-Agent': NWS_USER_AGENT },
            signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) return res.status(204).end();
        const data = await r.json();
        const office = data?.properties?.gridId;
        const city = OFFICE_NAMES[office];
        if (!city) return res.status(204).end();
        return res.status(200).json({ office, city });
    } catch {
        return res.status(204).end();
    }
}
