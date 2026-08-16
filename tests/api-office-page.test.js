import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The handler dynamically imports api/changelog.js (for changedParagraphs),
// which imports `ai` at module scope — mock it so the test is hermetic and
// can never hit the AI Gateway.
mock.module('ai', () => ({
    generateText: async () => { throw new Error('office-page must never call AI'); },
}));

// items[0] = current issuance, items[1] = previous. productUrlFromItem →
// item.id, fetchAFDProduct(url) → the matching product.
let mockItems = [];
let mockProducts = {};
let mockListThrows = false;
mock.module('../api/_utils.js', () => ({
    // A module mock replaces the WHOLE module process-wide (Bun mocks are
    // global), so the National Desk fetchers must be stubbed here too —
    // omitting them makes api/national-desk.js fail to link when this file
    // loads first. Stub every export of _utils.js, always.
    fetchSevereAlerts: async () => [],
    fetchAlertTotals: async () => null,
    fetchSpcDy1: async () => null,
    fetchSpcOutlook: async () => null,
    fetchAFDList: async () => { if (mockListThrows) throw new Error('NWS down'); return mockItems; },
    fetchAFDProduct: async (url) => {
        if (!(url in mockProducts)) throw new Error(`unexpected product url ${url}`);
        return mockProducts[url];
    },
    productUrlFromItem: (item) => item?.id || null,
    // mock.module replaces the whole module — stub every export so an
    // unrelated caller of fetchAlertById can't hit undefined.
    fetchAlertById: async () => null,
}));

const { default: handler, buildSsrHtml, pickSections, sectionParagraphs, validEdition, pinEditionMeta } = await import('../api/office-page.js');
const { renderOfficePage } = await import('../scripts/build-offices.mjs');
const { extractSections } = await import('../api/_afd-sections.js');

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const template = readFileSync(join(DOCS, 'index.html'), 'utf8');
const BAKED_LOX = renderOfficePage(template, 'LOX', 'Los Angeles');

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

const CURR = `000
FXUS66 KLOX 031140
AFDLOX

Area Forecast Discussion
National Weather Service Los Angeles/Oxnard CA
440 AM PDT Thu Jul 3 2026

.SYNOPSIS...03/440 AM.
Low clouds and fog will continue each night and morning with a chc of
drizzle near the csts through the weekend across the region.

&&

.SHORT TERM (Today through Saturday)...
Marine layer around 1500 feet deep this morning. A wknd warming trend
is expected as high pressure builds over the region with temps abv
normal in the vlys by Saturday afternoon and evening.

&&

.LONG TERM (Sunday through Wednesday)...
Models are in good agreement that troughing returns early next week
bringing a cooling trend and increasing onshore flow across the area.

&&

.AVIATION...03/1140Z. VFR.

$$
`;

const PREV = CURR.replace(
    'A wknd warming trend',
    'A modest cooling trend'
);

let idCounter = 0;
function setScenario({ curr = CURR, prev = null } = {}) {
    const curId = `cur-${idCounter++}`;
    mockItems = [{ id: curId }];
    mockProducts = { [curId]: { productText: curr, issuanceTime: '2026-07-03T11:40:00+00:00' } };
    if (prev !== null) {
        const prevId = `prev-${idCounter++}`;
        mockItems.push({ id: prevId });
        mockProducts[prevId] = { productText: prev, issuanceTime: '2026-07-03T05:38:00+00:00' };
    }
}

