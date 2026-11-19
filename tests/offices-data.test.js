// The office roster is generated from NOAA/NWS snapshots
// (scripts/data/*.json → scripts/build-office-data.mjs). These tests pin the
// generated files to the generator, and the data to the rules it was built
// under, so a hand edit or a half-run refresh fails loudly.
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
    OFFICE_NAMES, OFFICE_TIMEZONES, OFFICE_COORDS, OFFICE_STATIONS, OFFICE_STATES, OFFICE_SENDER,
    ISSUING_OFFICE_TO_CODE, officeCodeFromIssuing, alertOfficeCode,
} from '../docs/js/offices.js';
import { OFFICE_GROUPS } from '../shadcn/src/lib/offices-groups.js';
import { CLIMATE_NORMALS } from '../api/_climate-normals.js';
import { buildOfficeData, byName } from '../scripts/build-office-data.mjs';
import { LEGACY } from '../scripts/office-curation.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const snapshot = JSON.parse(read('scripts/data/nws-offices.json'));
const normals = JSON.parse(read('scripts/data/climate-normals.json'));
const codes = Object.keys(OFFICE_NAMES);
const N = codes.length;

describe('generated office data stays in sync with its generator', () => {
    it('docs/js/offices.js, offices-groups.js and _climate-normals.js match (else run `bun scripts/build-office-data.mjs`)', () => {
        for (const [path, text] of Object.entries(buildOfficeData())) {
            expect(readFileSync(path, 'utf8')).toBe(text);
        }
    });
});

describe('the roster', () => {
    it('is every office in the snapshot, i.e. every NWS office with a recent AFD', () => {
        expect([...codes].sort()).toEqual(Object.keys(snapshot.offices).sort());
        expect(N).toBe(snapshot.locationCount - snapshot.excluded.length);
        expect(N).toBe(123);
    });

    it('keeps the 68 launch offices and their display names exactly', () => {
        expect(Object.keys(LEGACY).length).toBe(68);
        for (const [code, [name]] of Object.entries(LEGACY)) expect(OFFICE_NAMES[code]).toBe(name);
    });

    it('gives every office a unique name and a full set of facts', () => {
        expect(new Set(Object.values(OFFICE_NAMES)).size).toBe(N);
        for (const code of codes) {
            expect(code).toMatch(/^[A-Z]{3}$/);
            expect(() => new Intl.DateTimeFormat('en-US', { timeZone: OFFICE_TIMEZONES[code] })).not.toThrow();
            const [lat, lon] = OFFICE_COORDS[code];
            expect(Math.abs(lat)).toBeLessThanOrEqual(90);
            expect(Math.abs(lon)).toBeLessThanOrEqual(180);
            expect(OFFICE_STATIONS[code]).toMatch(/^[A-Z0-9]{4}$/);
            expect(OFFICE_STATES[code]).toMatch(/^[A-Z]{2}$/);
            expect(OFFICE_SENDER[code]).toBeTruthy();
        }
    });

    it('puts non-CONUS offices in their own zones', () => {
        expect(OFFICE_TIMEZONES.AFC).toBe('America/Anchorage');
        expect(OFFICE_TIMEZONES.AFG).toBe('America/Anchorage');
        expect(OFFICE_TIMEZONES.AJK).toBe('America/Juneau');
        expect(OFFICE_TIMEZONES.HFO).toBe('Pacific/Honolulu');
        expect(OFFICE_TIMEZONES.GUM).toBe('Pacific/Guam');
        expect(OFFICE_TIMEZONES.PPG).toBe('Pacific/Pago_Pago');
        expect(OFFICE_TIMEZONES.SJU).toBe('America/Puerto_Rico');
    });

    it('reads each station inside its own office\'s forecast area, from its approved list', () => {
        for (const [code, o] of Object.entries(snapshot.offices)) {
            expect(o.station.id).toBe(OFFICE_STATIONS[code]);
            expect(o.station.pointCwa).toBe(code);
            if (o.office) expect(o.station.inApprovedList).toBe(true);
        }
    });
});

