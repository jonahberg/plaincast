import { describe, it, test, expect, beforeEach, mock } from 'bun:test';
import { readFileSync } from 'node:fs';

// Handler tests drive the national fetchers through mock.module rather than
// globalThis.fetch. Bun's module mocks are process-global: if another test
// file's partial '../api/_utils.js' stub (several predate the national
// fetchers) is registered when this handler resolves './_utils.js', a
// fetch-level stub would silently exercise a half-mocked module — the exact
// hazard documented in tests/national.test.js (~line 5). Module-mocking wins
// here; the fetchers' own wire-level coverage lives in national.test.js.
//
// Every export of _utils.js is stubbed, not just the ones used here: this
// mock is process-global, so an unrelated later caller of, say,
// fetchAlertById must not land on undefined. fetchSpcDy1 stays stubbed for
// the same reason even though the handler now calls fetchSpcOutlook('DY1')
// — api/national-lede.js still imports the Day-1 alias.
let mockFeatures = [];
let mockTotals = null;
let mockOutlooks = { DY1: null, DY2: null, DY3: null };
let severeThrows = false;
let totalsThrows = false;
let outlookThrows = { DY1: false, DY2: false, DY3: false };
mock.module('../api/_utils.js', () => ({
    fetchSevereAlerts: async () => { if (severeThrows) throw new Error('NWS down'); return mockFeatures; },
    fetchAlertTotals: async () => { if (totalsThrows) throw new Error('counts down'); return mockTotals; },
    fetchSpcOutlook: async (day) => {
        if (outlookThrows[day]) throw new Error(`SPC ${day} down`);
        return mockOutlooks[day];
    },
    fetchSpcDy1: async () => { if (outlookThrows.DY1) throw new Error('SPC down'); return mockOutlooks.DY1; },
    fetchAFDList: async () => [],
    fetchAFDProduct: async () => ({ productText: '', issuanceTime: null }),
    productUrlFromItem: (item) => item?.id || null,
    fetchAlertById: async () => null,
}));

const {
    default: handler, buildStripHtml, buildRiskHtml, buildLedeHtml,
    buildCopyHtml, buildRailHtml, buildWireHtml, buildClockHtml,
} = await import('../api/national-desk.js');
const { parseSpcOutlook, parseRiskCategory } = await import('../api/_national.js');
const { OFFICE_NAMES } = await import('../docs/js/offices.js');
const { default: alerts } = await import('./fixtures/national/severe-alerts.json');
const { default: swody1 } = await import('./fixtures/national/swody1.json');
// Fresh issuance (12:44Z, first product of its cycle): no PREV DISCUSSION
// block and no reissue preamble, so this is the fixture that exercises the
// deck-plus-discussion-copy path end to end. swody1 (a 20Z reissue) drives
// the de-dup fallback instead.
const { default: swody1Fresh } = await import('./fixtures/national/swody1-fresh.json');
const { default: swody2 } = await import('./fixtures/national/swody2.json');
const { default: swody3 } = await import('./fixtures/national/swody3.json');

// The fail-safe floor: byte-identical to the committed shell (same contract
// tests/national.test.js pins the marker against).
const SHELL = readFileSync('api/_national-shell.html', 'utf8');
const DESK_COUNT = Object.keys(OFFICE_NAMES).length;

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
const createReq = (o = {}) => ({ method: 'GET', query: {}, ...o });

// Rail fixtures reach parseRiskCategory through the REAL parser, never a
// hand-written {level, regions} object: the rail's job is to render what the
// SPC actually writes, so the test's inputs are SPC-shaped product text.
const productWithHeadline = (headline) =>
    `\n...${headline}...\n\n...SUMMARY...\nA summary line long enough to look like the real product.\n`;
const riskFromProduct = (text) => parseRiskCategory(parseSpcOutlook(text).headline);