describe('GET /api/office-page (SSR /o/<CODE>/ pages)', () => {
    beforeEach(() => { mockListThrows = false; });

    it('returns 405 for non-GET', async () => {
        const res = createRes();
        await handler(createReq({ method: 'POST', query: { code: 'LOX' } }), res);
        expect(res.statusCode).toBe(405);
    });

    it('returns 404 for an unknown office (same as the static filesystem today)', async () => {
        const res = createRes();
        await handler(createReq({ query: { code: 'ZZZ' } }), res);
        expect(res.statusCode).toBe(404);
    });

    it('serves the baked page with real regex-translated forecast prose injected', async () => {
        setScenario();
        const res = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), res);

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.headers['cache-control']).toBe('public, s-maxage=900, stale-while-revalidate=3600');

        // real prose, abbreviations expanded by regexTranslate (chc→chance, csts→coasts)
        expect(res.body).toContain('<article class="forecast-section ssr">');
        expect(res.body).toContain('Low clouds and fog');
        expect(res.body).toContain('chance of');
        expect(res.body).toContain('coasts');
        expect(res.body).toContain('valleys');
        // canonical narrative section names from SECTION_NAMES
        expect(res.body).toContain('<h2 class="section-title">Synopsis</h2>');
        expect(res.body).toContain('<h2 class="section-title">Short Term</h2>');
        // non-narrative sections stay out
        expect(res.body).not.toContain('<h2 class="section-title">Aviation</h2>');
        // the skeleton is replaced, not duplicated
        expect(res.body).not.toContain('Setting the type…');
        // still the baked per-office document (canonical + JS bootstrap intact)
        expect(res.body).toContain('<link rel="canonical" href="https://plaincast.live/o/LOX/">');
        expect(res.body).toContain('src="/js/app.js"');
        // links back into the interactive experience
        expect(res.body).toContain('/o/LOX/?view=changelog');
        expect(res.body).toContain('/?office=LOX');
    });

    it('adds a deterministic changelog line when the previous issuance differs (no AI)', async () => {
        setScenario({ prev: PREV });
        const res = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('Revised in 1 passage');
        expect(res.body).toContain('See every revision');
    });

    it('omits the changelog line when nothing changed', async () => {
        setScenario({ prev: CURR });
        const res = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain('Revised in');
    });

    it('normalizes lowercase codes', async () => {
        setScenario();
        const res = createRes();
        await handler(createReq({ query: { code: 'lox' } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('<link rel="canonical" href="https://plaincast.live/o/LOX/">');
    });

    const EDITION = 'a1b2c3d4-5566-7788-99aa-bbccddeeff00';

    it('pins the OG/twitter/og:url meta to a valid ?edition= permalink', async () => {
        setScenario();
        const res = createRes();
        await handler(createReq({ query: { code: 'LOX', edition: EDITION } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain(`<meta property="og:image" content="https://plaincast.live/api/og?office=LOX&amp;id=${EDITION}">`);
        expect(res.body).toContain(`<meta name="twitter:image" content="https://plaincast.live/api/og?office=LOX&amp;id=${EDITION}">`);
        expect(res.body).toContain(`<meta property="og:url" content="https://plaincast.live/o/LOX/?edition=${EDITION}">`);
        // canonical stays deduped at /o/LOX/ (no ?edition=)
        expect(res.body).toContain('<link rel="canonical" href="https://plaincast.live/o/LOX/">');
        // no latent generic-latest og:image left over
        expect(res.body).not.toContain('<meta property="og:image" content="https://plaincast.live/api/og?office=LOX">');
    });

    it('ignores a malformed edition param (keeps latest-edition meta, no HTML injection)', async () => {
        setScenario();
        const res = createRes();
        await handler(createReq({ query: { code: 'LOX', edition: '"><script>x' } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('<meta property="og:image" content="https://plaincast.live/api/og?office=LOX">');
        expect(res.body).not.toContain('&amp;id=');
        expect(res.body).not.toContain('<script>x');
    });

    it('carries the pinned meta even on the baked fallback path (NWS down)', async () => {
        mockListThrows = true;
        const res = createRes();
        await handler(createReq({ query: { code: 'LOX', edition: EDITION } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain(`<meta property="og:image" content="https://plaincast.live/api/og?office=LOX&amp;id=${EDITION}">`);
        expect(res.body).toContain(`<meta property="og:url" content="https://plaincast.live/o/LOX/?edition=${EDITION}">`);
    });

    it('serves the EXACT unmodified baked page when NWS is unreachable', async () => {
        mockListThrows = true;
        const res = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('public, s-maxage=300');
        expect(res.body).toBe(BAKED_LOX); // byte-identical to today's static page
        expect(res.body).toContain('Setting the type…');
    });

    it('serves the baked page when the AFD product is empty', async () => {
        const id = `empty-${idCounter++}`;
        mockItems = [{ id }];
        mockProducts = { [id]: { productText: '', issuanceTime: 'x' } };
        const res = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('public, s-maxage=300');
        expect(res.body).toBe(BAKED_LOX);
    });

    it('serves the baked page when the product fetch fails', async () => {
        mockItems = [{ id: 'boom' }];
        mockProducts = {}; // fetchAFDProduct throws for unknown urls
        const res = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe(BAKED_LOX);
    });
});

describe('office-page helpers', () => {
    it('pickSections prefers narrative sections in document order, capped at 4', () => {
        const sections = extractSections(CURR);
        const picked = pickSections(sections);
        expect(picked.map(s => s.key)).toEqual(['SYNOPSIS', 'SHORT TERM', 'LONG TERM']);
    });

    it('sectionParagraphs strips issuance-timestamp remnants and short noise', () => {
        const [first] = sectionParagraphs('03/440 AM.\nLow clouds and fog will continue each night and morning near the coast.');
        expect(first.startsWith('Low clouds')).toBe(true);
    });

    it('buildSsrHtml throws (→ baked fallback) when no section is renderable', () => {
        expect(() => buildSsrHtml('LOX', 'Los Angeles', 'VFR.', '2026-07-03T11:40:00+00:00', '')).toThrow();
    });

    it('buildSsrHtml escapes NWS-derived text', () => {
        const text = '.SYNOPSIS...\nA <script>alert(1)</script> test paragraph that is long enough to keep here.\n\n$$';
        const html = buildSsrHtml('LOX', 'Los Angeles', text, '2026-07-03T11:40:00+00:00', '');
        expect(html).not.toContain('<script>alert');
        expect(html).toContain('&lt;script&gt;');
    });

    it('validEdition accepts UUID-ish ids and rejects everything else', () => {
        expect(validEdition('a1b2c3d4-5566-7788-99aa-bbccddeeff00')).toBe('a1b2c3d4-5566-7788-99aa-bbccddeeff00');
        expect(validEdition('AFDLOX.2026.07.03:1140')).toBe('AFDLOX.2026.07.03:1140');
        expect(validEdition('')).toBeNull();
        expect(validEdition(undefined)).toBeNull();
        expect(validEdition('has space')).toBeNull();
        expect(validEdition('"><script>')).toBeNull();
        expect(validEdition('a/b')).toBeNull(); // slash not allowed
        expect(validEdition('x'.repeat(65))).toBeNull(); // over 64 chars
    });

    it('pinEditionMeta rewrites both image tags + og:url, leaves canonical alone', () => {
        const html = renderOfficePage(template, 'LOX', 'Los Angeles');
        const pinned = pinEditionMeta(html, 'LOX', 'EDT-1');
        expect(pinned).toContain('content="https://plaincast.live/api/og?office=LOX&amp;id=EDT-1"');
        expect(pinned).toContain('<meta property="og:url" content="https://plaincast.live/o/LOX/?edition=EDT-1">');
        expect(pinned).toContain('<link rel="canonical" href="https://plaincast.live/o/LOX/">');
    });
});
