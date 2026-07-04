// Plaincast Service Worker — offline-capable weather forecasts
const CACHE_NAME = 'plaincast-v5';
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

    // Cache-first for app shell (HTML, CSS, JS, images)
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/og-image.png'
        || url.pathname === '/styles.css' || url.pathname.startsWith('/js/')) {
        event.respondWith(
            caches.match(event.request).then(cached => {
                const fetchPromise = fetch(event.request).then(response => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    }
                    return response;
                }).catch(() => cached);
                return cached || fetchPromise;
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