describe('buildStripHtml', () => {
    test('national total, event classes, and the quiet count', () => {
        const html = buildStripHtml(
            [{ event: 'Flood Warning', count: 62 }, { event: 'Tornado Warning', count: 4 }],
            { total: 445 }, 56);
        expect(html).toContain('class="desk-strip"');
        expect(html).toContain('<b>445</b>');
        expect(html).toContain('active');
        expect(html).toContain('<b>62</b>');
        expect(html).toContain('Flood Warning');
        expect(html).toContain(`<b>56</b>/${DESK_COUNT} desks quiet`);
    });

    test('caps the event classes at four', () => {
        const census = Array.from({ length: 6 }, (_, i) => ({ event: `Event${i}`, count: 10 - i }));
        const html = buildStripHtml(census, { total: 1 }, 0);
        expect(html).toContain('Event0');
        expect(html).toContain('Event3');
        expect(html).not.toContain('Event4');
        expect(html).not.toContain('Event5');
    });

    test('omits the national total when totals are unavailable (soft data)', () => {
        const html = buildStripHtml([{ event: 'X', count: 1 }], null, 60);
        expect(html).not.toContain('active</span>');
        expect(html).toContain('desks quiet');
    });

    test('still renders the quiet count on a genuinely empty census', () => {
        const html = buildStripHtml([], null, DESK_COUNT);
        expect(html).toContain(`<b>${DESK_COUNT}</b>/${DESK_COUNT} desks quiet`);
    });

    test('escapes event names', () => {
        const html = buildStripHtml([{ event: '<script>x</script>', count: 1 }], { total: '<b>' }, 1);
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<b>x');
        expect(html).toContain('&lt;script&gt;');
    });
});

describe('buildRiskHtml', () => {
    test('renders the categorical word and the outlined regions', () => {
        const html = buildRiskHtml(riskFromProduct(productWithHeadline(
            'THERE IS A SLIGHT RISK OF SEVERE THUNDERSTORMS PORTIONS OF THE OHIO VALLEY')));
        expect(html).toContain('class="desk-risk"');
        expect(html).toContain('class="desk-risk-word"');
        expect(html).toContain('>Slight<');           // sentence-cased, not shouted
        expect(html).toContain('risk of severe thunderstorms');
        expect(html).toContain('OHIO VALLEY');
        expect(html).not.toContain('THE OHIO VALLEY');  // leading article stripped
    });

    test('every categorical level renders its own word', () => {
        for (const [level, word] of [['MARGINAL', 'Marginal'], ['SLIGHT', 'Slight'],
            ['ENHANCED', 'Enhanced'], ['MODERATE', 'Moderate'], ['HIGH', 'High']]) {
            const html = buildRiskHtml(riskFromProduct(productWithHeadline(
                `THERE IS A${level === 'ENHANCED' ? 'N' : ''} ${level} RISK OF SEVERE THUNDERSTORMS ACROSS THE PLAINS`)));
            expect(html).toContain(`>${word}<`);
        }
    });

    test('calm face: no risk outlined → quiet line, no display word', () => {
        const html = buildRiskHtml(null);
        expect(html).toContain('Quiet skies nationally');
        expect(html).toContain('desk-risk-quiet');
        expect(html).not.toContain('desk-risk-word');
    });

    test('omits the separator when the headline names no regions', () => {
        const html = buildRiskHtml({ level: 'HIGH', regions: '' });
        expect(html).toContain('>High<');
        expect(html).toContain('risk of severe thunderstorms');
        expect(html).not.toContain('·');
    });

    test('escapes region text', () => {
        const html = buildRiskHtml({ level: 'SLIGHT', regions: '<img src=x> & THE REST' });
        expect(html).not.toContain('<img');
        expect(html).toContain('&amp;');
    });
});

