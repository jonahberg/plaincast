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

// National Severe/Extreme feed. `limit` is not a valid param on this
// endpoint (verified 2026-08-15) — callers slice.
export async function fetchSevereAlerts({ signal } = {}) {
    const res = await fetch('https://api.weather.gov/alerts/active?status=actual&severity=Severe,Extreme&region_type=land', {
        headers: { 'User-Agent': NWS_USER_AGENT }, signal
    });
    if (!res.ok) throw new Error(`NWS API error: ${res.status}`);
    const data = await res.json();
    return Array.isArray(data?.features) ? data.features : [];
}

// Nationwide total (all severities). Grouped by state upstream, so only
// `total` is usable — event classes come from fetchSevereAlerts. Soft: null
// on any failure, the census renders without the total.
export async function fetchAlertTotals({ signal } = {}) {
    try {
        const res = await fetch('https://api.weather.gov/alerts/active/count', {
            headers: { 'User-Agent': NWS_USER_AGENT }, signal
        });
        if (!res.ok) return null;
        const data = await res.json();
        return Number.isFinite(data?.total) ? { total: data.total } : null;
    } catch { return null; }
}

// Latest SPC Day 1 Convective Outlook, listing + product in two hops.
export async function fetchSpcDy1({ signal } = {}) {
    const res = await fetch('https://api.weather.gov/products/types/SWO/locations/DY1', {
        headers: { 'User-Agent': NWS_USER_AGENT }, signal
    });
    if (!res.ok) throw new Error(`NWS API error: ${res.status}`);
    const data = await res.json();
    const url = productUrlFromItem((data?.['@graph'] || [])[0]);
    if (!url) return null;
    const prod = await fetchAFDProduct(url, { signal });
    const productText = typeof prod?.productText === 'string' ? prod.productText : null;
    return productText ? { productText, issuanceTime: prod?.issuanceTime || null } : null;
}
