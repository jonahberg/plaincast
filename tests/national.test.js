import { describe, test, expect } from 'bun:test';
import { officeFromAlert, groupDispatches, buildCensus, parseSpcOutlook } from '../api/_national.js';
import alerts from './fixtures/national/severe-alerts.json';
import swody1 from './fixtures/national/swody1.json';

const NAMES = { PUB: 'Pueblo', EPZ: 'El Paso', LOT: 'Chicago' };

describe('officeFromAlert', () => {
    test('extracts last-3 office code from AWIPSidentifier', () => {
        expect(officeFromAlert({ parameters: { AWIPSidentifier: ['SVRPUB'] } })).toBe('PUB');
    });
    test('null on missing/short/garbage identifier', () => {
        expect(officeFromAlert({})).toBeNull();
        expect(officeFromAlert({ parameters: { AWIPSidentifier: ['AB'] } })).toBeNull();
        expect(officeFromAlert({ parameters: { AWIPSidentifier: ['SVR12$'] } })).toBeNull();
    });
});

describe('groupDispatches', () => {
    test('warnings only, one row per office, worst first, count aggregated', () => {
        const feats = [
            f('Severe Thunderstorm Warning', 'Severe', 'SVRPUB'),
            f('Severe Thunderstorm Warning', 'Severe', 'SVRPUB'),
            f('Tornado Warning', 'Extreme', 'TORLOT'),
            f('Flood Watch', 'Severe', 'FFAEPZ'), // watch: excluded
        ];
        const rows = groupDispatches(feats, NAMES);
        expect(rows[0]).toEqual({ code: 'LOT', city: 'Chicago', event: 'Tornado Warning', count: 1, extreme: true });
        expect(rows[1]).toEqual({ code: 'PUB', city: 'Pueblo', event: 'Severe Thunderstorm Warning', count: 2, extreme: false });
        expect(rows.length).toBe(2);
    });
    test('uncovered office keeps its dispatch with city null', () => {
        const rows = groupDispatches([f('Severe Thunderstorm Warning', 'Severe', 'SVRCYS')], NAMES);
        expect(rows[0].code).toBe('CYS');
        expect(rows[0].city).toBeNull();
    });
    test('live fixture produces rows without throwing', () => {
        expect(Array.isArray(groupDispatches(alerts.features, NAMES))).toBe(true);
    });
});

describe('buildCensus', () => {
    test('counts by event desc, capped at 6 classes', () => {
        const feats = ['A','A','A','B','B','C','D','E','F','G'].map(e => f(e, 'Severe', 'XXXLOT'));
        const rows = buildCensus(feats);
        expect(rows[0]).toEqual({ event: 'A', count: 3 });
        expect(rows.length).toBe(6);
    });
});

describe('parseSpcOutlook', () => {
    test('extracts headline and summary from live fixture', () => {
        const { headline, summary } = parseSpcOutlook(swody1.productText);
        expect(headline).toMatch(/risk/i);
        expect(summary.length).toBeGreaterThan(80);
        expect(summary).not.toMatch(/\.\.\.SUMMARY\.\.\./);
    });
    test('null-safe on garbage', () => {
        expect(parseSpcOutlook('')).toEqual({ headline: null, summary: null });
        expect(parseSpcOutlook('no structure here')).toEqual({ headline: null, summary: null });
    });
});

function f(event, severity, awips) {
    return { properties: { event, severity, parameters: { AWIPSidentifier: [awips] } } };
}
