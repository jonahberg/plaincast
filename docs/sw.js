// Plaincast Service Worker — offline-capable weather forecasts
const CACHE_NAME = 'plaincast-v6';
const APP_SHELL = [
    '/',
    '/og-image.png',
    '/styles.css',
    '/js/app.js',
    '/js/glossary.js',
    '/js/offices.js',
    '/js/abbreviations.js',
    '/js/diff.js',
    '/js/timeline.js',
    '/manifest.json',
];

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
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
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
                const fetchPromise = fetch(event.request).then(response => {
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

    // Network-first for API data (NWS, translate)
    if (url.hostname === 'api.weather.gov' || url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(event.request).then(response => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
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
