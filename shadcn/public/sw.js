// Plaincast shadcn edition — service worker. Deployed at /sw.js, the same
// URL the vanilla client's worker registered, so returning clients update to
// this one on their next visit; activate() below then deletes every cache it
// doesn't own (including the old plaincast-v* precaches).
// Strategies:
//   navigations  → network-first. Only the app shell's own pages (`/` and
//                  `/o/CODE/`) are cached, only from a clean 200 same-origin
//                  response, each under its own path (query stripped). A 404,
//                  a redirect, or /about never becomes the offline page.
//                  Offline fallback: that exact page → the cached `/` shell.
//   /assets/*    → cache-first. The names are content-hashed and served
//                  `immutable` (shadcn/vite.config.js, vercel.json): a URL's
//                  bytes never change, so a cached copy is never stale. Only
//                  a clean 200 is stored (a missing asset hits the 404
//                  catch-all, which must never be cached as code). The shell,
//                  /theme-init.js and every asset the app can load (ASSETS)
//                  are precached on install, so the first visit already works
//                  offline, on-demand pieces included. Older builds' hashed
//                  files stay in CACHE until the next CACHE bump (an offline
//                  page cached under an older build still needs them).
//   api.weather.gov GETs → network-first with cache fallback, so the last
//                  fetched forecast still renders offline; its own cache is
//                  capped at NWS_MAX entries (oldest evicted first).
//                  A cached /alerts/active response can hold alerts that
//                  have since expired; the app drops those client-side
//                  (dropExpiredAlerts in src/lib/nws.js), so an offline
//                  reader never sees an expired Warning as live.
const CACHE = 'plaincast-shadcn-v7';
const NWS_CACHE = 'plaincast-shadcn-nws-v3';
const NWS_MAX = 60;
// This build's hashed /assets/* files: the entry, its CSS, vendor and the
// on-demand chunks (changelog view, shortcuts dialog, toasts, diff). The line
// below is the marker scripts/prepare-deploy.mjs replaces in dist/sw.js with
// the list from the Vite manifest (scripts/hashed-assets.mjs). Left empty
// (the source, `vite preview`), only the shell is precached and each asset is
// cached on first use.
const ASSETS = [];
const PRECACHE = ['/', '/theme-init.js', ...ASSETS];
const SHELL_PATH = /^\/(?:o\/[A-Z]{3}\/)?$/;

self.addEventListener('install', (event) => {
    // allSettled, not addAll: one missing file must not fail the install
    // (a worker that never installs never takes over the old one).
    // A hashed asset already cached (unchanged since an earlier build, e.g.
    // vendor) is not fetched again.
    event.waitUntil(
        caches.open(CACHE)
            .then(c => Promise.allSettled(PRECACHE.map(path =>
                (path.startsWith('/assets/') ? c.match(path) : Promise.resolve(undefined))
                    .then(hit => hit || fetch(path, { cache: 'no-cache' })
                        .then(res => (isCacheable(res) ? c.put(path, res) : null)))
            )))
            .then(() => self.skipWaiting())
    );
});

// Deletes every cache this worker does not own: an older plaincast-shadcn-v*
// (and with it the previous release's assets) and the vanilla client's
// plaincast-v* precaches. The NWS data cache is kept.
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== NWS_CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

function isCacheable(res) {
    return Boolean(res) && res.status === 200 && res.type === 'basic' && !res.redirected;
}

// The cache key for a navigation, or null when it isn't an app-shell page.
function shellKey(url) {
    if (url.origin !== location.origin) return null;
    return SHELL_PATH.test(url.pathname) ? url.pathname : null;
}

async function trimCache(name, max) {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    // Cache.keys() is insertion-ordered: the front is the oldest entry.
    for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    if (request.mode === 'navigate') {
        const key = shellKey(url);
        event.respondWith(
            fetch(request)
                .then(res => {
                    if (key && isCacheable(res)) {
                        const copy = res.clone();
                        event.waitUntil(caches.open(CACHE).then(c => c.put(key, copy)));
                    }
                    return res;
                })
                .catch(async () => {
                    const hit = (key && await caches.match(key, { cacheName: CACHE }))
                        || await caches.match('/', { cacheName: CACHE });
                    return hit || Response.error();
                })
        );
        return;
    }

    if (url.origin === location.origin && url.pathname.startsWith('/assets/')) {
        event.respondWith(
            caches.match(url.pathname, { cacheName: CACHE }).then(hit => hit || fetch(request)
                .then(res => {
                    if (isCacheable(res)) {
                        const copy = res.clone();
                        event.waitUntil(caches.open(CACHE).then(c => c.put(url.pathname, copy)));
                    }
                    return res;
                }))
                .catch(() => Response.error())
        );
        return;
    }

    if (url.hostname === 'api.weather.gov') {
        event.respondWith(
            fetch(request)
                .then(res => {
                    if (res.ok) {
                        const copy = res.clone();
                        event.waitUntil(
                            caches.open(NWS_CACHE)
                                .then(c => c.delete(request).then(() => c.put(request, copy)))
                                .then(() => trimCache(NWS_CACHE, NWS_MAX))
                        );
                    }
                    return res;
                })
                .catch(() => caches.match(request, { cacheName: NWS_CACHE }).then(hit => hit || Response.error()))
        );
    }
});
