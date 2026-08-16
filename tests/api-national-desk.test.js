import { describe, it, test, expect, beforeEach, mock } from 'bun:test';
import { readFileSync } from 'node:fs';

// Handler tests drive the three national fetchers through mock.module rather
// than globalThis.fetch. Bun's module mocks are process-global: if another
// test file's partial '../api/_utils.js' stub (several predate the national
// fetchers) is registered when this handler resolves './_utils.js', a
// fetch-level stub would silently exercise a half-mocked module — the exact
// hazard documented in tests/national.test.js (~line 5). Module-mocking wins
// here; the fetchers' own wire-level coverage lives in national.test.js.
//
// Every export of _utils.js is stubbed, not just the three used here: this
// mock is process-global, so an unrelated later caller of, say,
// fetchAlertById must not land on undefined.
let mockFeatures = [];
let mockTotals = null;
let mockSpc = null;
let severeThrows = false;
let spcThrows = false;
mock.module('../api/_utils.js', () => ({
    fetchSevereAlerts: async () => { if (severeThrows) throw new Error('NWS down'); return mockFeatures; },
    fetchAlertTotals: async () => mockTotals, // soft upstream: never throws
    fetchSpcDy1: async () => { if (spcThrows) throw new Error('SPC down'); return mockSpc; },
    fetchAFDList: async () => [],
    fetchAFDProduct: async () => ({ productText: '', issuanceTime: null }),
    productUrlFromItem: (item) => item?.id || null,
    fetchAlertById: async () => null,
}));

const { default: handler, buildLedeHtml, buildWireHtml, buildCensusHtml } =
    await import('../api/national-desk.js');
const { default: alerts } = await import('./fixtures/national/severe-alerts.json');
const { default: swody1 } = await import('./fixtures/national/swody1.json');

// The fail-safe floor: byte-identical to the committed shell (same contract
// tests/national.test.js pins the marker against).
const SHELL = readFileSync('api/_national-shell.html', 'utf8');

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

describe('buildLedeHtml', () => {
    test('kicker from headline, deck from regex-translated summary, ai-deck slot present', () => {
        const html = buildLedeHtml({
            headline: 'THERE IS A SLIGHT RISK OF SEVERE THUNDERSTORMS',
            summary: 'Storms tonight.',
            issuanceTime: '2026-08-15T19:42:00+00:00',
        });
        expect(html).toContain('desk-kicker');
        expect(html).toContain('id="desk-deck"');
        expect(html).toContain('Storms tonight.');
        expect(html).toContain('Storm Prediction Center');
        // sentence-cased, not shouted, in the source text
        expect(html).toContain('There is a slight risk of severe thunderstorms');
        // SPC's own issuance convention: HHMM UTC
        expect(html).toContain('1942 UTC');
    });

    test('falls back to a neutral kicker when the headline is missing', () => {
        const html = buildLedeHtml({ headline: null, summary: 'Quiet.', issuanceTime: null });
        expect(html).toContain('The national outlook');
        expect(html).not.toContain('issued');
    });

    test('omits the issuance fragment when the timestamp is unparseable', () => {
        const html = buildLedeHtml({ headline: null, summary: 'Quiet.', issuanceTime: 'not-a-date' });
        expect(html).not.toContain('issued');
        expect(html).not.toContain('null');
        expect(html).not.toContain('NaN');
    });

    test('escapes HTML in upstream text', () => {
        const html = buildLedeHtml({ headline: '<img src=x>', summary: 'a & b <script>', issuanceTime: null });
        expect(html).not.toContain('<img');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&amp;');
    });

    test('throws when summary missing (handler falls back to baked)', () => {
        expect(() => buildLedeHtml({ headline: null, summary: null, issuanceTime: null })).toThrow();
    });
});

