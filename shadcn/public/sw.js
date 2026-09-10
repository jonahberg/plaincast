// Plaincast shadcn edition — service worker. Deployed at /sw.js, the same
// URL the vanilla client's worker registered, so returning clients update to
// this one on their next visit; activate() below then deletes every cache it
// doesn't own (including the old plaincast-v* precaches).
// Strategies:
//   navigations  → network-first, falling back to the cached shell
//   /assets/*    → network-first with cache fallback (the names are STABLE,
//                  not content-hashed — the committed SSR shell references
//                  them — so cache-first would pin stale code)
//   api.weather.gov GETs → network-first with cache fallback, so the last
//                  fetched forecast still renders offline
const CACHE = 'plaincast-shadcn-v2';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then(res => {
                    const copy = res.clone();
                    event.waitUntil(caches.open(CACHE).then(c => c.put('/', copy)));
                    return res;
                })
                .catch(() => caches.match('/'))
        );
        return;
    }

    if (url.origin === location.origin && url.pathname.startsWith('/assets/')) {
        event.respondWith(
            fetch(request)
                .then(res => {
                    if (res.ok) {
                        const copy = res.clone();
                        event.waitUntil(caches.open(CACHE).then(c => c.put(request, copy)));
                    }
                    return res;
                })
                .catch(() => caches.match(request).then(hit => hit || Response.error()))
        );
        return;
    }

    if (url.hostname === 'api.weather.gov') {
        event.respondWith(
            fetch(request)
                .then(res => {
                    if (res.ok) {
                        const copy = res.clone();
                        event.waitUntil(caches.open(CACHE).then(c => c.put(request, copy)));
                    }
                    return res;
                })
                .catch(() => caches.match(request).then(hit => hit || Response.error()))
        );
    }
});
