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
    test('unknown office code -> 204', async () => {
        globalThis.fetch = async () => new Response(JSON.stringify({ properties: { gridId: 'ZZZ', cwa: 'ZZZ' } }), { status: 200 });
        const res = mockRes();
        await handler({ method: 'GET', headers: { 'x-vercel-ip-latitude': '41.1', 'x-vercel-ip-longitude': '-104.8' } }, res);
        expect(res.code).toBe(204);
    });
    test('resolves the office from cwa, not an Alaska sub-grid gridId', async () => {
        // Live /points/61.2181,-149.9003 (Anchorage), 2026-11-18: gridId AER, cwa AFC.
        globalThis.fetch = async () => new Response(JSON.stringify({ properties: { gridId: 'AER', cwa: 'AFC' } }), { status: 200 });
        const res = mockRes();
        await handler({ method: 'GET', headers: { 'x-vercel-ip-latitude': '61.2181', 'x-vercel-ip-longitude': '-149.9003' } }, res);
        expect(res.code).toBe(200);
        expect(res.body).toEqual({ office: 'AFC', city: 'Anchorage' });
    });
    test('American Samoa has no grid, only a cwa', async () => {
        // Live /points/-14.2756,-170.702 (Pago Pago), 2026-11-18: gridId null, cwa PPG.
        globalThis.fetch = async () => new Response(JSON.stringify({ properties: { gridId: null, cwa: 'PPG' } }), { status: 200 });
        const res = mockRes();
        await handler({ method: 'GET', headers: { 'x-vercel-ip-latitude': '-14.2756', 'x-vercel-ip-longitude': '-170.702' } }, res);
        expect(res.code).toBe(200);
        expect(res.body).toEqual({ office: 'PPG', city: 'Pago Pago' });
    });
    test('garbage headers -> 204 without fetching', async () => {
        globalThis.fetch = async () => { throw new Error('must not fetch'); };
        const res = mockRes();
        await handler({ method: 'GET', headers: { 'x-vercel-ip-latitude': 'abc', 'x-vercel-ip-longitude': '1e99' } }, res);
        expect(res.code).toBe(204);
    });
    test('non-GET method -> 405 no-store without fetching', async () => {
        globalThis.fetch = async () => { throw new Error('must not fetch'); };
        const res = mockRes();
        await handler({ method: 'POST', headers: {} }, res);
        expect(res.code).toBe(405);
        expect(res.headers['cache-control']).toBe('no-store');
    });
});
