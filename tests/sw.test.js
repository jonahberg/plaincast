import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadServiceWorker(fetchImpl = () => Promise.resolve(new Response('ok'))) {
    const listeners = {};
    const context = {
        URL,
        Response,
        fetch: fetchImpl,
        caches: {
            open() {
                throw new Error('cache should not be used for this request');
            },
            keys: async () => [],
            match: async () => undefined,
            delete: async () => true,
        },
        self: {
            addEventListener(type, handler) {
                listeners[type] = handler;
            },
            skipWaiting: async () => {},
            clients: { claim: async () => {} },
        },
    };
    vm.createContext(context);
    vm.runInContext(readFileSync('docs/sw.js', 'utf8'), context);
    return listeners;
}

describe('service worker fetch handling', () => {
    it('passes non-GET requests straight to the network without caching', async () => {
        const requests = [];
        const listeners = loadServiceWorker(async (request) => {
            requests.push(request);
            return new Response('translated');
        });
        let responsePromise;

        listeners.fetch({
            request: new Request('https://plaincast.live/api/translate', { method: 'POST' }),
            respondWith(promise) {
                responsePromise = promise;
            },
        });

        const response = await responsePromise;
        expect(await response.text()).toBe('translated');
        expect(requests).toHaveLength(1);
        expect(requests[0].method).toBe('POST');
    });
});

// Release rule (CLAUDE.md): while the legacy client stays committed, its
// worker precaches every module docs/js/app.js loads, so an offline start
// never meets a module it does not hold (Nov 18 2026: app.js now imports
// untranslatable.js, which imports tabular.js).
describe('legacy worker precache', () => {
    it('APP_SHELL lists every module app.js imports, transitively', () => {
        const sw = readFileSync('docs/sw.js', 'utf8');
        const shell = sw.match(/const APP_SHELL = \[([\s\S]*?)\];/)[1];
        const seen = new Set();
        const walk = (name) => {
            if (seen.has(name)) return;
            seen.add(name);
            const src = readFileSync(`docs/js/${name}`, 'utf8');
            for (const m of src.matchAll(/^import [^;]*? from '\.\/([\w-]+\.js)';/gm)) walk(m[1]);
        };
        walk('app.js');
        expect(seen.has('untranslatable.js')).toBe(true);
        for (const name of seen) expect(shell).toContain(`'/js/${name}'`);
    });
});