describe('buildLedeHtml', () => {
    test('deck from the regex-translated summary, attribution, ai-deck slot', () => {
        const html = buildLedeHtml({ summary: 'Storms tonight.', issuanceTime: '2026-08-15T19:42:00+00:00' });
        expect(html).toContain('id="desk-deck"');
        expect(html).toContain('Storms tonight.');
        expect(html).toContain('Storm Prediction Center');
        expect(html).toContain('1942 UTC');           // SPC's own issuance convention
        expect(html).not.toContain('desk-kicker');    // v1.1: the risk moment replaces the kicker
    });

    test('omits the issuance fragment when the timestamp is missing or unparseable', () => {
        for (const t of [null, 'not-a-date']) {
            const html = buildLedeHtml({ summary: 'Quiet.', issuanceTime: t });
            expect(html).not.toContain('issued');
            expect(html).not.toContain('null');
            expect(html).not.toContain('NaN');
        }
    });

    test('deckSuppressed renders the slot EMPTY but present (client swap target)', () => {
        const html = buildLedeHtml({ summary: 'Storms tonight.', issuanceTime: null, deckSuppressed: true });
        expect(html).toContain('<p class="desk-deck" id="desk-deck"></p>');
        expect(html).not.toContain('Storms tonight.');
        expect(html).toContain('Storm Prediction Center'); // attribution still stands
    });

    test('escapes HTML in upstream text', () => {
        const html = buildLedeHtml({ summary: 'a & b <script>alert(1)</script>', issuanceTime: null });
        expect(html).not.toContain('<script>');
        expect(html).toContain('&amp;');
    });

    test('throws when summary missing (handler falls back to baked)', () => {
        expect(() => buildLedeHtml({ summary: null, issuanceTime: null })).toThrow();
    });
});

describe('buildCopyHtml', () => {
    test('one paragraph element per narrative paragraph, regex-translated', () => {
        const html = buildCopyHtml(['Storms across the CWA this evening.', 'Second paragraph.']);
        expect(html).toContain('class="desk-copy"');
        expect((html.match(/<p>/g) || []).length).toBe(2);
        expect(html).toContain('Second paragraph.');
        expect(html).not.toContain('CWA');            // regexTranslate expanded it
    });

    test('renders nothing at all when there is no narrative', () => {
        expect(buildCopyHtml([])).toBe('');
        expect(buildCopyHtml(null)).toBe('');
    });

    test('escapes paragraph text', () => {
        const html = buildCopyHtml(['<script>x</script> a & b']);
        expect(html).not.toContain('<script>');
        expect(html).toContain('a &amp; b');
    });
});

describe('buildRailHtml', () => {
    const rails = (...cells) => buildRailHtml(cells);

    test('three cells, Day 1 highlighted, level word and region note per cell', () => {
        const html = buildRailHtml([
            { label: 'Today · Day 1', level: 'SLIGHT', note: 'CENTRAL HIGH PLAINS' },
            { label: 'Tomorrow · Day 2', level: 'MARGINAL', note: 'NORTHERN PLAINS' },
            { label: 'Day 3', level: null, note: 'No organized severe risk outlined' },
        ]);
        expect(html).toContain('class="desk-rail"');
        expect((html.match(/desk-rail-day/g) || []).length).toBe(3);
        expect(html).toContain('desk-rail-day now');  // Day 1 highlight
        expect(html).toContain('Today · Day 1');
        expect(html).toContain('>Slight<');
        expect(html).toContain('>Marginal<');
        expect(html).toContain('>—<');
        expect(html).toContain('CENTRAL HIGH PLAINS');
        expect(html).toContain('No organized severe risk outlined');
    });

    test('renders the levels the DY2/DY3 fixtures never show — parsed, not mocked', () => {
        const cases = [
            ['THERE IS AN ENHANCED RISK OF SEVERE THUNDERSTORMS ACROSS THE MID MISSISSIPPI VALLEY', 'Enhanced', 'MID MISSISSIPPI VALLEY'],
            ['THERE IS A MODERATE RISK OF SEVERE THUNDERSTORMS OVER PARTS OF THE SOUTHERN PLAINS', 'Moderate', 'SOUTHERN PLAINS'],
            ['THERE IS A HIGH RISK OF SEVERE THUNDERSTORMS ACROSS EASTERN NEBRASKA INTO IOWA', 'High', 'EASTERN NEBRASKA'],
        ];
        for (const [headline, word, region] of cases) {
            const risk = riskFromProduct(productWithHeadline(headline));
            const html = rails({ label: 'Tomorrow · Day 2', level: risk.level, note: risk.regions });
            expect(html).toContain(`>${word}<`);
            expect(html).toContain(region);
        }
    });

    test('a parsed product with no outlined risk gets the calm note, not a fabricated one', () => {
        // No THERE-IS line at all: the SPC's own "no severe areas" shape.
        const risk = riskFromProduct('\n...NO SEVERE THUNDERSTORM AREAS FORECAST...\n\n...SUMMARY...\nQuiet.\n');
        expect(risk).toBeNull();
        const html = rails({ label: 'Day 3', level: null, note: 'No organized severe risk outlined' });
        expect(html).toContain('>—<');
        expect(html).toContain('No organized severe risk outlined');
    });

    test('a FAILED fetch renders a bare dash — never a claim about the sky', () => {
        const html = rails({ label: 'Day 3', level: null, note: null });
        expect(html).toContain('>—<');
        expect(html).not.toContain('No organized severe risk outlined');
        expect(html).not.toContain('null');
    });

    test('truncates a long region note', () => {
        const note = (n) => buildRailHtml([{ label: 'Day 2', level: 'SLIGHT', note: n }])
            .match(/class="desk-rail-note">([^<]*)</)[1];
        const unbroken = note('A'.repeat(200));
        expect(unbroken.length).toBeLessThanOrEqual(64);
        expect(unbroken).toContain('…');
        // prose clips on a word boundary, not mid-word
        const prose = note('PARTS OF THE NORTHERN PLAINS AND FROM THE SOUTHERN APPALACHIANS INTO THE CAROLINAS');
        expect(prose.length).toBeLessThanOrEqual(64);
        expect(prose).toContain('…');
        expect(prose).not.toContain('APPALA…');
        expect(prose).toMatch(/SOUTHERN…$/);
    });

    test('escapes labels and notes', () => {
        const html = rails({ label: '<script>x</script>', level: 'SLIGHT', note: 'a & b <img src=x>' });
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<img');
        expect(html).toContain('a &amp; b');
    });
});

