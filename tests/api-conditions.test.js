import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { OFFICE_NAMES, OFFICE_STATIONS, OFFICE_TIMEZONES } from '../docs/js/offices.js';
import { CLIMATE_NORMALS } from '../api/_climate-normals.js';

const { default: handler, metarTempC, observationTempC, monthIn, FALLBACK_MAX_AGE_MS, AWC_METAR } = await import('../api/conditions.js');

// conditions.js calls the global fetch directly (NWS station observations),
// so we stub globalThis.fetch rather than mock.module. Each test sets `nextObs`
// (the parsed observation JSON) or flips `obsOk`/`fetchThrows`.
let obsOk = true;
let fetchThrows = false;
let nextObs = null;
let nextList = { features: [] };
let nextAwc = [];
let lastUrl = null;
const realFetch = globalThis.fetch;

beforeEach(() => {
    obsOk = true;
    fetchThrows = false;
    nextObs = { properties: { temperature: { value: 20 }, textDescription: 'Mostly Cloudy' } };
    nextList = { features: [] };
    nextAwc = [];
    lastUrl = null;
    globalThis.fetch = async (url) => {
        lastUrl = String(url);
        if (fetchThrows) throw new Error('network down');
        if (String(url).includes('/observations?limit=')) return { ok: obsOk, json: async () => nextList };
        if (String(url).startsWith(AWC_METAR)) return { ok: obsOk, json: async () => nextAwc };
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

// The generated NCEI table (api/_climate-normals.js); the month is the
// office's own, not the server's.
const LOX_NORMALS = CLIMATE_NORMALS.LOX;
// Nov 18 2026: the normal does not depend on the reading. A failed or empty
// station read keeps "Normal high" (only "Now" and the delta go).
const loxNoReading = () => ({ temp: null, normal: LOX_NORMALS[monthIn(OFFICE_TIMEZONES.LOX)], delta: null });

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
        const expectedNormal = LOX_NORMALS[monthIn(OFFICE_TIMEZONES.LOX)];
        expect(res.body.normal).toBe(expectedNormal);
        expect(res.body.delta).toBe(77 - expectedNormal);
    });

    it('the normal uses the office\'s own month (Guam is a day ahead at month ends)', async () => {
        fetchThrows = true;
        const res = createRes();
        await handler(createReq({ office: 'GUM' }), res);
        expect(res.body).toEqual({ temp: null, normal: CLIMATE_NORMALS.GUM[monthIn(OFFICE_TIMEZONES.GUM)], delta: null });
    });

    it('an office with no normal and no reading answers all nulls', async () => {
        fetchThrows = true;
        const res = createRes();
        await handler(createReq({ office: 'CTP' }), res);
        expect(res.body).toEqual({ temp: null, normal: null, delta: null });
    });

    it('returns null normal/delta for a station office with no climate normals', async () => {
        // CTP reads KUNV, which has no NCEI 1991-2020 normal (see the
        // generated table's header), so it has no CLIMATE_NORMALS entry.
        expect(OFFICE_STATIONS.CTP).toBe('KUNV');
        expect(CLIMATE_NORMALS.CTP).toBeUndefined();
        nextObs = { properties: { temperature: { value: 15 } } }; // 59F
        const res = createRes();
        await handler(createReq({ office: 'CTP' }), res);
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

    it('no recent observation has a temperature: no reading, the normal stays', async () => {
        nextObs = { properties: { temperature: { value: null }, textDescription: 'Foggy' } };
        const res = createRes();
        await handler(createReq({ office: 'LOX' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(loxNoReading());
    });

    it('the observation has no temperature field: no reading, the normal stays', async () => {
        nextObs = { properties: {} };
        const res = createRes();
        await handler(createReq({ office: 'LOX' }), res);
        expect(res.body).toEqual(loxNoReading());
    });

    it('rejects out-of-range temperatures as no reading (bad sensor); the normal stays', async () => {
        nextObs = { properties: { temperature: { value: 100 } } }; // 212F, impossible
        const res = createRes();
        await handler(createReq({ office: 'LOX' }), res);
        expect(res.body).toEqual(loxNoReading());
    });

    it('the upstream responds non-OK: no reading, the normal stays', async () => {
        obsOk = false;
        const res = createRes();
        await handler(createReq({ office: 'LOX' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(loxNoReading());
    });

    it('swallows fetch errors: no reading, the normal stays', async () => {
        fetchThrows = true;
        const res = createRes();
        await handler(createReq({ office: 'LOX' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(loxNoReading());
    });
});

// The Nov 18 2026 OKX/HFO "temp: null" bug, replayed on real responses.
// api.weather.gov nulls a value MADIS has not quality-checked yet (QC "Z")
// although the METAR in rawMessage carries it.
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/conditions/${name}`, import.meta.url), 'utf8'));
const PHNL = fixture('phnl-observations.json').features.map(f => f.properties);
const KJFK = fixture('kjfk-observations.json').features.map(f => f.properties);

describe('conditions: readings the NWS API nulled (QC "Z")', () => {
    it('the METAR parser agrees with every value the API did publish', () => {
        const published = [...PHNL, ...KJFK].filter(p => typeof p.temperature.value === 'number');
        expect(published.length).toBeGreaterThan(10);
        for (const p of published) expect(metarTempC(p.rawMessage)).toBe(p.temperature.value);
    });

    it('recovers every PHNL and KJFK reading the API nulled', () => {
        const nulled = [...PHNL, ...KJFK].filter(p => p.temperature.value === null);
        expect(nulled.length).toBe(11); // 10 at PHNL, 1 at KJFK
        for (const p of nulled) {
            expect(p.temperature.qualityControl).toBe('Z');
            expect(observationTempC(p)).toBeNumber();
        }
        expect(observationTempC(PHNL[0])).toBe(27.8); // "28/18 ... T02780178"
    });

    it('parses the body group when there is no T-group, including below zero', () => {
        expect(metarTempC('KXYZ 181953Z 06009KT 1/2SM R04/2000FT FG M03/M07 A3010 RMK AO2')).toBe(-3);
        expect(metarTempC('KXYZ 181953Z 06009KT 10SM CLR 07/ A3010')).toBe(7);
        expect(metarTempC('KXYZ 181953Z 06009KT 10SM CLR A3010 RMK AO2 T11231167')).toBe(-12.3);
        expect(metarTempC('')).toBeNull();
        expect(metarTempC(null)).toBeNull();
    });

    it('never resurrects a value QC rejected or questioned', () => {
        for (const qc of ['X', 'B', 'Q']) {
            expect(observationTempC({ temperature: { value: null, qualityControl: qc }, rawMessage: PHNL[0].rawMessage })).toBeNull();
        }
    });

    it('serves Honolulu "Now" from the latest observation\'s own METAR', async () => {
        nextObs = { properties: PHNL[0] };
        const res = createRes();
        await handler(createReq({ office: 'HFO' }), res);
        expect(res.body.temp).toBe(82); // 27.8 C
        expect(res.body.station).toBe('PHNL');
        expect(lastUrl).toBe('https://api.weather.gov/stations/PHNL/observations/latest');
    });

    it('falls back to the newest recent observation with a reading', async () => {
        const now = Date.now();
        const at = (msAgo) => new Date(now - msAgo).toISOString();
        nextObs = { properties: { timestamp: at(0), temperature: { value: null, qualityControl: 'X' }, rawMessage: '' } };
        nextList = { features: [
            { properties: { timestamp: at(0), temperature: { value: null, qualityControl: 'X' }, rawMessage: '' } },
            { properties: { timestamp: at(30 * 60e3), temperature: { value: 10, qualityControl: 'V' }, textDescription: 'Clear' } },
            { properties: { timestamp: at(90 * 60e3), temperature: { value: 20, qualityControl: 'V' } } },
        ] };
        const res = createRes();
        await handler(createReq({ office: 'OKX' }), res);
        expect(res.body.temp).toBe(50);
        expect(res.body.condition).toBe('Clear');
        expect(lastUrl).toBe('https://api.weather.gov/stations/KJFK/observations?limit=6');
    });

    it('reads the AWC METAR when api.weather.gov has no observations (NSTU, Pago Pago)', async () => {
        // Live 2026-11-18: /stations/NSTU/observations/latest 404, empty list.
        obsOk = true;
        nextObs = null;
        nextList = { features: [] };
        const obsTime = Math.floor(Date.now() / 1000) - 600;
        nextAwc = [{ icaoId: 'NSTU', obsTime, temp: 30.5, rawOb: 'METAR NSTU 182350Z 13013G18KT 12SM SCT019 31/24 A2986 RMK SLP113 8/100 T03050238 10306 20267 57014' }];
        const res = createRes();
        await handler(createReq({ office: 'PPG' }), res);
        expect(lastUrl).toBe('https://aviationweather.gov/api/data/metar?ids=NSTU&format=json');
        expect(res.body.temp).toBe(87); // 30.5 C
        expect(res.body.station).toBe('NSTU');
        expect(res.body.condition).toBeNull();
        // ...and not when that METAR is stale
        nextAwc = [{ icaoId: 'NSTU', obsTime: obsTime - 3 * 3600, temp: 30.5 }];
        const stale = createRes();
        await handler(createReq({ office: 'PPG' }), stale);
        expect(stale.body).toEqual({ temp: null, normal: CLIMATE_NORMALS.PPG[monthIn(OFFICE_TIMEZONES.PPG)], delta: null });
    });

    it('does not call a reading older than the fallback window "Now"', async () => {
        const old = new Date(Date.now() - FALLBACK_MAX_AGE_MS - 60e3).toISOString();
        nextObs = { properties: { temperature: { value: null, qualityControl: 'X' } } };
        nextList = { features: [{ properties: { timestamp: old, temperature: { value: 10, qualityControl: 'V' } } }] };
        const res = createRes();
        await handler(createReq({ office: 'OKX' }), res);
        expect(res.body).toEqual({ temp: null, normal: CLIMATE_NORMALS.OKX[monthIn(OFFICE_TIMEZONES.OKX)], delta: null });
    });
});

describe('conditions: every office', () => {
    it('has a station', () => {
        for (const code of Object.keys(OFFICE_NAMES)) expect(OFFICE_STATIONS[code]).toMatch(/^[A-Z0-9]{4}$/);
    });

    it('normals are 12 whole-degree months for known offices only', () => {
        for (const [code, months] of Object.entries(CLIMATE_NORMALS)) {
            expect(OFFICE_NAMES[code]).toBeTruthy();
            expect(months.length).toBe(12);
            for (const t of months) expect(Number.isInteger(t)).toBe(true);
        }
    });

    it('picks the month in the office zone (Guam is ahead of UTC at the month edge)', () => {
        const edge = new Date('2026-11-30T20:00:00Z'); // Dec 1, 06:00 in Guam
        expect(monthIn('Pacific/Guam', edge)).toBe(11);
        expect(monthIn('America/Los_Angeles', edge)).toBe(10);
        expect(monthIn('Not/AZone', edge)).toBe(10);
    });
});

describe('GET /api/conditions — repeated query param', () => {
    it('answers ?office=A&office=B (an array) with a 400, not a crash', async () => {
        const res = createRes();
        await handler(createReq({ office: ['LOT', 'OKX'] }), res);
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('invalid_office');
    });
});
