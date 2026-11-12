import { describe, it, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { memoryBackend, recordFetches } from './shared-cache-backend.js';

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
    buildCopyHtml, buildRailHtml, buildWireHtml, buildClockHtml, buildDeskMarkdown, pickLede,
} = await import('../api/national-desk.js');
const { parseSpcOutlook, parseRiskCategory, calmHeadline, buildCensus } = await import('../api/_national.js');
const { __setSharedCacheBackendForTests, ledeKey } = await import('../api/_shared-cache.js');

// The shared store is module state shared by every test file: always reset.
afterEach(() => __setSharedCacheBackendForTests(null));
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

// Page Cache-Control. Off Vercel, with no injected backend (every test here
// unless it injects one), the shared store reads as empty, so there is no AI
// text to embed and the page takes the short window that lets the edge
// re-render once the AI text exists.
const AI_CACHE = 'public, s-maxage=600, stale-while-revalidate=1800';
const NO_AI_CACHE = 'public, s-maxage=120, stale-while-revalidate=1800';

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
        // the area line is cased in the source text, as one sentence (the
        // bare "PORTIONS OF" tail gets SPC's usual "across")
        expect(html).toContain('<p class="desk-risk-of">Risk of severe thunderstorms across portions of the Ohio Valley.</p>');
        expect(html).not.toContain('OHIO VALLEY');
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

    // Live 2026-09-25: the desk said "Quiet skies nationally" over a census
    // strip showing 19 Tropical Storm Watch and 8 Hurricane Watch. SPC
    // convective outlooks never carry tropical products, so "no outlined
    // risk" alone cannot justify calling the sky quiet.
    test('calm face with tropical alerts active is not "quiet"', () => {
        const census = [
            { event: 'Coastal Flood Warning', count: 30 },
            { event: 'Tropical Storm Watch', count: 19 },
            { event: 'Hurricane Watch', count: 8 },
        ];
        const html = buildRiskHtml(null, census);
        expect(html).not.toContain('Quiet skies nationally');
        expect(html).toContain('No severe thunderstorm risk outlined');
        expect(html).toContain('The tropics are active: Tropical Storm Watch ×19 · Hurricane Watch ×8');
        expect(html).toContain('desk-risk-quiet');
        expect(html).not.toContain('desk-risk-word');
    });

    test('calm face with only non-tropical alerts names them instead', () => {
        const html = buildRiskHtml(null, [{ event: 'Flood Warning', count: 4 }]);
        expect(html).not.toContain('Quiet skies nationally');
        expect(html).toContain('Other hazards in effect: Flood Warning ×4');
    });

    test('an outlined risk ignores the census entirely', () => {
        const html = buildRiskHtml({ level: 'SLIGHT', regions: '' }, [{ event: 'Hurricane Watch', count: 8 }]);
        expect(html).toContain('>Slight<');
        expect(html).not.toContain('tropics');
    });

    test('omits the separator when the headline names no regions', () => {
        const html = buildRiskHtml({ level: 'HIGH', regions: '' });
        expect(html).toContain('>High<');
        expect(html).toContain('<p class="desk-risk-of">Risk of severe thunderstorms.</p>');
        expect(html).not.toContain('·');
    });

    test('escapes region text', () => {
        const html = buildRiskHtml({ level: 'SLIGHT', regions: '<img src=x> & THE REST' });
        expect(html).not.toContain('<img');
        expect(html).toContain('&amp;');
    });
});