describe('buildWireHtml', () => {
    const row = (over) => ({ code: 'LOT', city: 'Chicago', event: 'Tornado Warning', count: 2, extreme: true, ...over });

    test('covered office links to its desk; uncovered renders unlinked', () => {
        const html = buildWireHtml([row(), row({ code: 'CYS', city: null, extreme: false })]);
        expect(html).toContain('href="/o/LOT/"');
        expect(html).not.toContain('href="/o/CYS/"');
        expect(html).toContain('CYS');
        expect(html).toContain('wire-extreme');
    });

    test('caps at 12 with an "and N more" line', () => {
        const rows = Array.from({ length: 15 }, (_, i) => row({ code: 'A' + String(i).padStart(2, '0'), city: null }));
        const html = buildWireHtml(rows);
        expect((html.match(/wire-item/g) || []).length).toBeLessThanOrEqual(13); // 12 + class in "more" line never uses wire-item
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

    test('escapes office-derived text', () => {
        const html = buildWireHtml([row({ code: '"><b>', city: '<script>x</script>', event: 'a & b' })]);
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<b>');
        expect(html).toContain('a &amp; b');
    });
});

describe('buildCensusHtml', () => {
    test('ledger markup with event counts and optional national total', () => {
        const html = buildCensusHtml([{ event: 'Flood Warning', count: 62 }], { total: 445 });
        expect(html).toContain('ledger');
        expect(html).toContain('Flood Warning');
        expect(html).toContain('62');
        expect(html).toContain('445');
        // mirrors docs/js/app.js ledgerCell() so the existing .ledger CSS applies
        expect(html).toContain('<dl class="ledger">');
        expect(html).toContain('<div class="ledger-cell"><dt>Flood Warning</dt><dd>62</dd></div>');
    });

    test('total omitted when totals null', () => {
        expect(buildCensusHtml([{ event: 'X', count: 1 }], null)).not.toContain('active products nationwide');
    });

    test('empty census renders nothing at all (no orphan <dl>)', () => {
        expect(buildCensusHtml([], { total: 445 })).toBe('');
    });

    test('escapes event names', () => {
        expect(buildCensusHtml([{ event: '<script>x</script>', count: 1 }], null)).not.toContain('<script>');
    });
});

describe('GET /api/national-desk (SSR /national/)', () => {
    beforeEach(() => {
        severeThrows = false;
        spcThrows = false;
        mockFeatures = alerts.features;
        mockTotals = { total: 445 };
        mockSpc = { productText: swody1.productText, issuanceTime: swody1.issuanceTime };
    });

    it('returns 405 for non-GET', async () => {
        const res = createRes();
        await handler(createReq({ method: 'POST' }), res);
        expect(res.statusCode).toBe(405);
    });

    it('serves the shell with a real lede, wire, and census rendered in', async () => {
        const res = createRes();
        await handler(createReq(), res);

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.headers['cache-control']).toBe('public, s-maxage=600, stale-while-revalidate=1800');

        // lede from the live SPC fixture, with the client-side AI deck slot
        expect(res.body).toContain('class="desk-lede"');
        expect(res.body).toContain('id="desk-deck"');
        expect(res.body).toContain('Thunderstorms with severe wind gusts');
        expect(res.body).toContain('There is a slight risk of severe thunderstorms');
        // the wire: covered offices link out, uncovered ones do not
        expect(res.body).toContain('class="wire"');
        expect(res.body).toContain('href="/o/PUB/"');
        expect(res.body).toContain('CYS');
        expect(res.body).not.toContain('href="/o/CYS/"');
        // the census ledger + the national total
        expect(res.body).toContain('<dl class="ledger">');
        expect(res.body).toContain('Flash Flood Warning');
        expect(res.body).toContain('445 active products nationwide');
        // the skeleton is replaced, not duplicated
        expect(res.body).not.toContain('id="desk-loading"');
        expect(res.body).not.toContain('Setting the type…');
        // still the shell document: masthead, office index, client bootstrap
        expect(res.body).toContain('<link rel="canonical" href="https://plaincast.live/national/">');
        expect(res.body).toContain('src="/js/national.js"');
        expect(res.body).toContain('id="local-desk"');
    });

    it('serves the EXACT baked shell when every upstream fails', async () => {
        severeThrows = true;
        spcThrows = true;
        mockTotals = null;
        const res = createRes();
        await handler(createReq(), res);

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.headers['cache-control']).toBe('public, s-maxage=300');
        expect(res.body).toBe(SHELL); // byte-identical to the committed shell
        expect(res.body).toContain('Setting the type…');
    });

    it('serves the baked shell when the SPC outlook is unavailable (no lede to print)', async () => {
        mockSpc = null;
        const res = createRes();
        await handler(createReq(), res);
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('public, s-maxage=300');
        expect(res.body).toBe(SHELL);
    });

    it('serves the baked shell when the SPC product has no parseable summary', async () => {
        mockSpc = { productText: 'no structure here', issuanceTime: null };
        const res = createRes();
        await handler(createReq(), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe(SHELL);
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
        expect(res.body).not.toContain('Setting the type…');
    });

    it('never interprets $-sequences from upstream text as replacement patterns', async () => {
        // A literal `$&` in the SPC summary would re-insert the whole matched
        // marker if the replacement were a plain string instead of a fn.
        mockSpc = {
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
    });
});
