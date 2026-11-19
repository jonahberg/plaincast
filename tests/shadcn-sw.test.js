// ─── shadcn service worker (shadcn/public/sw.js, deployed at /sw.js) ──
// tests/sw.test.js covers the legacy docs/sw.js; this drives the deployed
// worker in a vm with an in-memory Cache API. Plain objects stand in for
// navigation requests (the Request constructor forbids mode:'navigate') and
// for responses (Bun's Response.type is 'default', never 'basic').

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { rewriteServiceWorker } from '../scripts/hashed-assets.mjs';

const ORIGIN = 'https://plaincast.live';
const SRC = readFileSync(new URL('../shadcn/public/sw.js', import.meta.url), 'utf8');
// dist/sw.js as scripts/prepare-deploy.mjs writes it: the build's hashed
// assets (entry, CSS, vendor, the four on-demand chunks) in the marker.
const BUILT_ASSETS = [
    '/assets/app-Cwz0-TZT.js', '/assets/app-CUHbm-mr.css', '/assets/vendor-BGxZ6-Lt.js',
    '/assets/sonner-XTRrx761.js', '/assets/ChangelogView-h2GiLrpe.js', '/assets/diff-qH-1lO4j.js',
    '/assets/KbdDialog-CyKALN3B.js',
];
const BUILT = rewriteServiceWorker(SRC, BUILT_ASSETS);
const CACHE_NAME = SRC.match(/const CACHE = '([^']+)'/)[1];

function keyOf(req) {
    return typeof req === 'string' ? new URL(req, ORIGIN).toString() : req.url;
}

function makeCaches() {
    const stores = new Map();
    const open = async (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        const m = stores.get(name);
        return {
            put: async (req, res) => { m.set(keyOf(req), res); },
            match: async (req) => m.get(keyOf(req)),
            delete: async (req) => m.delete(keyOf(req)),
            keys: async () => [...m.keys()].map(url => ({ url })),
        };
    };
    return {
        stores,
        open,
        keys: async () => [...stores.keys()],
        delete: async (name) => stores.delete(name),
        match: async (req, { cacheName } = {}) => {
            const names = cacheName ? [cacheName] : [...stores.keys()];
            for (const n of names) {
                const hit = stores.get(n)?.get(keyOf(req));
                if (hit) return hit;
            }
            return undefined;
        },
    };
}

function res(status, body = '', { type = 'basic', redirected = false } = {}) {
    return { status, ok: status >= 200 && status < 300, type, redirected, body, clone() { return res(status, body, { type, redirected }); } };
}

function load(fetchImpl, src = SRC, caches = makeCaches()) {
    const listeners = {};
    const context = {
        URL,
        Promise,
        Response: { error: () => ({ error: true }) },
        fetch: fetchImpl,
        caches,
        location: new URL(ORIGIN),
        self: {
            addEventListener: (t, h) => { listeners[t] = h; },
            skipWaiting: async () => {},
            clients: { claim: async () => {} },
        },
    };
    vm.createContext(context);
    vm.runInContext(src, context);
    return { listeners, caches };
}

async function dispatch(listeners, request) {
    const waits = [];
    let responded;
    listeners.fetch({
        request,
        respondWith: (p) => { responded = p; },
        waitUntil: (p) => waits.push(p),
    });
    const out = responded ? await responded : undefined;
    await Promise.all(waits);
    return out;
}

const nav = (path) => ({ method: 'GET', mode: 'navigate', url: `${ORIGIN}${path}` });

