import { describe, test, expect, afterEach } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import {
    officeFromAlert, groupDispatches, buildCensus, parseSpcOutlook,
    parseRiskCategory, parseDiscussionBody, digestArea, formatExpiry, nextOutlookTime,
} from '../api/_national.js';
import { OFFICE_NAMES } from '../docs/js/offices.js';
// `?real` forces a distinct module instance from the bare '../api/_utils.js'
// specifier. Several other test files call mock.module('../api/_utils.js',
// ...) with stubs that predate these four exports; Bun's module mocks are
// process-global (not file-scoped) and also hijack same-module internal
// cross-references (fetchSpcDy1 -> fetchAFDProduct/productUrlFromItem), so a
// plain import here can silently receive a stale, partially-stubbed module
// depending on file run order. The query-string suffix sidesteps that by
// resolving to a fresh, unmocked instance (_utils.js has no module-level
// state beyond a constant, so double-instantiation is safe).
import { fetchSevereAlerts, fetchAlertTotals, fetchSpcDy1, fetchSpcOutlook } from '../api/_utils.js?real';
import alerts from './fixtures/national/severe-alerts.json';
import swody1 from './fixtures/national/swody1.json';
import swody2 from './fixtures/national/swody2.json';
import swody3 from './fixtures/national/swody3.json';

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
        // toMatchObject (not toEqual): rows now also carry raw areaDesc/expires
        // passthrough fields (see the dedicated describe block below) — the
        // code/city/event/count/extreme contract here is unchanged.
        expect(rows[0]).toMatchObject({ code: 'LOT', city: 'Chicago', event: 'Tornado Warning', count: 1, extreme: true });
        expect(rows[1]).toMatchObject({ code: 'PUB', city: 'Pueblo', event: 'Severe Thunderstorm Warning', count: 2, extreme: false });
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
    test('passes through raw areaDesc/expires from the leading warning, unformatted', () => {
        const rows = groupDispatches(
            [f('Severe Thunderstorm Warning', 'Severe', 'SVRPUB', { areaDesc: 'Otero; Crowley', expires: '2026-08-16T01:30:00Z' })],
            NAMES,
        );
        expect(rows[0].areaDesc).toBe('Otero; Crowley');
        expect(rows[0].expires).toBe('2026-08-16T01:30:00Z');
    });
    test('expires falls back to ends; both null when absent', () => {
        const withEnds = groupDispatches([f('Tornado Warning', 'Extreme', 'TORLOT', { ends: '2026-08-16T02:00:00Z' })], NAMES);
        expect(withEnds[0].expires).toBe('2026-08-16T02:00:00Z');
        const withNeither = groupDispatches([f('Tornado Warning', 'Extreme', 'TORLOT')], NAMES);
        expect(withNeither[0].areaDesc).toBeNull();
        expect(withNeither[0].expires).toBeNull();
    });
    test('promotion to a worse warning carries that warning\'s own areaDesc/expires, not the first warning\'s', () => {
        const rows = groupDispatches([
            f('Severe Thunderstorm Warning', 'Severe', 'SVRPUB', { areaDesc: 'FirstArea', expires: '2026-08-16T01:00:00Z' }),
            f('Tornado Warning', 'Extreme', 'SVRPUB', { areaDesc: 'SecondArea', expires: '2026-08-16T02:00:00Z' }),
        ], NAMES);
        expect(rows[0].event).toBe('Tornado Warning');
        expect(rows[0].areaDesc).toBe('SecondArea');
        expect(rows[0].expires).toBe('2026-08-16T02:00:00Z');
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

describe('parseRiskCategory', () => {
    test('extracts level and regions from a THERE-IS headline', () => {
        const r = parseRiskCategory('THERE IS A SLIGHT RISK OF SEVERE THUNDERSTORMS PORTIONS OF THE OHIO VALLEY AND PARTS OF THE CENTRAL HIGH PLAINS');
        expect(r.level).toBe('SLIGHT');
        expect(r.regions).toMatch(/Ohio Valley/i);
    });
    test('all five categorical words map', () => {
        for (const w of ['MARGINAL','SLIGHT','ENHANCED','MODERATE','HIGH']) {
            expect(parseRiskCategory(`THERE IS A ${w} RISK OF SEVERE THUNDERSTORMS SOMEWHERE`).level).toBe(w);
        }
    });
    test('null on no-risk / garbage headlines (calm face)', () => {
        expect(parseRiskCategory('NO SEVERE THUNDERSTORM AREAS FORECAST')).toBeNull();
        expect(parseRiskCategory(null)).toBeNull();
    });
});

describe('parseDiscussionBody', () => {
    test('returns post-SUMMARY prose only, from the live DY1 fixture', () => {
        const paras = parseDiscussionBody(swody1.productText);
        expect(paras.length).toBeGreaterThan(0);
        expect(paras.length).toBeLessThanOrEqual(3);
        const { summary } = parseSpcOutlook(swody1.productText);
        expect(paras[0]).not.toBe(summary);           // never the summary itself
        for (const p of paras) {
            expect(p).not.toMatch(/^\.\.\./);          // no section-header lines
            expect(p.length).toBeGreaterThanOrEqual(40);
        }
    });
    test('empty array when nothing follows the summary', () => {
        expect(parseDiscussionBody('...SUMMARY...\nOnly a summary here with enough length to pass filters.\n$$')).toEqual([]);
        expect(parseDiscussionBody('')).toEqual([]);
    });

    // The live DY1 fixture carries a ".PREV DISCUSSION... /ISSUED 1135 AM/"
    // block: the SUPERSEDED 11:35 AM discussion, republished verbatim under
    // the 20Z update. Rendering it as running copy would print this morning's
    // forecast as this afternoon's news.
    test('stops at the PREV DISCUSSION marker — superseded prose never becomes current copy', () => {
        const paras = parseDiscussionBody(swody1.productText);
        expect(paras.length).toBe(1);
        expect(paras[0]).toMatch(/previous forecast/i);
        const joined = paras.join(' ');
        expect(joined).not.toMatch(/Modestly strong southwesterly/);   // Front Range block, under .PREV
        expect(joined).not.toMatch(/Thunderstorms have generally weakened/); // Midwest block, under .PREV
    });

    test('the PREV marker matches 1-3 dots, any case', () => {
        const body = (mark) => `...SUMMARY...\nA summary paragraph long enough to survive the length filter here.\n\n...20Z Update...\nCurrent prose that is comfortably past the forty character floor.\n\n${mark} /ISSUED 1135 AM CDT/\n\n...Front Range...\nStale prose that is also comfortably past the forty character floor.\n`;
        for (const mark of ['.PREV DISCUSSION...', '..PREV DISCUSSION...', '...PREV DISCUSSION...', '.prev discussion...']) {
            const paras = parseDiscussionBody(body(mark));
            expect(paras.length).toBe(1);
            expect(paras[0]).toMatch(/Current prose/);
            expect(paras.join(' ')).not.toMatch(/Stale prose/);
        }
    });

    test('a PREV marker ahead of the summary leaves nothing to render (fallback path)', () => {
        const text = '.PREV DISCUSSION... /ISSUED 1135 AM CDT/\n...SUMMARY...\nA summary paragraph long enough to survive the length filter.\n\n...Region...\nProse that would otherwise pass every filter in this parser.\n';
        expect(parseDiscussionBody(text)).toEqual([]);
    });
});

describe('digestArea', () => {
    test('two areas + overflow marker', () => {
        expect(digestArea('Otero; Crowley; Pueblo; Las Animas')).toBe('Otero & Crowley +2 more');
        expect(digestArea('Franklin Mountains')).toBe('Franklin Mountains');
        expect(digestArea('A; B')).toBe('A & B');
        expect(digestArea('')).toBeNull();
        expect(digestArea(null)).toBeNull();
    });
});

describe('formatExpiry', () => {
    test('office-local until-time', () => {
        expect(formatExpiry('2026-08-16T01:30:00Z', 'America/Denver')).toMatch(/until 7:30 PM MDT/i);
    });
    test('null on garbage', () => {
        expect(formatExpiry('nope', 'America/Denver')).toBeNull();
        expect(formatExpiry(null, 'America/Denver')).toBeNull();
    });
});

describe('nextOutlookTime', () => {
    test('walks the fixed SPC schedule', () => {
        expect(nextOutlookTime('2026-08-16T02:00:00Z')).toBe('0600 UTC');
        expect(nextOutlookTime('2026-08-16T06:01:00Z')).toBe('1300 UTC');
        expect(nextOutlookTime('2026-08-16T23:30:00Z')).toBe('0100 UTC'); // wraps
    });
});

function f(event, severity, awips, extra = {}) {
    return { properties: { event, severity, parameters: { AWIPSidentifier: [awips] }, ...extra } };
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

    test('fetchSpcOutlook(DY2) hits the DY2 locations endpoint and unwraps text+issuance', async () => {
        let seen;
        globalThis.fetch = async (url) => {
            if (String(url).includes('/products/types/SWO/locations/DY2')) {
                seen = String(url);
                return new Response(JSON.stringify({ '@graph': [{ '@id': 'https://api.weather.gov/products/def' }] }), { status: 200 });
            }
            return new Response(JSON.stringify({ productText: 'TEXT2', issuanceTime: '2026-08-16T17:34:00+00:00' }), { status: 200 });
        };
        const out = await fetchSpcOutlook('DY2', {});
        expect(seen).toBe('https://api.weather.gov/products/types/SWO/locations/DY2');
        expect(out.productText).toBe('TEXT2');
        expect(out.issuanceTime).toContain('2026');
    });

    test('fetchSpcOutlook rejects an invalid location without fetching', async () => {
        let called = false;
        globalThis.fetch = async () => { called = true; throw new Error('must not fetch'); };
        // Asserts the specific validation message (not just "rejects") — a
        // tripwire mock that throws on fetch would otherwise satisfy a bare
        // rejects.toThrow() even if the guard were deleted and fetch ran.
        await expect(fetchSpcOutlook('EVIL', {})).rejects.toThrow('bad outlook location');
        expect(called).toBe(false);
    });

    test('fetchSpcDy1 still resolves through the shared fetchSpcOutlook path', async () => {
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
});

// The baked shell is the fail-safe floor for /national/: api/national-desk.js
// string-replaces the #desk-loading marker with SSR content and, on any error,
// serves these exact bytes. These assertions pin the marker contract (drift
// here silently degrades the live page to the shell forever) and the shell's
// standalone value — a typeset index linking all 68 local desks.
//
// The shell lives at api/_national-shell.html, NOT under docs/. Unlike the
// per-office pages it has no reason to exist in the static root: nothing links
// to a static /national/index.html, and putting one there would shadow the
// /national rewrite (rewrites are evaluated after the filesystem check), which
// would then need a .vercelignore entry — and an ignored file's availability to
// `includeFiles` is undocumented. Underscore-prefixed in api/ sidesteps all of
// it: Vercel does not treat it as an endpoint (see api/_utils.js) and it ships
// to the function via the same includeFiles path as api/_og-fonts/**.
// Paths are repo-root-relative, matching the readFileSync in tests/sw.test.js.
describe('national shell', () => {
    const shell = readFileSync('api/_national-shell.html', 'utf8');

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

    // Guards the routing hazard in the other direction: if anyone reintroduces
    // a static docs/national/, it shadows the /national rewrite and
    // api/national-desk.js silently stops running. Keeping the shell out of
    // docs/ is what makes a .vercelignore entry unnecessary, so a rule
    // reappearing there is the signal that the shell moved back.
    test('no static docs/national/ exists to shadow the /national rewrite', () => {
        expect(existsSync('docs/national')).toBe(false);
        expect(readFileSync('.vercelignore', 'utf8')).not.toMatch(/docs\/national/);
    });

    test('ships to the serverless function via includeFiles', () => {
        const cfg = JSON.parse(readFileSync('vercel.json', 'utf8'));
        expect(cfg.functions['api/national-desk.js'].includeFiles).toBe('api/_national-shell.html');
        const sources = cfg.rewrites.map(r => r.source);
        expect(sources).toContain('/national');
        expect(sources).toContain('/national/');
    });
});

// Sitewide linkage: the homepage office-index and the sitemap both need to
// point at /national/, or the desk is orphaned — reachable only by URL.
describe('national linkage', () => {
    test('homepage office-index links the National Desk', () => {
        const home = readFileSync('docs/index.html', 'utf8');
        expect(home).toContain('href="/national/"');
    });
    test('sitemap carries /national/', () => {
        expect(readFileSync('docs/sitemap.xml', 'utf8')).toContain('https://plaincast.live/national/</loc>');
    });
    // The office-index link sits at the foot of the page; the masthead entry is
    // what makes the desk reachable above the fold. Exact-match the anchor —
    // the bare href already appears in the office index, so a substring test on
    // '/national/' alone would pass without the dateline entry existing.
    test('homepage masthead dateline carries the National Desk entry', () => {
        const home = readFileSync('docs/index.html', 'utf8');
        expect(home).toContain('<a class="dateline-desk" href="/national/">National&nbsp;Desk</a>');
    });
    // On the desk itself the same entry would be a self-link, so the shell's
    // dateline deliberately stays as-is.
    test('national shell does not self-link in its dateline', () => {
        expect(readFileSync('api/_national-shell.html', 'utf8')).not.toContain('dateline-desk');
    });
});