describe('picker and footer groups', () => {
    it('hold every office exactly once, in OFFICE_NAMES order', () => {
        const flat = OFFICE_GROUPS.flatMap(g => g.codes);
        expect(flat).toEqual(codes);
        expect(new Set(flat).size).toBe(N);
    });

    it('are sorted by display name inside each group', () => {
        for (const g of OFFICE_GROUPS) {
            const names = g.codes.map(c => OFFICE_NAMES[c]);
            expect(names).toEqual([...names].sort(byName));
        }
    });
});

describe('issuing-office ids', () => {
    it('map one-to-one onto the roster', () => {
        const values = Object.values(ISSUING_OFFICE_TO_CODE);
        expect(values.sort()).toEqual([...codes].sort());
        expect(new Set(Object.keys(ISSUING_OFFICE_TO_CODE)).size).toBe(N);
        for (const id of Object.keys(ISSUING_OFFICE_TO_CODE)) expect(id).toMatch(/^[A-Z]{4}$/);
    });

    it('resolve the non-CONUS and odd ids from the product data', () => {
        expect(officeCodeFromIssuing('KOKX')).toBe('OKX');
        expect(officeCodeFromIssuing('PAFC')).toBe('AFC');
        expect(officeCodeFromIssuing('PAJK')).toBe('AJK');
        expect(officeCodeFromIssuing('PHFO')).toBe('HFO');
        expect(officeCodeFromIssuing('PGUM')).toBe('GUM');
        expect(officeCodeFromIssuing('TJSJ')).toBe('SJU');
        expect(officeCodeFromIssuing('NSTU')).toBe('PPG');
        expect(officeCodeFromIssuing('KUNR')).toBe('UNR');
        expect(officeCodeFromIssuing(' kokx ')).toBe('OKX');
    });

    it('return null for anything else, without throwing', () => {
        for (const id of ['KWBC', 'OKX', '', null, undefined, 'toString', '__proto__', 42]) {
            expect(officeCodeFromIssuing(id)).toBeNull();
        }
    });

    it('alertOfficeCode reads the WMO heading of an alert', () => {
        expect(alertOfficeCode({ parameters: { WMOidentifier: ['WWUS81 KOKX 181200'] } })).toBe('OKX');
        expect(alertOfficeCode({ parameters: { WMOidentifier: ['WWAK72 PAFC 181740'] } })).toBe('AFC');
        expect(alertOfficeCode({ parameters: { WMOidentifier: ['WWUS00 KWBC 181200'] } })).toBeNull();
        expect(alertOfficeCode({ parameters: {} })).toBeNull();
        expect(alertOfficeCode(null)).toBeNull();
    });
});

describe('climate normals', () => {
    it('come from the same station as "Now", within 10 km of it', () => {
        for (const [code, n] of Object.entries(normals.normals)) {
            expect(n.station).toBe(OFFICE_STATIONS[code]);
            expect(n.distanceKm).toBeLessThanOrEqual(10);
            expect(n.ghcnd).toMatch(/^[A-Z]{2}W\d{8}$/);
            expect(CLIMATE_NORMALS[code]).toEqual(n.tmaxF);
            expect(n.tmaxF).toEqual(n.tmaxRaw.map(v => Math.round(Number(v))));
        }
    });

    it('cover every office except the ones listed as missing, with a reason', () => {
        const have = Object.keys(CLIMATE_NORMALS);
        const missing = Object.keys(normals.missing);
        expect([...have, ...missing].sort()).toEqual([...codes].sort());
        for (const m of Object.values(normals.missing)) expect(m.reason).toBeTruthy();
    });
});

describe('the roster size is stated, not assumed', () => {
    it('every public count matches OFFICE_NAMES', () => {
        expect(read('docs/llms.txt')).toContain(`## Supported NWS Offices (${N}, organized by region)`);
        expect(read('docs/llms.txt')).toContain(`Coverage is ${N} NWS forecast offices`);
        expect(read('docs/openapi.json')).toContain(`for all ${N} National Weather Service forecast offices`);
        expect(read('api/_errors.js')).toContain(`All ${N} codes are listed`);
        expect(read('api/_pages.js')).toContain(`Plaincast covers all ${N} of the National Weather Service`);
        for (const p of ['docs/llms.txt', 'docs/openapi.json', 'api/_errors.js', 'api/_pages.js', 'api/_national-shell.html']) {
            expect(read(p)).not.toMatch(/\b68 (?:NWS |US |covered |forecast |local |codes|offices|supported)/);
        }
    });
});