describe('calmHeadline', () => {
    test('quiet only when nothing is in effect', () => {
        expect(calmHeadline([])).toEqual({ title: 'Quiet skies nationally', note: null });
        expect(calmHeadline(undefined).title).toBe('Quiet skies nationally');
    });
    test('tropical classes lead the note even when outnumbered', () => {
        const c = calmHeadline([
            { event: 'Flood Warning', count: 50 },
            { event: 'Storm Surge Watch', count: 2 },
        ]);
        expect(c.title).toBe('No severe thunderstorm risk outlined');
        expect(c.note).toBe('The tropics are active: Storm Surge Watch ×2');
    });
    test('buildCensus(features, Infinity) keeps a rare tropical class past the strip cap', () => {
        const feats = [];
        for (const [event, n] of [['A Warning', 9], ['B Warning', 8], ['C Warning', 7], ['D Warning', 6],
            ['E Warning', 5], ['F Warning', 4], ['Hurricane Watch', 1]]) {
            for (let i = 0; i < n; i++) feats.push({ properties: { event } });
        }
        expect(buildCensus(feats).some(c => c.event === 'Hurricane Watch')).toBe(false);
        expect(calmHeadline(buildCensus(feats, Infinity)).note).toContain('Hurricane Watch ×1');
    });
    test('the Markdown twin says the same thing as the HTML', () => {
        const md = buildDeskMarkdown({
            census: [], fullCensus: [{ event: 'Hurricane Watch', count: 8 }], totals: null, quiet: 68,
            risk: null, summary: null, copy: [], rail: [], rows: [], issuanceTime: null, nextTime: '1630 UTC',
        });
        expect(md).toContain('## No severe thunderstorm risk outlined');
        expect(md).toContain('The tropics are active: Hurricane Watch ×8');
        expect(md).not.toContain('Quiet skies');
    });
});

