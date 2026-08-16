// Plaincast Service Worker — offline-capable weather forecasts
// Bump on EVERY release that changes docs/* (HTML/CSS/JS contract): the app
// shell is precached cache-first, so a stale CACHE_NAME ships new SSR HTML
// with old CSS to every returning PWA client (v1.1 launch regression).
const CACHE_NAME = 'plaincast-v10';
// Runtime /api/* responses live in their own cache, trimmed FIFO — every
// office/edition URL is a distinct key, so folding them into the app-shell
// cache would grow it without bound.
const RUNTIME_CACHE = 'plaincast-runtime-v8';
const RUNTIME_MAX = 60;
const APP_SHELL = [
    '/',
    '/og-image.png',
    '/styles.css',
    '/js/theme-init.js',
    '/js/app.js',
    '/js/glossary.js',
    '/js/offices.js',
    '/js/abbreviations.js',
    '/js/diff.js',
    '/js/timeline.js',
    '/manifest.json',
];

// Put into a named cache, evicting oldest entries past `max` (FIFO —
// Cache.keys() preserves insertion order).
async function putWithLimit(cacheName, request, response, max) {
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
    if (max) {
        const keys = await cache.keys();
        if (keys.length > max) {
            await Promise.all(keys.slice(0, keys.length - max).map(k => cache.delete(k)));
        }
    }
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME && k !== RUNTIME_CACHE).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    if (event.request.method !== 'GET') {
        event.respondWith(fetch(event.request));
        return;
    }

    // Cache-first for app shell (HTML, CSS, JS, fonts, images). /o/<CODE>/
    // office pages are the canonical share URLs — offline they get the cached
    // app shell (app.js reads the office from the path).
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/og-image.png'
        || url.pathname === '/styles.css' || url.pathname.startsWith('/js/')
        || url.pathname.startsWith('/fonts/') || /^\/o\/[A-Za-z]{3}\/?$/.test(url.pathname)) {
        event.respondWith(
            caches.match(event.request).then(cached => {
                // `cache: 'reload'` bypasses the browser HTTP cache so the
                // background revalidation actually re-fetches from network —
                // otherwise a returning user runs stale app.js after a deploy.
                const fetchPromise = fetch(event.request, { cache: 'reload' }).then(response => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    }
                    return response;
                }).catch(() => cached);
                if (cached) return cached;
                // Offline /o/ page never seen before: fall back to the cached
                // root shell — same app; the office resolves from the path.
                if (/^\/o\/[A-Za-z]{3}\/?$/.test(url.pathname)) {
                    return fetchPromise.then(r => r || caches.match('/'));
                }
                return fetchPromise;
            })
        );
        return;
    }

    // Network-first for API data (NWS, translate). Cached in the bounded
    // runtime cache (FIFO, RUNTIME_MAX entries) so distinct office/edition
    // URLs can't accumulate forever.
    if (url.hostname === 'api.weather.gov' || url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(event.request).then(response => {
                if (response.ok) {
                    const clone = response.clone();
                    putWithLimit(RUNTIME_CACHE, event.request, clone, RUNTIME_MAX);
                }
                return response;
            }).catch(() => caches.match(event.request))
        );
        return;
    }

    // Default: network with cache fallback
    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
    );
});