describe('shadcn service worker', () => {
    it('bumps the cache namespace past v6 (release rule; v7 = hashed assets)', () => {
        expect(SRC).not.toContain("'plaincast-shadcn-v6'");
        expect(SRC).toMatch(/const CACHE = 'plaincast-shadcn-v\d+'/);
    });

    it('caches office-page navigations under their own path, query stripped', async () => {
        const { listeners, caches } = load(async () => res(200, 'LOT page'));
        await dispatch(listeners, nav('/o/LOT/?edition=abc'));
        const shell = [...caches.stores.values()][0];
        expect([...shell.keys()]).toEqual([`${ORIGIN}/o/LOT/`]);
    });

    it('never caches a 404, a redirect, or a non-shell page', async () => {
        const responses = { '/o/ZZZ/': res(404, 'nope'), '/': res(200, 'x', { redirected: true }), '/about': res(200, 'about') };
        const { listeners, caches } = load(async (r) => responses[new URL(r.url).pathname]);
        for (const p of Object.keys(responses)) await dispatch(listeners, nav(p));
        const total = [...caches.stores.values()].reduce((n, m) => n + m.size, 0);
        expect(total).toBe(0);
    });

    it('offline: serves the exact page, else the cached / shell', async () => {
        let online = true;
        const { listeners } = load(async (r) => {
            if (!online) throw new TypeError('offline');
            return res(200, `page ${new URL(r.url).pathname}`);
        });
        await dispatch(listeners, nav('/'));
        await dispatch(listeners, nav('/o/HFO/'));
        online = false;
        expect((await dispatch(listeners, nav('/o/HFO/'))).body).toBe('page /o/HFO/');
        expect((await dispatch(listeners, nav('/o/LOT/'))).body).toBe('page /');
        expect((await dispatch(listeners, nav('/about'))).body).toBe('page /');
    });

    it('source worker (vite preview, un-rewritten): precaches only / and /theme-init.js', async () => {
        const fetched = [];
        const { listeners, caches } = load(async (path) => { fetched.push(path); return res(200, path); });
        const waits = [];
        listeners.install({ waitUntil: (p) => waits.push(p) });
        await Promise.all(waits);
        expect(fetched.sort()).toEqual(['/', '/theme-init.js']);
        const shell = [...caches.stores.values()][0];
        expect(shell.has(`${ORIGIN}/`)).toBe(true);
    });

    it('deployed worker precaches the shell and every hashed asset, on-demand chunks included', async () => {
        const fetched = [];
        const { listeners, caches } = load(async (path) => { fetched.push(path); return res(200, path); }, BUILT);
        const waits = [];
        listeners.install({ waitUntil: (p) => waits.push(p) });
        await Promise.all(waits);
        expect(fetched.sort()).toEqual(['/', '/theme-init.js', ...BUILT_ASSETS].sort());
        const shell = [...caches.stores.values()][0];
        for (const a of BUILT_ASSETS) expect(shell.has(`${ORIGIN}${a}`)).toBe(true);
        for (const lazy of ['ChangelogView', 'KbdDialog', 'sonner', 'diff']) {
            expect(BUILT_ASSETS.some(a => a.startsWith(`/assets/${lazy}-`))).toBe(true);
        }
    });

    it('install does not refetch a hashed asset it already holds (unchanged vendor)', async () => {
        const caches = makeCaches();
        const kept = res(200, 'old vendor bytes');
        await (await caches.open(CACHE_NAME)).put('/assets/vendor-BGxZ6-Lt.js', kept);
        const fetched = [];
        const { listeners } = load(async (path) => { fetched.push(path); return res(200, path); }, BUILT, caches);
        const waits = [];
        listeners.install({ waitUntil: (p) => waits.push(p) });
        await Promise.all(waits);
        expect(fetched).not.toContain('/assets/vendor-BGxZ6-Lt.js');
        expect(fetched).toContain('/assets/app-Cwz0-TZT.js');
    });

    it('install survives a missing precache file', async () => {
        const { listeners } = load(async (path) => (path === '/assets/vendor-BGxZ6-Lt.js' ? res(404) : res(200, path)), BUILT);
        const waits = [];
        listeners.install({ waitUntil: (p) => waits.push(p) });
        await expect(Promise.all(waits)).resolves.toBeDefined();
    });

    it('/assets/* is cache-first: a cached hashed file is served without the network', async () => {
        let calls = 0;
        const { listeners, caches } = load(async () => { calls++; return res(200, 'net'); });
        const asset = { method: 'GET', mode: 'cors', url: `${ORIGIN}/assets/app-Cwz0-TZT.js` };
        expect((await dispatch(listeners, asset)).body).toBe('net');
        expect(calls).toBe(1);
        expect((await dispatch(listeners, asset)).body).toBe('net');
        expect(calls).toBe(1);
        const shell = [...caches.stores.values()][0];
        expect(shell.has(`${ORIGIN}/assets/app-Cwz0-TZT.js`)).toBe(true);
    });

    it('/assets/*: a 404 (the catch-all\'s HTML) is passed through, never cached', async () => {
        let calls = 0;
        const { listeners, caches } = load(async () => { calls++; return res(404, '<!DOCTYPE html>404'); });
        const asset = { method: 'GET', mode: 'cors', url: `${ORIGIN}/assets/app.js` };
        expect((await dispatch(listeners, asset)).status).toBe(404);
        expect((await dispatch(listeners, asset)).status).toBe(404);
        expect(calls).toBe(2);
        const total = [...caches.stores.values()].reduce((n, m) => n + m.size, 0);
        expect(total).toBe(0);
    });

    it('/assets/* offline with nothing cached: a network error, not a hang', async () => {
        const { listeners } = load(async () => { throw new TypeError('offline'); });
        const out = await dispatch(listeners, { method: 'GET', mode: 'cors', url: `${ORIGIN}/assets/KbdDialog-CyKALN3B.js` });
        expect(out).toEqual({ error: true });
    });

    it('/theme-init.js: network-first, and offline it comes from the precache', async () => {
        let online = true;
        const { listeners, caches } = load(async () => {
            if (!online) throw new TypeError('offline');
            return res(200, 'fresh theme script');
        });
        const req = { method: 'GET', mode: 'no-cors', url: `${ORIGIN}/theme-init.js` };
        expect((await dispatch(listeners, req)).body).toBe('fresh theme script');
        const shell = await caches.open(CACHE_NAME);
        await shell.put('/theme-init.js', res(200, 'precached theme script'));
        expect((await dispatch(listeners, req)).body).toBe('fresh theme script'); // still the network while online
        online = false;
        expect((await dispatch(listeners, req)).body).toBe('precached theme script');
    });

    it('activate deletes the old worker\'s caches (v6, legacy plaincast-v*), keeps its own + NWS', async () => {
        const caches = makeCaches();
        for (const name of ['plaincast-shadcn-v6', 'plaincast-v42', CACHE_NAME, 'plaincast-shadcn-nws-v3']) {
            await (await caches.open(name)).put('/', res(200, name));
        }
        const { listeners } = load(async () => res(200, ''), BUILT, caches);
        const waits = [];
        listeners.activate({ waitUntil: (p) => waits.push(p) });
        await Promise.all(waits);
        expect((await caches.keys()).sort()).toEqual(['plaincast-shadcn-nws-v3', CACHE_NAME].sort());
    });

    it('caps the api.weather.gov cache', async () => {
        const { listeners, caches } = load(async () => res(200, '{}', { type: 'cors' }));
        for (let i = 0; i < 75; i++) {
            await dispatch(listeners, { method: 'GET', mode: 'cors', url: `https://api.weather.gov/products/${i}` });
        }
        const nws = [...caches.stores.entries()].find(([name]) => name.includes('nws'))[1];
        expect(nws.size).toBe(60);
        expect(nws.has('https://api.weather.gov/products/74')).toBe(true);
        expect(nws.has('https://api.weather.gov/products/0')).toBe(false);
    });

    it('passes non-GET requests straight through', async () => {
        const { listeners } = load(async () => { throw new Error('should not fetch'); });
        const out = await dispatch(listeners, { method: 'POST', mode: 'cors', url: `${ORIGIN}/api/translate` });
        expect(out).toBeUndefined();
    });
});
