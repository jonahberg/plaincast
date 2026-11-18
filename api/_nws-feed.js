// The poller's api.weather.gov calls (api/cron-refresh.js). Kept apart from
// _utils.js, whose fetchers throw a bare Error: the poller must tell a
// throttle (403/429), a timeout or a 5xx ("try next run") from a product
// that is gone (404).
//
// Measured Nov 18 2026: `/products?type=AFD&start=<ISO>` filters on
// issuanceTime, returns newest first, has no pagination and is small (30
// items, 1.4 KB compressed for 20 minutes; 635 items for 24 hours). Never
// pass `limit`: it truncates silently. `/products/types/AFD` is the 7-day
// list (about 4,500 items, 165 KB compressed, 0.3-0.4 s), used for a cold
// start and a periodic reconcile.
//
// Files prefixed with `_` are not treated as endpoints by Vercel.

// The same User-Agent as _utils.js (NWS asks every client to identify itself).
export const NWS_USER_AGENT = 'Plaincast/1.0 (plaincast.live)';
const BASE = 'https://api.weather.gov';

export class NwsError extends Error {
    constructor(message, { status = 0, retryable = true } = {}) {
        super(message);
        this.name = 'NwsError';
        this.status = status;
        this.retryable = retryable;
        // 403/429: api.weather.gov throttles datacenter IPs. Stop asking
        // for the rest of this run rather than dig the hole deeper.
        this.throttled = status === 403 || status === 429;
    }
}

async function getJson(url, { timeoutMs }) {
    let res;
    try {
        res = await fetch(url, {
            headers: { 'User-Agent': NWS_USER_AGENT, Accept: 'application/ld+json' },
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        throw new NwsError(timeout ? 'timeout' : `network: ${err?.message || err}`, { status: 0, retryable: true });
    }
    if (!res.ok) {
        throw new NwsError(`NWS ${res.status}`, { status: res.status, retryable: res.status !== 404 && res.status !== 400 });
    }
    try {
        return await res.json();
    } catch {
        throw new NwsError('bad json', { status: res.status, retryable: true });
    }
}

const graph = (data) => (Array.isArray(data?.['@graph']) ? data['@graph'] : null);

// AFDs issued at or after `startIso`, all offices, newest first.
export async function fetchAFDsSince(startIso, { timeoutMs = 10000 } = {}) {
    const items = graph(await getJson(`${BASE}/products?type=AFD&start=${encodeURIComponent(startIso)}`, { timeoutMs }));
    if (!items) throw new NwsError('listing without @graph', { retryable: true });
    return items;
}

// The 7-day AFD list, all offices, newest first.
export async function fetchAFDWeek({ timeoutMs = 20000 } = {}) {
    const items = graph(await getJson(`${BASE}/products/types/AFD`, { timeoutMs }));
    if (!items) throw new NwsError('listing without @graph', { retryable: true });
    return items;
}

// One product by id: { id, issuanceTime, productText, ... }.
export async function fetchProductById(id, { timeoutMs = 8000 } = {}) {
    if (typeof id !== 'string' || !/^[\w.:-]{1,64}$/.test(id)) throw new NwsError('bad id', { retryable: false });
    return getJson(`${BASE}/products/${id}`, { timeoutMs });
}
