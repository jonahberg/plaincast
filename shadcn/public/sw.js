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
//   /assets/*    → network-first with cache fallback (the names are STABLE,
//                  not content-hashed — the committed SSR shell references
//                  them — so cache-first would pin stale code). The shell and
//                  its assets are precached on install so the first visit
//                  already works offline.
//   api.weather.gov GETs → network-first with cache fallback, so the last
//                  fetched forecast still renders offline; its own cache is
//                  capped at NWS_MAX entries (oldest evicted first).
const CACHE = 'plaincast-shadcn-v3';
const NWS_CACHE = 'plaincast-shadcn-nws-v3';
const NWS_MAX = 60;
const PRECACHE = ['/', '/assets/app.js', '/assets/vendor.js', '/assets/app.css', '/theme-init.js'];
const SHELL_PATH = /^\/(?:o\/[A-Z]{3}\/)?$/;

self.addEventListener('install', (event) => {
    // allSettled, not addAll: one missing file must not fail the install
    // (a worker that never installs never takes over the old one).
    event.waitUntil(
        caches.open(CACHE)
            .then(c => Promise.allSettled(PRECACHE.map(path =>
                fetch(path, { cache: 'no-cache' }).then(res => (isCacheable(res) ? c.put(path, res) : null))
            )))
            .then(() => self.skipWaiting())
    );
});

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
            fetch(request)
                .then(res => {
                    if (res.ok) {
                        const copy = res.clone();
                        event.waitUntil(caches.open(CACHE).then(c => c.put(url.pathname, copy)));
                    }
                    return res;
                })
                .catch(() => caches.match(url.pathname, { cacheName: CACHE }).then(hit => hit || Response.error()))
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