describe('buildLedeHtml', () => {
    test('deck from the regex-translated summary, attribution, ai-deck slot', () => {
        const html = buildLedeHtml({ summary: 'Storms tonight.', issuanceTime: '2026-08-15T19:42:00+00:00' });
        expect(html).toContain('id="desk-deck"');
        expect(html).toContain('Storms tonight.');
        expect(html).toContain('Storm Prediction Center');
        // US Eastern on the server, inside a <time> the client re-zones
        expect(html).toContain('issued <time datetime="2026-08-15T19:42:00.000Z" data-local-time>3:42 PM EDT</time>.');
        expect(html).not.toContain('UTC');
        expect(html).toContain('data-issued="2026-08-15T19:42:00.000Z"');
        expect(html).not.toContain('Simplified by AI');
        expect(html).not.toContain('data-ai');
        expect(html).not.toContain('desk-kicker');    // v1.1: the risk moment replaces the kicker
    });

    test('omits the issuance fragment when the timestamp is missing or unparseable', () => {
        for (const t of [null, 'not-a-date']) {
            const html = buildLedeHtml({ summary: 'Quiet.', issuanceTime: t });
            expect(html).not.toContain('issued');
            expect(html).not.toContain('<time');
            expect(html).not.toContain('null');
            expect(html).not.toContain('NaN');
            expect(html).not.toContain('Invalid');
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

describe('buildLedeHtml with AI text', () => {
    test('embeds the AI deck (escaped, marked data-ai) and credits it', () => {
        const html = buildLedeHtml({
            summary: 'Storms tonight.', issuanceTime: '2026-08-15T19:42:00+00:00',
            aiDeck: 'Storms <b>tonight</b> & more.', simplified: true,
        });
        expect(html).toContain('<p class="desk-deck" id="desk-deck" data-ai>Storms &lt;b&gt;tonight&lt;/b&gt; &amp; more.</p>');
        expect(html).not.toContain('Storms tonight.');
        expect(html).toContain('3:42 PM EDT</time>. Simplified by AI.</p>');
    });
    test('the AI deck fills the slot even on the de-dup fallback', () => {
        const html = buildLedeHtml({ summary: 'Storms tonight.', issuanceTime: null, deckSuppressed: true, aiDeck: 'AI deck.', simplified: true });
        expect(html).toContain('id="desk-deck" data-ai>AI deck.</p>');
    });
    test('"Simplified by AI." only when AI text is on the page', () => {
        expect(buildLedeHtml({ summary: 'S.', issuanceTime: null, simplified: false })).not.toContain('Simplified by AI');
        expect(buildLedeHtml({ summary: 'S.', issuanceTime: null, simplified: true })).toContain('Simplified by AI.');
    });
});

describe('pickLede', () => {
    const ISS = '2026-08-16T12:44:00+00:00';
    test('takes deck and copy for the same instant, however it is spelled', () => {
        expect(pickLede({ deck: ' D. ', copy: [' A ', '', 'B'], issued: '2026-08-16T12:44:00Z' }, ISS))
            .toEqual({ deck: 'D.', copy: ['A', 'B'] });
    });
    test('ignores another issuance, a missing one, and malformed fields', () => {
        const none = { deck: null, copy: null };
        expect(pickLede({ deck: 'D', copy: ['A'], issued: '2026-08-16T12:45:00Z' }, ISS)).toEqual(none);
        expect(pickLede({ deck: 'D', copy: ['A'] }, ISS)).toEqual(none);
        expect(pickLede({ deck: 'D', copy: ['A'], issued: ISS }, null)).toEqual(none);
        expect(pickLede(null, ISS)).toEqual(none);
        expect(pickLede({ deck: 5, copy: 'A', issued: ISS }, ISS)).toEqual(none);
        expect(pickLede({ deck: 'D', copy: ['A', 7], issued: ISS }, ISS)).toEqual({ deck: 'D', copy: null });
        expect(pickLede({ deck: 'x'.repeat(2001), copy: [], issued: ISS }, ISS)).toEqual(none);
        expect(pickLede({ deck: 'D', copy: Array(21).fill('A.'), issued: ISS }, ISS)).toEqual({ deck: 'D', copy: null });
    });
    // One definition of an acceptable answer (LEDE_* in _national.js): the
    // page must embed anything the endpoint can cache, or it would sit on its
    // short window all issuance.
    test('accepts a long copy the endpoint can legitimately return', () => {
        const twelve = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} explains one more step of the setup in two short sentences. ${'More detail follows here. '.repeat(8)}`);
        expect(pickLede({ deck: 'D', copy: twelve, issued: ISS }, ISS).copy.length).toBe(12);
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

    test('without AI copy: the forecasters\' own words, visible, under a label', () => {
        const html = buildCopyHtml(['Storms across the CWA this evening.'], { source: 'discussion' });
        expect(html).toContain('<section class="desk-copy" data-source="discussion">');
        expect(html).toContain('<p class="desk-copy-label">From the forecasters\' discussion, in their words</p>');
        expect(html).not.toContain('<details');
        expect(html).not.toContain('data-ai');
    });

    test('with AI copy: plain English visible, the original one tap away in <details>', () => {
        const html = buildCopyHtml(['Storms across the CWA this evening.', 'Second paragraph.'], {
            source: 'discussion', aiCopy: ['Plain one <script>x</script>.', 'Plain & two.'],
        });
        expect(html).toContain('<section class="desk-copy" data-source="discussion" data-ai>');
        expect(html).toContain('<p>Plain one &lt;script&gt;x&lt;/script&gt;.</p>');
        expect(html).toContain('<p>Plain &amp; two.</p>');
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('desk-copy-label');
        const details = html.slice(html.indexOf('<details class="desk-original">'));
        expect(html.indexOf('</section>')).toBeLessThan(html.indexOf('<details class="desk-original">'));
        expect(details).toContain('<summary>Read the Storm Prediction Center\'s original discussion</summary>');
        expect(details).toContain('<div class="desk-original-body">');
        expect(details).toContain('Second paragraph.');
        expect(details).not.toContain('CWA');         // the original, abbreviation-expanded
        expect(details).not.toContain(' open');       // closed by default
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

    test('prints the cased caption when the cell carries one, else the raw note', () => {
        const html = rails(
            { label: 'Today · Day 1', level: 'SLIGHT', note: 'THE OHIO VALLEY', caption: 'The Ohio Valley' },
            { label: 'Day 3', level: null, note: 'No organized severe risk outlined' },
        );
        expect(html).toContain('<p class="desk-rail-note">The Ohio Valley</p>');
        expect(html).not.toContain('OHIO VALLEY');
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
    test('names the next issuance slot (Eastern, in a <time>) and the re-ink cadence', () => {
        const html = buildClockHtml('2026-11-12T06:00:00.000Z');
        expect(html).toContain('class="desk-clock"');
        expect(html).toContain('Next Day 1 outlook expected by <time datetime="2026-11-12T06:00:00.000Z" data-local-time>1:00 AM EST</time>');
        expect(html).toContain('re-inks');
    });

    test('a bad instant drops the clause rather than printing a broken time', () => {
        for (const bad of [null, 'not-a-date', '<script>x</script>']) {
            const html = buildClockHtml(bad);
            expect(html).toBe('<p class="desk-clock">This page re-inks every 10 minutes.</p>');
        }
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
        expect(res.headers['cache-control']).toBe(NO_AI_CACHE);

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
        expect(res.body).toMatch(/Next Day 1 outlook expected by <time datetime="[^"]+" data-local-time>\d{1,2}:\d{2} [AP]M E[SD]T<\/time>/);
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

    it('cases the risk line and the rail notes on the page; the Markdown twin keeps SPC\'s text', async () => {
        const res = createRes();
        await handler(createReq(), res);
        expect(res.body).toContain('<p class="desk-risk-of">Risk of severe thunderstorms across parts of the Ohio Valley, central Appalachians, Mid-Atlantic, and central High Plains.</p>');
        expect(res.body).toContain('<p class="desk-rail-note">Parts of the Ohio Valley, central Appalachians,');
        expect(res.body).toContain('<p class="desk-rail-note">Parts of the northern Plains, and from the southern…</p>');
        expect(res.body).not.toMatch(/desk-rail-note">[^<]*[A-Z]{4}/); // nothing shouted

        const md = createRes();
        await handler(createReq({ headers: { accept: 'text/markdown' } }), md);
        expect(md.body).toContain('## Slight risk of severe thunderstorms — PARTS OF THE OHIO VALLEY');
        expect(md.body).toContain('- **Tomorrow · Day 2:** Slight — PARTS OF THE NORTHERN PLAINS');
    });

    it('renders two dashed rail cells when Day 2 and Day 3 both fail (soft)', async () => {
        outlookThrows.DY2 = true;
        outlookThrows.DY3 = true;
        const res = createRes();
        await handler(createReq(), res);

        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe(NO_AI_CACHE);
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
        expect(res.headers['cache-control']).toBe(NO_AI_CACHE);
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
        expect(res.headers['cache-control']).toBe(NO_AI_CACHE);
        // The fixture feed carries a Tropical Storm Warning, so the sky is
        // thunderstorm-free but NOT quiet — the headline must say so.
        expect(res.body).not.toContain('Quiet skies nationally');
        expect(res.body).toContain('No severe thunderstorm risk outlined');
        expect(res.body).toContain('The tropics are active: Tropical Storm Warning ×1');
        expect(res.body).toContain('desk-risk-quiet');
        expect(res.body).not.toContain('desk-risk-word');
        // the page continues: copy, rail, wire, clock all still there
        expect(res.body).toContain('class="desk-copy"');
        expect(res.body).toContain('class="desk-rail"');
        expect(res.body).toContain('class="desk-clock"');
        expect(res.body).not.toContain('Setting the type…');
    });

    it('the Markdown twin says the fallback summary once, not twice', async () => {
        mockOutlooks.DY1 = { productText: swody1.productText, issuanceTime: swody1.issuanceTime };
        const res = createRes();
        await handler(createReq({ headers: { accept: 'text/markdown' } }), res);
        expect((res.body.match(/Thunderstorms with severe wind gusts/g) || []).length).toBe(1);
        // the fresh product still carries summary + discussion
        mockOutlooks.DY1 = { productText: swody1Fresh.productText, issuanceTime: swody1Fresh.issuanceTime };
        const fresh = createRes();
        await handler(createReq({ headers: { accept: 'text/markdown' } }), fresh);
        expect((fresh.body.match(/Thunderstorms with damaging wind gusts/g) || []).length).toBe(1);
        expect(fresh.body).toContain('Satellite and regional radar imagery');
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
        expect(res.headers['cache-control']).toBe(NO_AI_CACHE);
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
        expect(res.headers['cache-control']).toBe(NO_AI_CACHE);
        expect(res.body).toContain('No office is under a severe warning');
        expect(res.body).not.toContain('active products nationwide');
        expect(res.body).toContain(`<b>${DESK_COUNT}</b>/${DESK_COUNT} desks quiet`);
        expect(res.body).not.toContain('Setting the type…');
    });

    it('says "Quiet skies" only when the severe feed is empty too', async () => {
        mockOutlooks.DY1 = {
            productText: '...NO SEVERE THUNDERSTORM AREAS FORECAST...\n\n...SUMMARY...\nA quiet day nationally with no organized severe threat.\n\n...Discussion...\nWeak flow aloft and limited moisture will keep thunderstorms disorganized nationwide today.\n',
            issuanceTime: swody1.issuanceTime,
        };
        mockFeatures = [];
        const res = createRes();
        await handler(createReq(), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('Quiet skies nationally');
        expect(res.body).not.toContain('No severe thunderstorm risk outlined');
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

// ─── The AI text, embedded server-side (Nov 2026) ───────────────────
// api/national-desk.js reads the lede entry /api/national-lede stores in the
// shared store (api/_shared-cache.js), keyed by the outlook's issuance. These
// tests inject an in-memory backend and record global fetch: the handler's
// upstream fetchers are module-mocked above, so a page render must make no
// HTTP call at all (in particular none to its own /api/).
describe('GET /national/ with the AI deck and copy available', () => {
    let backend;
    let fetches;

    // Stores `body` the way /api/national-lede does, under the key for
    // `issued` (this page's outlook unless a test says otherwise).
    function serveLede(body, issued = ISSUED) {
        backend.seed(ledeKey(issued), body);
    }

    const ISSUED = swody1Fresh.issuanceTime;
    const AI_DECK = 'Storms with damaging gusts may roll from the Ohio Valley into the Mid-Atlantic this afternoon.';
    const AI_COPY = [
        'Pockets of spinning air in the jet stream will set off storms later today.',
        'They should push east into the Mid-Atlantic by early evening, mainly with damaging gusts.',
    ];

    beforeEach(() => {
        backend = memoryBackend();
        __setSharedCacheBackendForTests(backend);
        fetches = recordFetches();
        severeThrows = false;
        totalsThrows = false;
        outlookThrows = { DY1: false, DY2: false, DY3: false };
        mockFeatures = alerts.features;
        mockTotals = { total: 445 };
        mockOutlooks = {
            DY1: { productText: swody1Fresh.productText, issuanceTime: ISSUED },
            DY2: { productText: swody2.productText, issuanceTime: swody2.issuanceTime },
            DY3: { productText: swody3.productText, issuanceTime: swody3.issuanceTime },
        };
    });
    afterEach(() => {
        fetches.restore();
    });

    const render = async (req = createReq()) => {
        const res = createRes();
        await handler(req, res);
        return res;
    };

    it('same issuance: AI deck and AI copy in the first response, original one tap away, long cache', async () => {
        serveLede({ deck: AI_DECK, copy: AI_COPY, issued: ISSUED });
        const res = await render();
        // One store read, for this outlook; no HTTP call of any kind.
        expect(backend.reads).toEqual([ledeKey(ISSUED)]);
        expect(fetches.calls).toEqual([]);
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe(AI_CACHE);
        const html = res.body;

        expect(html).toContain(`<p class="desk-deck" id="desk-deck" data-ai>${AI_DECK}</p>`);
        expect(html).not.toContain('Thunderstorms with damaging wind gusts'); // the deterministic deck
        expect(html).toContain('<section class="desk-copy" data-source="discussion" data-ai>');
        for (const p of AI_COPY) expect(html).toContain(`<p>${p}</p>`);
        expect(html).toContain('<details class="desk-original">');
        expect(html).toContain('<summary>Read the Storm Prediction Center\'s original discussion</summary>');
        // the original discussion lives inside the details, abbreviation-expanded
        const details = html.slice(html.indexOf('<details class="desk-original">'), html.indexOf('</details>'));
        expect(details).toContain('<p>Satellite and regional radar imagery');
        expect(html).not.toContain('desk-copy-label');
        expect(html).toContain('Simplified by AI.');
        // order: AI deck → AI copy → details → rail
        const at = (m) => html.indexOf(m);
        expect(at('id="desk-deck"')).toBeLessThan(at('class="desk-copy"'));
        expect(at('class="desk-copy"')).toBeLessThan(at('<details class="desk-original">'));
        expect(at('</details>')).toBeLessThan(at('class="desk-rail"'));
    });

    it('escapes model output on the way into the page', async () => {
        serveLede({ deck: 'Gusts <img src=x onerror=alert(1)> & hail.', copy: ['<script>alert(1)</script> storms.'], issued: ISSUED });
        const res = await render();
        expect(res.body).not.toContain('<img src=x');
        expect(res.body).not.toContain('<script>alert(1)</script>');
        expect(res.body).toContain('Gusts &lt;img src=x onerror=alert(1)&gt; &amp; hail.');
        expect(res.body).toContain('<p>&lt;script&gt;alert(1)&lt;/script&gt; storms.</p>');
    });

    it('another issuance: the original copy, labelled, no details, no AI credit, short cache', async () => {
        // Both ways another outlook's text could be in the store: under its
        // own key (never read for this page), or — a corrupt or colliding
        // entry — under this page's key while naming another issuance.
        const OTHER = '2026-08-16T16:30:00+00:00';
        for (const seed of [
            () => serveLede({ deck: AI_DECK, copy: AI_COPY, issued: OTHER }, OTHER),
            () => serveLede({ deck: AI_DECK, copy: AI_COPY, issued: OTHER }),
        ]) {
            backend.store.clear();
            seed();
            const res = await render();
            expect(res.headers['cache-control']).toBe(NO_AI_CACHE);
            expect(res.body).not.toContain(AI_DECK);
            expect(res.body).not.toContain(AI_COPY[0]);
            expect(res.body).toContain('Thunderstorms with damaging wind gusts');
            expect(res.body).toContain('<p class="desk-copy-label">From the forecasters\' discussion, in their words</p>');
            expect(res.body).toContain('<p>Satellite and regional radar imagery');
            expect(res.body).not.toContain('<details');
            expect(res.body).not.toContain('Simplified by AI');
            expect(res.body).not.toContain('data-ai');
        }
    });

    it('no entry at all (empty store, a store error, or off Vercel): exactly the original page, short cache', async () => {
        const plain = [];
        for (const setBackend of [
            () => {}, // the empty in-memory store from beforeEach
            () => __setSharedCacheBackendForTests({
                get: async () => { throw new Error('store down'); },
                set: async () => {},
            }),
            () => __setSharedCacheBackendForTests(null), // off Vercel: no store at all
        ]) {
            setBackend();
            const res = await render();
            expect(res.statusCode).toBe(200);
            expect(res.headers['cache-control']).toBe(NO_AI_CACHE);
            expect(res.body).toContain('desk-copy-label');
            expect(res.body).not.toContain('Simplified by AI');
            expect(res.body).not.toContain('<details');
            plain.push(res.body.replace(/<time [^>]*>[^<]*<\/time>/g, ''));
        }
        expect(plain[1]).toBe(plain[0]);
        expect(plain[2]).toBe(plain[0]);
        expect(fetches.calls).toEqual([]);
    });

    it('deck only (the copy call failed): AI deck embedded, original copy labelled, short cache', async () => {
        // What /api/national-lede stores when the copy call failed: no copy key.
        serveLede({ issued: ISSUED, deck: AI_DECK });
        const res = await render();
        expect(res.body).toContain(`id="desk-deck" data-ai>${AI_DECK}</p>`);
        expect(res.body).toContain('desk-copy-label');
        expect(res.body).not.toContain('<details');
        expect(res.body).toContain('Simplified by AI.'); // the deck is AI text
        expect(res.headers['cache-control']).toBe(NO_AI_CACHE);
    });

    it('copy only (the deck failed): deterministic deck, AI copy embedded, short cache', async () => {
        // What /api/national-lede stores when the deck call failed: no deck key.
        serveLede({ issued: ISSUED, copy: AI_COPY });
        const res = await render();
        expect(res.body).toContain('<p class="desk-deck" id="desk-deck">Thunderstorms with damaging wind gusts');
        expect(res.body).toContain(`<p>${AI_COPY[0]}</p>`);
        expect(res.body).toContain('<details class="desk-original">');
        expect(res.body).toContain('Simplified by AI.');
        expect(res.headers['cache-control']).toBe(NO_AI_CACHE);
    });

    it('no discussion (summary runs as copy): AI deck fills the slot, copy never replaced, long cache', async () => {
        mockOutlooks.DY1 = { productText: swody1.productText, issuanceTime: swody1.issuanceTime };
        // Even a (bogus) copy in the answer must not replace the SUMMARY.
        serveLede({ deck: AI_DECK, copy: AI_COPY, issued: swody1.issuanceTime }, swody1.issuanceTime);
        const res = await render();
        expect(res.body).toContain(`id="desk-deck" data-ai>${AI_DECK}</p>`);
        expect(res.body).toContain('<section class="desk-copy" data-source="summary">');
        expect(res.body).toContain('Thunderstorms with severe wind gusts');
        expect(res.body).not.toContain(AI_COPY[0]);
        expect(res.body).not.toContain('<details');
        expect(res.headers['cache-control']).toBe(AI_CACHE);
    });

    it('the Markdown twin stays deterministic: same bytes with or without the AI text', async () => {
        const md = createReq({ headers: { accept: 'text/markdown' } });
        const without = await render(md);
        serveLede({ deck: AI_DECK, copy: AI_COPY, issued: ISSUED });
        const withAi = await render(createReq({ headers: { accept: 'text/markdown' } }));
        expect(withAi.body).toBe(without.body);
        expect(withAi.body).not.toContain(AI_DECK);
        expect(withAi.body).not.toContain('Simplified by AI');
        expect(withAi.body).toContain('Satellite and regional radar imagery');
    });
});

// ─── Content negotiation ────────────────────────────────────────────
// The National Desk answers `Accept: text/markdown` with the same composed
// desk as prose. The markdown is built from the same data the HTML builders
// consume, so these assert the two never disagree.
describe('GET /national/ with Accept: text/markdown', () => {
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

    const md = (accept = 'text/markdown') =>
        createReq({ headers: { accept } });

    it('serves Markdown from the same URL, with the RFC 7763 media type', async () => {
        const res = createRes();
        await handler(md(), res);
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
        expect(res.body.startsWith('# The National Desk')).toBe(true);
    });

    it('carries the census, the risk moment, the rail and the Wire', async () => {
        const res = createRes();
        await handler(md(), res);
        expect(res.body).toContain('**Census:**');
        expect(res.body).toContain('445 active alerts nationally');
        expect(res.body).toContain('risk of severe thunderstorms');
        expect(res.body).toContain('## Three-day severe outlook');
        expect(res.body).toContain('## The Wire');
        expect(res.body).toContain('Next Day 1 outlook expected by');
    });

    it('prints its times in US Eastern, as text', async () => {
        const res = createRes();
        await handler(md(), res);
        expect(res.body).toContain('. Outlook issued 8:44 AM EDT.'); // 12:44Z Aug 16
        expect(res.body).toMatch(/Next Day 1 outlook expected by \d{1,2}:\d{2} [AP]M E[SD]T · this page re-inks every 10 minutes\./);
        expect(res.body).not.toContain('UTC');
        expect(res.body).not.toContain('<time');
    });

    it('emits no HTML tags — the whole point of the Markdown variant', async () => {
        const res = createRes();
        await handler(md(), res);
        expect(res.body).not.toMatch(/<\/?(?:section|div|span|p|ul|li|h[1-6])\b/);
        expect(res.body).not.toContain('&nbsp;');
    });

    it('links covered offices to their desk and leaves uncovered ones unlinked', async () => {
        const res = createRes();
        await handler(md(), res);
        const covered = res.body.match(/\[[^\]]+\]\(https:\/\/plaincast\.live\/o\/[A-Z]{3}\/\)/g) || [];
        expect(covered.length).toBeGreaterThan(0);
    });

    it('sets Vary: Accept on BOTH variants', async () => {
        const html = createRes();
        await handler(createReq(), html);
        expect(html.headers.vary).toContain('Accept');

        const mdRes = createRes();
        await handler(md(), mdRes);
        expect(mdRes.headers.vary).toContain('Accept');
    });

    it('a real browser Accept header still gets the page', async () => {
        const res = createRes();
        await handler(md('text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'), res);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.body).toContain('<!DOCTYPE html>');
    });

    it('406s an Accept it cannot satisfy, without touching an upstream', async () => {
        severeThrows = true; // any fetch would throw and change the outcome
        const res = createRes();
        await handler(md('application/pdf'), res);
        expect(res.statusCode).toBe(406);
        expect(res.headers['cache-control']).toBe('no-store');
    });

    it('upstream down → the exact baked shell for HTML, an honest empty desk for Markdown', async () => {
        severeThrows = true;
        const html = createRes();
        await handler(createReq(), html);
        expect(html.statusCode).toBe(200);
        expect(html.body).toBe(SHELL);
        expect(html.headers.vary).toContain('Accept');

        const mdRes = createRes();
        await handler(md(), mdRes);
        expect(mdRes.statusCode).toBe(200);
        expect(mdRes.body).toContain('# The National Desk');
        expect(mdRes.body).toContain('No office is under a severe warning right now');
    });
});
