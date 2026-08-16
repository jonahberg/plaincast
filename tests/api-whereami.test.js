import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import handler from '../api/whereami.js';

// whereami.js calls the global fetch directly (NWS points API), so we stub
// globalThis.fetch rather than mock.module. Mirrors tests/api-conditions.test.js:
// capture the original in scope, restore in afterEach so nothing leaks into
// the other suites.
const realFetch = globalThis.fetch;
beforeEach(() => {
    globalThis.fetch = realFetch;
});
afterEach(() => {
    globalThis.fetch = realFetch;
});

function mockRes() {
    const res = { headers: {}, code: null, body: null };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.status = (c) => { res.code = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.send = (b) => { res.body = b; return res; };
    res.end = () => res;
    return res;
}

describe('whereami', () => {
    test('missing geo headers -> 204 no-store', async () => {
        const res = mockRes();
        await handler({ method: 'GET', headers: {} }, res);
        expect(res.code).toBe(204);
        expect(res.headers['cache-control']).toBe('no-store');
    });
    test('valid headers -> resolves gridId via points API, covered office -> 200', async () => {
        globalThis.fetch = async (url) => {
            expect(String(url)).toBe('https://api.weather.gov/points/41.8781,-87.6298');
            return new Response(JSON.stringify({ properties: { gridId: 'LOT' } }), { status: 200 });
        };
        const res = mockRes();
        await handler({ method: 'GET', headers: { 'x-vercel-ip-latitude': '41.8781', 'x-vercel-ip-longitude': '-87.6298' } }, res);
        expect(res.code).toBe(200);
        expect(res.body).toEqual({ office: 'LOT', city: 'Chicago' });
        expect(res.headers['cache-control']).toBe('no-store');
    });
    test('uncovered gridId -> 204', async () => {
        globalThis.fetch = async () => new Response(JSON.stringify({ properties: { gridId: 'CYS' } }), { status: 200 });
        const res = mockRes();
        await handler({ method: 'GET', headers: { 'x-vercel-ip-latitude': '41.1', 'x-vercel-ip-longitude': '-104.8' } }, res);
        expect(res.code).toBe(204);
    });
    test('garbage headers -> 204 without fetching', async () => {
        globalThis.fetch = async () => { throw new Error('must not fetch'); };
        const res = mockRes();
        await handler({ method: 'GET', headers: { 'x-vercel-ip-latitude': 'abc', 'x-vercel-ip-longitude': '1e99' } }, res);
        expect(res.code).toBe(204);
    });
});