describe('buildWireHtml', () => {
    const row = (over) => ({
        code: 'LOT', city: 'Chicago', event: 'Tornado Warning', count: 2, extreme: true,
        areaDesc: null, expires: null, ...over,
    });

    test('covered office links to its desk; uncovered renders unlinked', () => {
        const html = buildWireHtml([row(), row({ code: 'CYS', city: null, extreme: false })]);
        expect(html).toContain('href="/o/LOT/"');
        expect(html).not.toContain('href="/o/CYS/"');
        expect(html).toContain('CYS');
        expect(html).toContain('wire-extreme');
    });

    test('second line: area digest · office-local expiry', () => {
        const html = buildWireHtml([row({
            code: 'PUB', city: 'Pueblo',
            areaDesc: 'Otero; Crowley; Pueblo; Las Animas',
            expires: '2026-08-16T01:30:00Z',
        })]);
        expect(html).toContain('class="wire-area"');
        expect(html).toContain('Otero &amp; Crowley +2 more');
        expect(html).toMatch(/until 7:30\s?PM MDT/);
        expect(html).toContain('·');
    });

    test('second line omitted entirely when both fields are missing', () => {
        const html = buildWireHtml([row()]);
        expect(html).not.toContain('wire-area');
    });

    test('area alone and expiry alone each render without a dangling separator', () => {
        const areaOnly = buildWireHtml([row({ areaDesc: 'Cook, IL' })]);
        expect(areaOnly).toContain('Cook, IL');
        expect(areaOnly).not.toContain('Cook, IL ·');
        const timeOnly = buildWireHtml([row({ expires: '2026-08-16T01:30:00Z' })]);
        expect(timeOnly).toContain('wire-area');
        expect(timeOnly).not.toMatch(/wire-area">\s*·/);
    });

    // An office Plaincast does not cover has no entry in OFFICE_TIMEZONES;
    // formatExpiry would silently fall back to the SERVER's zone and print a
    // Cheyenne expiry in whatever timezone Vercel happens to run in.
    test('no expiry line for an office with no known timezone', () => {
        const html = buildWireHtml([row({ code: 'CYS', city: null, expires: '2026-08-16T01:30:00Z', areaDesc: 'Laramie, WY' })]);
        expect(html).toContain('Laramie, WY');
        expect(html).not.toContain('until');
    });

    test('caps at 12 with an "and N more" line', () => {
        const rows = Array.from({ length: 15 }, (_, i) => row({ code: 'A' + String(i).padStart(2, '0'), city: null }));
        const html = buildWireHtml(rows);
        expect((html.match(/wire-item/g) || []).length).toBeLessThanOrEqual(13);
        expect(html).toContain('3 more offices');
    });

    test('the overflow line is singular when exactly one office is hidden', () => {
        const rows = Array.from({ length: 13 }, (_, i) => row({ code: 'A' + String(i).padStart(2, '0'), city: null }));
        const html = buildWireHtml(rows);
        expect(html).toContain('…and 1 more office under a severe warning.');
        expect(html).not.toContain('offices under severe warnings');
    });

    test('empty wire renders the quiet line, not nothing', () => {
        expect(buildWireHtml([])).toContain('No office is under a severe warning');
    });

    test('escapes office-derived text, second line included', () => {
        const html = buildWireHtml([row({
            code: '"><b>', city: '<script>x</script>', event: 'a & b',
            areaDesc: '<img src=x>; b & c',
        })]);
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<b>');
        expect(html).not.toContain('<img');
        expect(html).toContain('a &amp; b');
    });
});

describe('buildClockHtml', () => {
    test('names the next issuance slot and the re-ink cadence', () => {
        const html = buildClockHtml('0600 UTC');
        expect(html).toContain('class="desk-clock"');
        expect(html).toContain('Next Day 1 outlook expected by 0600 UTC');
        expect(html).toContain('re-inks');
    });

    test('escapes its input', () => {
        expect(buildClockHtml('<script>x</script>')).not.toContain('<script>');
    });
});

describe('GET /api/national-desk (SSR /national/)', () => {
    beforeEach(() => {
        severeThrows = false;
        totalsThrows = false;
        outlookThrows = { DY1: false, DY2: false, DY3: false };
        mockFeatures = alerts.features;
        mockTotals = { total: 445 };
        mockOutlooks = {
            DY1: { productText: swody1Fresh.productText, issuanceTime: swody1Fresh.issuanceTime },
            DY2: { productText: swody2.productText, issuanceTime: swody2.issuanceTime },
            DY3: { productText: swody3.productText, issuanceTime: swody3.issuanceTime },
        };
    });

    it('returns 405 for non-GET', async () => {
        const res = createRes();
        await handler(createReq({ method: 'POST' }), res);
        expect(res.statusCode).toBe(405);
    });

    it('composes the whole desk into the shell, in spec order', async () => {
        const res = createRes();
        await handler(createReq(), res);

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.headers['cache-control']).toBe('public, s-maxage=600, stale-while-revalidate=1800');

        // spec §v1.1: strip → risk → deck → copy → rail → wire → clock
        const at = (marker) => {
            const i = res.body.indexOf(marker);
            expect(i).toBeGreaterThan(-1);
            return i;
        };
        const strip = at('class="desk-strip"');
        const risk = at('class="desk-risk"');
        const deck = at('id="desk-deck"');
        const copy = at('class="desk-copy"');
        const rail = at('class="desk-rail"');
        const wire = at('class="wire"');
        const clock = at('class="desk-clock"');
        expect(strip).toBeLessThan(risk);
        expect(risk).toBeLessThan(deck);
        expect(deck).toBeLessThan(copy);
        expect(copy).toBeLessThan(rail);
        expect(rail).toBeLessThan(wire);
        expect(wire).toBeLessThan(clock);

        // the strip: national total, an event class, the quiet count
        expect(res.body).toContain('<b>445</b>');
        expect(res.body).toMatch(new RegExp(`<b>\\d+</b>/${DESK_COUNT} desks quiet`));
        // the risk moment, from the live DY1 headline
        expect(res.body).toContain('>Slight<');
        // deck from the SPC summary, still the client's swap target
        expect(res.body).toContain('Thunderstorms with damaging wind gusts');
        // running copy: post-SUMMARY narrative, opening on the meteorology
        expect(res.body).toContain('class="desk-copy"');
        expect(res.body).toContain('<p>Satellite and regional radar imagery');
        // ...and never the summary a second time (that is the deck's job here)
        expect((res.body.match(/Thunderstorms with damaging wind gusts/g) || []).length).toBe(1);
        // the rail: three days
        expect((res.body.match(/desk-rail-day/g) || []).length).toBe(3);
        // the wire: covered offices link out, uncovered ones do not
        expect(res.body).toContain('href="/o/PUB/"');
        expect(res.body).toContain('CYS');
        expect(res.body).not.toContain('href="/o/CYS/"');
        expect(res.body).toContain('class="wire-area"');
        // the clock (time-dependent — pin the shape, not a literal)
        expect(res.body).toMatch(/Next Day 1 outlook expected by \d{4} UTC/);
        // the skeleton is replaced, not duplicated
        expect(res.body).not.toContain('id="desk-loading"');
        expect(res.body).not.toContain('Setting the type…');
        // still the shell document: masthead, office index, client bootstrap
        expect(res.body).toContain('<link rel="canonical" href="https://plaincast.live/national/">');
        expect(res.body).toContain('src="/js/national.js"');
        expect(res.body).toContain('id="local-desk"');
        // v1's census ledger is gone — the strip replaced it
        expect(res.body).not.toContain('<dl class="ledger">');
    });

    it('renders two dashed rail cells when Day 2 and Day 3 both fail (soft)', async () => {
        outlookThrows.DY2 = true;
        outlookThrows.DY3 = true;
        const res = createRes();
        await handler(createReq(), res);

        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('public, s-maxage=600, stale-while-revalidate=1800');
        expect((res.body.match(/desk-rail-day/g) || []).length).toBe(3);
        expect((res.body.match(/desk-rail-level">—</g) || []).length).toBe(2);
        // a failed fetch must not be dressed up as a calm forecast
        expect(res.body).not.toContain('No organized severe risk outlined');
        expect(res.body).toContain('>Slight<'); // Day 1 unaffected
    });

    it('still renders when the national totals fetch fails (soft)', async () => {
        totalsThrows = true;
        const res = createRes();
        await handler(createReq(), res);
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('public, s-maxage=600, stale-while-revalidate=1800');
        expect(res.body).toContain('class="desk-strip"');
        expect(res.body).not.toContain('<b>445</b>');
        expect(res.body).toMatch(new RegExp(`/${DESK_COUNT} desks quiet`));
    });

    it('serves the EXACT baked shell when the Day 1 outlook fails (hard)', async () => {
        outlookThrows.DY1 = true;
        const res = createRes();
        await handler(createReq(), res);
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.headers['cache-control']).toBe('public, s-maxage=300');
        expect(res.body).toBe(SHELL);
        expect(res.body).toContain('Setting the type…');
    });

    it('serves the EXACT baked shell when the severe alert feed fails (hard)', async () => {
        severeThrows = true;
        const res = createRes();
        await handler(createReq(), res);
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('public, s-maxage=300');
        expect(res.body).toBe(SHELL);
    });

    it('serves the baked shell when the SPC outlook is unavailable (no lede to print)', async () => {
        mockOutlooks.DY1 = null;
        const res = createRes();
        await handler(createReq(), res);
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('public, s-maxage=300');
        expect(res.body).toBe(SHELL);
    });

    it('serves the baked shell when the SPC product has no parseable summary', async () => {
        mockOutlooks.DY1 = { productText: 'no structure here', issuanceTime: null };
        const res = createRes();
        await handler(createReq(), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe(SHELL);
    });

    it('shows the calm face when no risk is outlined nationally', async () => {
        mockOutlooks.DY1 = {
            productText: '...NO SEVERE THUNDERSTORM AREAS FORECAST...\n\n...SUMMARY...\nA quiet day nationally with no organized severe threat.\n\n...Discussion...\nWeak flow aloft and limited moisture will keep thunderstorms disorganized nationwide today.\n',
            issuanceTime: swody1.issuanceTime,
        };
        const res = createRes();
        await handler(createReq(), res);
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('public, s-maxage=600, stale-while-revalidate=1800');
        expect(res.body).toContain('Quiet skies nationally');
        expect(res.body).not.toContain('desk-risk-word');
        // the page continues: copy, rail, wire, clock all still there
        expect(res.body).toContain('class="desk-copy"');
        expect(res.body).toContain('class="desk-rail"');
        expect(res.body).toContain('class="desk-clock"');
        expect(res.body).not.toContain('Setting the type…');
    });

    it('falls back to the summary as running copy, with the deck slot left EMPTY', async () => {
        // No post-SUMMARY narrative at all: the standfirst would otherwise say
        // exactly what the running copy says.
        mockOutlooks.DY1 = {
            productText: '...THERE IS A SLIGHT RISK OF SEVERE THUNDERSTORMS ACROSS THE PLAINS...\n\n...SUMMARY...\nSevere wind gusts are possible this evening across the central High Plains.\n\n$$\n',
            issuanceTime: swody1.issuanceTime,
        };
        const res = createRes();
        await handler(createReq(), res);
        expect(res.statusCode).toBe(200);
        // the summary runs as copy...
        expect(res.body).toContain('class="desk-copy"');
        expect(res.body).toContain('Severe wind gusts are possible this evening');
        // ...exactly once — never both deck and copy from one source
        expect((res.body.match(/Severe wind gusts are possible this evening/g) || []).length).toBe(1);
        // the swap target survives, empty
        expect(res.body).toContain('<p class="desk-deck" id="desk-deck"></p>');
    });

    // The live 20Z reissue: its only post-summary paragraph is reissue
    // housekeeping ("The previous forecast (see below) remains…"), which the
    // parser drops — so a real, unmodified SPC product routes through the
    // fallback, and the page must be whole on the way out.
    it('routes a reissued DY1 product into the summary fallback, boilerplate and all', async () => {
        mockOutlooks.DY1 = { productText: swody1.productText, issuanceTime: swody1.issuanceTime };
        const res = createRes();
        await handler(createReq(), res);

        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('public, s-maxage=600, stale-while-revalidate=1800');
        // no editorial preamble, and no dangling reference to cut content
        expect(res.body).not.toContain('previous forecast');
        expect(res.body).not.toContain('(see below)');
        // nor any prose from the superseded PREV DISCUSSION block
        expect(res.body).not.toContain('Modestly strong southwesterly');
        // the fallback contract: summary runs as copy, deck slot empty
        expect(res.body).toContain('<p class="desk-deck" id="desk-deck"></p>');
        expect(res.body).toContain('class="desk-copy"');
        expect(res.body).toContain('Thunderstorms with severe wind gusts');
        expect((res.body.match(/Thunderstorms with severe wind gusts/g) || []).length).toBe(1);
        // the rest of the page is untouched by the fallback
        expect(res.body).toContain('>Slight<');
        expect(res.body).toContain('class="desk-rail"');
        expect(res.body).toContain('class="wire"');
        expect(res.body).toContain('class="desk-clock"');
        expect(res.body).not.toContain('Setting the type…');
    });

    it('still renders with a quiet wire and no totals (soft data absent)', async () => {
        mockFeatures = [];
        mockTotals = null;
        const res = createRes();
        await handler(createReq(), res);
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('public, s-maxage=600, stale-while-revalidate=1800');
        expect(res.body).toContain('No office is under a severe warning');
        expect(res.body).not.toContain('active products nationwide');
        expect(res.body).toContain(`<b>${DESK_COUNT}</b>/${DESK_COUNT} desks quiet`);
        expect(res.body).not.toContain('Setting the type…');
    });

    it('never interprets $-sequences from upstream text as replacement patterns', async () => {
        // A literal `$&` in the SPC text would re-insert the whole matched
        // marker if the replacement were a plain string instead of a fn. With
        // no post-summary narrative this lands in the running copy.
        mockOutlooks.DY1 = {
            productText: '...SUMMARY...\nGusty winds $& $` $\' $1 across the plains this evening.\n\n...NEXT...',
            issuanceTime: swody1.issuanceTime,
        };
        const res = createRes();
        await handler(createReq(), res);
        expect(res.statusCode).toBe(200);
        // `$&` survives escHtml as `$&amp;`; a string replacement would have
        // re-inserted the marker div here instead.
        expect(res.body).toContain("Gusty winds $&amp; $` $' $1 across the plains");
        expect(res.body).not.toContain('<div class="loading"');
        expect(res.body).not.toContain('Setting the type…');
        // no THERE-IS headline in this product: the calm face, not a fake risk
        expect(res.body).toContain('desk-risk-quiet');
    });
});
