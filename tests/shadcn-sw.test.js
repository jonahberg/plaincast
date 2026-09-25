// ─── shadcn service worker (shadcn/public/sw.js, deployed at /sw.js) ──
// tests/sw.test.js covers the legacy docs/sw.js; this drives the deployed
// worker in a vm with an in-memory Cache API. Plain objects stand in for
// navigation requests (the Request constructor forbids mode:'navigate') and
// for responses (Bun's Response.type is 'default', never 'basic').

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ORIGIN = 'https://plaincast.live';
const SRC = readFileSync(new URL('../shadcn/public/sw.js', import.meta.url), 'utf8');

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

function load(fetchImpl) {
    const listeners = {};
    const caches = makeCaches();
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
    vm.runInContext(SRC, context);
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
    it('bumps the cache namespace past v2 (release rule)', () => {
        expect(SRC).not.toContain("'plaincast-shadcn-v2'");
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

    it('precaches / and the built assets on install', async () => {
        const fetched = [];
        const { listeners, caches } = load(async (path) => { fetched.push(path); return res(200, path); });
        const waits = [];
        listeners.install({ waitUntil: (p) => waits.push(p) });
        await Promise.all(waits);
        expect(fetched).toEqual(expect.arrayContaining(['/', '/assets/app.js', '/assets/vendor.js', '/assets/app.css']));
        const shell = [...caches.stores.values()][0];
        expect(shell.has(`${ORIGIN}/`)).toBe(true);
        expect(shell.has(`${ORIGIN}/assets/app.js`)).toBe(true);
    });

    it('install survives a missing precache file', async () => {
        const { listeners } = load(async (path) => (path === '/assets/vendor.js' ? res(404) : res(200, path)));
        const waits = [];
        listeners.install({ waitUntil: (p) => waits.push(p) });
        await expect(Promise.all(waits)).resolves.toBeDefined();
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
