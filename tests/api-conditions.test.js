import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OFFICE_NAMES } from '../docs/js/offices.js';

const { default: handler } = await import('../api/conditions.js');

// conditions.js calls the global fetch directly (NWS station observations),
// so we stub globalThis.fetch rather than mock.module. Each test sets `nextObs`
// (the parsed observation JSON) or flips `obsOk`/`fetchThrows`.
let obsOk = true;
let fetchThrows = false;
let nextObs = null;
let lastUrl = null;
const realFetch = globalThis.fetch;

beforeEach(() => {
    obsOk = true;
    fetchThrows = false;
    nextObs = { properties: { temperature: { value: 20 }, textDescription: 'Mostly Cloudy' } };
    lastUrl = null;
    globalThis.fetch = async (url) => {
        lastUrl = String(url);
        if (fetchThrows) throw new Error('network down');
        return { ok: obsOk, json: async () => nextObs };
    };
});
afterEach(() => { globalThis.fetch = realFetch; });

function createRes() {
    return {
        statusCode: 200, headers: {}, body: null, ended: false,
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(d) { this.body = d; this.ended = true; return this; },
        send(d) { this.body = d; this.ended = true; return this; },
        end() { this.ended = true; return this; },
    };
}
const createReq = (query = {}) => ({ method: 'GET', query });

// LOX climate normals, mirrored from api/conditions.js CLIMATE_NORMALS to
// verify the month lookup + delta math without exporting the private table.
const LOX_NORMALS = [68, 68, 68, 71, 72, 77, 83, 85, 83, 78, 72, 67];

describe('GET /api/conditions', () => {
    it('rejects an unknown office with 400', async () => {
        const res = createRes();
        await handler(createReq({ office: 'ZZZ' }), res);
        expect(res.statusCode).toBe(400);
        // `error` keeps its exact string (additive change); the machine-readable
        // siblings are asserted in tests/api-errors.test.js.
        expect(res.body.error).toBe('Invalid office');
        expect(res.body.code).toBe('invalid_office');
    });

    it('converts Celsius observations to rounded Fahrenheit', async () => {
        nextObs = { properties: { temperature: { value: 20 }, textDescription: 'Clear' } };
        const res = createRes();
        await handler(createReq({ office: 'LOX' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.temp).toBe(68); // 20*9/5+32 = 68
        expect(res.body.unit).toBe('F');
        expect(res.body.station).toBe('KLAX');
        expect(res.body.office).toBe('LOX');
        expect(res.body.condition).toBe('Clear');
        expect(lastUrl).toBe('https://api.weather.gov/stations/KLAX/observations/latest');
    });

    it('rounds fractional Celsius conversions to the nearest degree', async () => {
        nextObs = { properties: { temperature: { value: 37 } } }; // 98.6F → 99
        const res = createRes();
        await handler(createReq({ office: 'LOX' }), res);
        expect(res.body.temp).toBe(99);
        // freezing point: 0C → exactly 32F
        nextObs = { properties: { temperature: { value: 0 } } };
        const res2 = createRes();
        await handler(createReq({ office: 'LOX' }), res2);
        expect(res2.body.temp).toBe(32);
    });

    it('looks up the seasonal normal for the current month and computes delta', async () => {
        nextObs = { properties: { temperature: { value: 25 } } }; // 77F
        const res = createRes();
        await handler(createReq({ office: 'LOX' }), res);
        const expectedNormal = LOX_NORMALS[new Date().getMonth()];
        expect(res.body.normal).toBe(expectedNormal);
        expect(res.body.delta).toBe(77 - expectedNormal);
    });

    it('returns null normal/delta for a station office with no climate normals', async () => {
        // PBZ has a station (KPIT) but no CLIMATE_NORMALS entry.
        expect(OFFICE_NAMES.PBZ).toBeTruthy();
        nextObs = { properties: { temperature: { value: 15 } } }; // 59F
        const res = createRes();
        await handler(createReq({ office: 'PBZ' }), res);
        expect(res.body.temp).toBe(59);
        expect(res.body.normal).toBeNull();
        expect(res.body.delta).toBeNull();
    });

    it('returns nulls without fetching for a valid office that has no mapped station', async () => {
        // Locate an office in OFFICE_NAMES but absent from OFFICE_STATIONS by
        // probing: the no-station branch returns before ever calling fetch.
        let noStation = null;
        for (const code of Object.keys(OFFICE_NAMES)) {
            lastUrl = null;
            await handler(createReq({ office: code }), createRes());
            if (lastUrl === null) { noStation = code; break; }
        }
        // If every office maps to a station this branch is unreachable; else
        // confirm it degrades to the null payload without touching the network.
        if (noStation) {
            const res = createRes();
            lastUrl = null;
            await handler(createReq({ office: noStation }), res);
            expect(res.body).toEqual({ temp: null, normal: null, delta: null });
            expect(lastUrl).toBeNull();
        }
    });

    it('degrades to null payload when the observation omits temperature', async () => {
        nextObs = { properties: { temperature: { value: null }, textDescription: 'Foggy' } };
        const res = createRes();
        await handler(createReq({ office: 'LOX' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ temp: null, normal: null, delta: null });
    });

    it('degrades to null payload when the observation has no temperature field', async () => {
        nextObs = { properties: {} };
        const res = createRes();
        await handler(createReq({ office: 'LOX' }), res);
        expect(res.body).toEqual({ temp: null, normal: null, delta: null });
    });

    it('rejects out-of-range temperatures as null (bad sensor)', async () => {
        nextObs = { properties: { temperature: { value: 100 } } }; // 212F, impossible
        const res = createRes();
        await handler(createReq({ office: 'LOX' }), res);
        expect(res.body).toEqual({ temp: null, normal: null, delta: null });
    });

    it('degrades to null payload when the upstream responds non-OK', async () => {
        obsOk = false;
        const res = createRes();
        await handler(createReq({ office: 'LOX' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ temp: null, normal: null, delta: null });
    });

    it('swallows fetch errors and returns the null payload', async () => {
        fetchThrows = true;
        const res = createRes();
        await handler(createReq({ office: 'LOX' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ temp: null, normal: null, delta: null });
    });
});
