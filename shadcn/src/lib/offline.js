// ─── Last-edition cache ─────────────────────────────────────────────
// The last successfully loaded edition per office, in localStorage, so a
// failed fetch (offline, NWS outage) can still show "the last edition you
// read" — the vanilla client's offline story. The service worker handles
// the app shell; this handles the data.

const KEY_PREFIX = 'plaincast-last-edition-';
const MAX_OFFICES = 6; // a handful of offices, not an archive

export function saveLastEdition(office, payload) {
    try {
        localStorage.setItem(KEY_PREFIX + office, JSON.stringify({ ...payload, savedAt: Date.now() }));
        // Evict oldest beyond the cap
        const entries = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k?.startsWith(KEY_PREFIX)) {
                try { entries.push([k, JSON.parse(localStorage.getItem(k)).savedAt || 0]); }
                catch (e) { entries.push([k, 0]); }
            }
        }
        entries.sort((a, b) => b[1] - a[1]);
        for (const [k] of entries.slice(MAX_OFFICES)) localStorage.removeItem(k);
    } catch (e) { /* quota / private mode — cache is best-effort */ }
}

export function loadLastEdition(office) {
    try {
        const raw = localStorage.getItem(KEY_PREFIX + office);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}
