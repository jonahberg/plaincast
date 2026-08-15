import { describe, test, expect, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { officeFromAlert, groupDispatches, buildCensus, parseSpcOutlook } from '../api/_national.js';
import { OFFICE_NAMES } from '../docs/js/offices.js';
// `?real` forces a distinct module instance from the bare '../api/_utils.js'
// specifier. Several other test files call mock.module('../api/_utils.js',
// ...) with stubs that predate these three exports; Bun's module mocks are
// process-global (not file-scoped) and also hijack same-module internal
// cross-references (fetchSpcDy1 -> fetchAFDProduct/productUrlFromItem), so a
// plain import here can silently receive a stale, partially-stubbed module
// depending on file run order. The query-string suffix sidesteps that by
// resolving to a fresh, unmocked instance (_utils.js has no module-level
// state beyond a constant, so double-instantiation is safe).
import { fetchSevereAlerts, fetchAlertTotals, fetchSpcDy1 } from '../api/_utils.js?real';
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

// These three fetchers call the global `fetch` directly (NWS APIs), so we
// stub globalThis.fetch per test rather than mock.module — mirroring the
// save/restore mechanics in tests/api-conditions.test.js. realFetch is
// captured once here and restored after every test so no mock leaks into
// the rest of the suite.
describe('national fetchers', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    test('fetchSevereAlerts hits the exact verified query and unwraps features', async () => {
        let seen;
        globalThis.fetch = async (url) => {
            seen = String(url);
            return new Response(JSON.stringify({ features: [{ properties: { event: 'X' } }] }), { status: 200 });
        };
        const feats = await fetchSevereAlerts({});
        expect(seen).toBe('https://api.weather.gov/alerts/active?status=actual&severity=Severe,Extreme&region_type=land');
        expect(feats.length).toBe(1);
    });

    test('fetchSpcDy1 follows @graph[0]["@id"] and returns text+issuance', async () => {
        globalThis.fetch = async (url) => {
            if (String(url).includes('/products/types/SWO/locations/DY1')) {
                return new Response(JSON.stringify({ '@graph': [{ '@id': 'https://api.weather.gov/products/abc' }] }), { status: 200 });
            }
            return new Response(JSON.stringify({ productText: 'TEXT', issuanceTime: '2026-08-15T19:42:00+00:00' }), { status: 200 });
        };
        const out = await fetchSpcDy1({});
        expect(out.productText).toBe('TEXT');
        expect(out.issuanceTime).toContain('2026');
    });

    test('fetchAlertTotals returns null on non-OK (soft data)', async () => {
        globalThis.fetch = async () => new Response('nope', { status: 503 });
        expect(await fetchAlertTotals({})).toBeNull();
    });
});

// The baked shell is the fail-safe floor for /national/: api/national-desk.js
// string-replaces the #desk-loading marker with SSR content and, on any error,
// serves these exact bytes. These assertions pin the marker contract (drift
// here silently degrades the live page to the shell forever) and the shell's
// standalone value — a typeset index linking all 68 local desks.
// Paths are repo-root-relative, matching the readFileSync in tests/sw.test.js.
describe('national shell', () => {
    const shell = readFileSync('docs/national/index.html', 'utf8');

    test('carries the SSR marker and local-desk slot', () => {
        expect(shell).toContain('<div class="loading" id="desk-loading">Setting the type…</div>');
        expect(shell).toContain('id="local-desk"');
        expect(shell).toContain('src="/js/national.js"');
    });

    test('links every covered office in the desk index', () => {
        for (const code of Object.keys(OFFICE_NAMES)) {
            expect(shell).toContain(`href="/o/${code}/"`);
        }
    });

    test('self-canonical, absolute assets, static OG card', () => {
        expect(shell).toContain('<link rel="canonical" href="https://plaincast.live/national/">');
        expect(shell).toContain('href="/styles.css"');
        expect(shell).toContain('content="https://plaincast.live/og-image.png"');
    });

    test('is excluded from deployment', () => {
        expect(readFileSync('.vercelignore', 'utf8')).toMatch(/^docs\/national$/m);
    });
});
