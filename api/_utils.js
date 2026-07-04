// Shared helpers for NWS API requests. Files prefixed with `_` are not
// treated as endpoints by Vercel, so this module is server-only.

const NWS_USER_AGENT = 'Plaincast/1.0 (plaincast.live)';

export async function fetchAFDList(office, { signal } = {}) {
    const res = await fetch(`https://api.weather.gov/products/types/AFD/locations/${office}`, {
        headers: { 'User-Agent': NWS_USER_AGENT },
        signal
    });
    if (!res.ok) throw new Error(`NWS API error: ${res.status}`);
    const data = await res.json();
    return Array.isArray(data?.['@graph']) ? data['@graph'] : [];
}

export async function fetchAFDProduct(prodUrl, { signal } = {}) {
    if (typeof prodUrl !== 'string' || !prodUrl.startsWith('https://api.weather.gov/')) {
        throw new Error('Unexpected product URL');
    }
    const res = await fetch(prodUrl, {
        headers: { 'User-Agent': NWS_USER_AGENT },
        signal
    });
    if (!res.ok) throw new Error(`NWS API error: ${res.status}`);
    return res.json();
}

export function productUrlFromItem(item) {
    return item?.['@id'] || (item?.id ? `https://api.weather.gov/products/${item.id}` : null);
}

// Fetch one alert by its URN id. Returns the properties object or null when
// the alert doesn't exist (expired/cancelled ids 404 at NWS).
export async function fetchAlertById(id, { signal } = {}) {
    const res = await fetch(`https://api.weather.gov/alerts/${encodeURIComponent(id)}`, {
        headers: { 'User-Agent': NWS_USER_AGENT },
        signal
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`NWS API error: ${res.status}`);
    const data = await res.json();
    return data?.properties || null;
}
