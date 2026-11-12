import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
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

// The production shell is the shadcn app shell (scripts/app-shell.mjs) —
// the same bytes committed as api/_home-shell.html.
const { buildAppShell } = await import('../scripts/app-shell.mjs');
const template = buildAppShell();
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
        // No VERCEL_* env here, so the boot block carries no AI translations
        // and the page takes the short CDN window (see the boot-data suite
        // below for the full window with translations embedded).
        expect(res.headers['cache-control']).toBe('public, s-maxage=120, stale-while-revalidate=3600');

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
        expect(res.body).toContain('src="/assets/app.js"');
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

// ─── Content negotiation ────────────────────────────────────────────
// /o/<CODE>/ is the URL an agent most wants as prose: it IS the decoded
// discussion. These pin that the Markdown twin carries the same sections as
// the SSR HTML, and that Vary is set on every path.
describe('GET /o/<CODE>/ with Accept: text/markdown', () => {
    beforeEach(() => {
        mockListThrows = false;
        // PREV differs from CURR, so the deterministic changelog line renders.
        setScenario({ prev: PREV });
    });

    const md = (accept = 'text/markdown', o = {}) =>
        createReq({ query: { code: 'LOX' }, headers: { accept }, ...o });

    it('serves Markdown from the same URL, with the RFC 7763 media type', async () => {
        const res = createRes();
        await handler(md(), res);
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
        expect(res.body.startsWith('# Los Angeles (LOX)')).toBe(true);
    });

    it('carries the same sections as the SSR HTML, as headings', async () => {
        const htmlRes = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), htmlRes);
        const htmlHeadings = [...htmlRes.body.matchAll(/<h2 class="section-title">([^<]+)<\/h2>/g)].map(m => m[1]);

        const mdRes = createRes();
        await handler(md(), mdRes);
        const mdHeadings = [...mdRes.body.matchAll(/^## (.+)$/gm)].map(m => m[1]);

        expect(htmlHeadings.length).toBeGreaterThan(0);
        for (const h of htmlHeadings) expect(mdHeadings).toContain(h);
    });

    it('emits no HTML tags and names its canonical URL', async () => {
        const res = createRes();
        await handler(md(), res);
        expect(res.body).not.toMatch(/<\/?(?:article|div|span|p|h[1-6])\b/);
        expect(res.body).toContain('_Canonical: https://plaincast.live/o/LOX/_');
    });

    it('never calls AI for the Markdown variant', async () => {
        // The `ai` module is mocked at the top of this file to throw on use.
        const res = createRes();
        await handler(md(), res);
        expect(res.statusCode).toBe(200);
    });

    it('carries the deterministic changelog line as prose when there is one', async () => {
        const res = createRes();
        await handler(md(), res);
        // PREV/CURR fixtures differ, so a revision line is expected.
        expect(res.body).toMatch(/Revised in \d+ passages?/);
        expect(res.body).toContain('?view=changelog');
    });

    it('sets Vary: Accept on BOTH variants', async () => {
        const htmlRes = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), htmlRes);
        expect(htmlRes.headers.vary).toContain('Accept');

        const mdRes = createRes();
        await handler(md(), mdRes);
        expect(mdRes.headers.vary).toContain('Accept');
    });

    it('a real browser Accept header still gets the baked page', async () => {
        const res = createRes();
        await handler(md('text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'), res);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.body).toContain('<!DOCTYPE html>');
    });

    it('406s an Accept it cannot satisfy, without touching NWS', async () => {
        mockListThrows = true; // any fetch would throw and change the outcome
        const res = createRes();
        await handler(md('application/pdf'), res);
        expect(res.statusCode).toBe(406);
        expect(res.headers['cache-control']).toBe('no-store');
        mockListThrows = false;
    });

    it('NWS down → exact baked page for HTML, a truthful stub for Markdown', async () => {
        mockListThrows = true;
        const htmlRes = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), htmlRes);
        expect(htmlRes.body).toBe(BAKED_LOX);
        expect(htmlRes.headers.vary).toContain('Accept');

        const mdRes = createRes();
        await handler(md(), mdRes);
        expect(mdRes.statusCode).toBe(200);
        expect(mdRes.body).toContain('# Los Angeles (LOX)');
        mockListThrows = false;
    });

    it('an unknown office 404s with the recovery body, not two words', async () => {
        const res = createRes();
        await handler(createReq({ query: { code: 'ZZZ' }, headers: { accept: 'text/markdown' } }), res);
        expect(res.statusCode).toBe(404);
        expect(res.body).toContain('sitemap.xml');
        expect(res.body).not.toBe('Not found');
    });
});

// ─── Boot data (one-pass load) ──────────────────────────────────────
// The page embeds the edition it fetched, plus the AI translations and
// changelog sentence the site's CDN already holds (api/_boot.js), so the
// app's first paint is the finished page. The self-fetch goes through
// api/_self.js: stubbed here with VERCEL_URL + a fetch stub, the same way
// tests/api-self.test.js drives it.
describe('GET /o/<CODE>/ boot data', () => {
    const ENV_KEYS = ['VERCEL_ENV', 'VERCEL_URL', 'VERCEL_AUTOMATION_BYPASS_SECRET'];
    const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    const savedFetch = globalThis.fetch;
    let selfCalls = [];

    const restore = () => {
        for (const k of ENV_KEYS) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
        globalThis.fetch = savedFetch;
    };
    // `respond(path)` → a JSON body, or null for a 503.
    function stubSelf(respond) {
        for (const k of ENV_KEYS) delete process.env[k];
        process.env.VERCEL_URL = 'plaincast-test.vercel.app';
        selfCalls = [];
        globalThis.fetch = async (url) => {
            const u = new URL(String(url));
            selfCalls.push(u.pathname + u.search);
            const body = respond(u.pathname, u.searchParams);
            return body ? Response.json(body) : new Response('no', { status: 503 });
        };
    }
    function bootOf(html) {
        const m = html.match(/<script type="application\/json" id="plaincast-boot">([^<]*)<\/script>/);
        return m ? JSON.parse(m[1]) : null;
    }

    beforeEach(() => { mockListThrows = false; restore(); });
    afterEach(restore);

    it('embeds the product it served, before the app script, as inert JSON', async () => {
        setScenario();
        const res = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), res);
        const boot = bootOf(res.body);
        expect(boot).not.toBe(null);
        expect(boot.v).toBe(1);
        expect(boot.office).toBe('LOX');
        expect(boot.product.id).toBe(mockItems[0].id);
        expect(boot.product.productText).toBe(CURR);
        expect(boot.product.issuanceTime).toBe('2026-07-03T11:40:00+00:00');
        // Off-Vercel (no self origin): no translations, and the short window.
        expect(boot.translations).toBe(null);
        expect(boot.translationsComplete).toBe(false);
        expect('changelog' in boot).toBe(false);
        expect(res.headers['cache-control']).toBe('public, s-maxage=120, stale-while-revalidate=3600');
        // Outside <main>, right before the module script.
        expect(res.body).toMatch(/<\/script>\n {4}<script type="module" crossorigin src="\/assets\/app\.js"><\/script>/);
        expect(res.body.indexOf('id="plaincast-boot"')).toBeGreaterThan(res.body.lastIndexOf('</main>'));
    });

    it('the only inline scripts are data blocks (CSP script-src \'self\' stays sufficient)', async () => {
        setScenario();
        const res = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), res);
        const inline = [...res.body.matchAll(/<script\b([^>]*)>/g)].map(m => m[1]).filter(attrs => !/\bsrc=/.test(attrs));
        expect(inline.length).toBeGreaterThan(0);
        for (const attrs of inline) {
            expect(attrs).toMatch(/type="application\/(?:ld\+)?json"/);
        }
    });

    it('serialises </script>, <!--, & and U+2028/2029 in the forecast text safely', async () => {
        const nasty = CURR.replace('Low clouds and fog',
            'Low </script><script>alert(1)</script> <!-- & \u2028\u2029 fog');
        setScenario({ curr: nasty });
        const res = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), res);
        const m = res.body.match(/<script type="application\/json" id="plaincast-boot">([\s\S]*?)<\/script>/);
        expect(m).not.toBe(null);
        const raw = m[1];
        expect(raw).not.toContain('<');
        expect(raw).not.toContain('>');
        expect(raw).not.toContain('&');
        expect(raw).not.toMatch(/[\u2028\u2029]/);
        // …and it still round-trips to the exact text.
        expect(JSON.parse(raw).product.productText).toBe(nasty);
        // The block ends where it should: the app script still follows it.
        expect(res.body).toContain('src="/assets/app.js"');
        expect(res.body).not.toContain('<script>alert(1)</script>');
    });

    it('embeds complete translations + the changelog and keeps the full CDN window', async () => {
        setScenario();
        const id = mockItems[0].id;
        stubSelf((path, q) => {
            if (path === '/api/translate-issuance') {
                expect(q.get('office')).toBe('LOX');
                expect(q.get('id')).toBe(id);
                return { office: 'LOX', id, complete: true, sections: { Synopsis: 'Fog **near the coast**.', 'Short Term': 'Warmer.', Bogus: 42 } };
            }
            if (path === '/api/changelog') {
                return { changelog: 'Warmer this weekend.', since: '2026-07-03T05:38:00+00:00', updated: '2026-07-03T11:40:00Z' };
            }
            return null;
        });
        const res = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), res);
        const boot = bootOf(res.body);
        expect(boot.translations).toEqual({ Synopsis: 'Fog **near the coast**.', 'Short Term': 'Warmer.' });
        expect(boot.translationsComplete).toBe(true);
        expect(boot.changelog).toEqual({ changelog: 'Warmer this weekend.', since: '2026-07-03T05:38:00+00:00', updated: '2026-07-03T11:40:00Z' });
        expect(res.headers['cache-control']).toBe('public, s-maxage=900, stale-while-revalidate=3600');
        expect(selfCalls.sort()).toEqual([
            '/api/changelog?office=LOX',
            `/api/translate-issuance?office=LOX&id=${id}`,
        ]);
    });

    it('a partial translation is embedded but flagged incomplete, with the short window', async () => {
        setScenario();
        stubSelf((path) => (path === '/api/translate-issuance'
            ? { office: 'LOX', id: mockItems[0].id, complete: false, sections: { Synopsis: 'Fog.' } }
            : null));
        const res = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), res);
        const boot = bootOf(res.body);
        expect(boot.translations).toEqual({ Synopsis: 'Fog.' });
        expect(boot.translationsComplete).toBe(false);
        expect(res.headers['cache-control']).toBe('public, s-maxage=120, stale-while-revalidate=3600');
    });

    it('a failed self-fetch renders exactly the page plus the product block', async () => {
        setScenario();
        stubSelf(() => null); // 503 for everything
        const res = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), res);
        const boot = bootOf(res.body);
        expect(boot.translations).toBe(null);
        expect(boot.translationsComplete).toBe(false);
        expect('changelog' in boot).toBe(false);
        restore();
        const plain = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), plain);
        const strip = (html) => html.replace(/<script type="application\/json" id="plaincast-boot">[^<]*<\/script>\n {4}/, '');
        expect(strip(res.body)).toBe(strip(plain.body));
    });

    it('a translation for another edition, or a changelog for another issuance, is not embedded', async () => {
        setScenario();
        stubSelf((path) => {
            if (path === '/api/translate-issuance') return { office: 'LOX', id: 'some-other-id', complete: true, sections: { Synopsis: 'x' } };
            if (path === '/api/changelog') return { changelog: 'Old news.', updated: '2026-07-02T23:00:00Z' };
            return null;
        });
        const res = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), res);
        const boot = bootOf(res.body);
        expect(boot.translations).toBe(null);
        expect('changelog' in boot).toBe(false);
    });

    it('a definitive "nothing changed" changelog is embedded as null; a transient one is not', async () => {
        setScenario();
        stubSelf((path) => (path === '/api/changelog' ? { changelog: null, since: null, updated: '2026-07-03T11:40:00+00:00' } : null));
        let res = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), res);
        expect(bootOf(res.body).changelog).toEqual({ changelog: null, since: null, updated: '2026-07-03T11:40:00+00:00' });

        stubSelf((path) => (path === '/api/changelog' ? { changelog: null, transient: true } : null));
        res = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), res);
        expect('changelog' in bootOf(res.body)).toBe(false);
    });

    it('?edition= permalinks and the ?view=changelog ledger carry no block and keep the full window', async () => {
        for (const query of [{ code: 'LOX', edition: 'a1b2c3d4-5566-7788-99aa-bbccddeeff00' }, { code: 'LOX', view: 'changelog' }]) {
            setScenario();
            stubSelf(() => { throw new Error('no self-fetch expected'); });
            const res = createRes();
            await handler(createReq({ query }), res);
            expect(res.statusCode).toBe(200);
            expect(res.body).not.toContain('id="plaincast-boot"');
            expect(res.headers['cache-control']).toBe('public, s-maxage=900, stale-while-revalidate=3600');
            expect(selfCalls).toEqual([]);
        }
    });

    it('the baked fallback (NWS down) carries no block and is still byte-identical', async () => {
        mockListThrows = true;
        const res = createRes();
        await handler(createReq({ query: { code: 'LOX' } }), res);
        expect(res.body).toBe(BAKED_LOX);
        expect(res.body).not.toContain('plaincast-boot');
    });

    it('Markdown is unaffected: no self-fetch, no block, the full window', async () => {
        setScenario({ prev: PREV });
        stubSelf(() => { throw new Error('no self-fetch expected'); });
        const res = createRes();
        await handler(createReq({ query: { code: 'LOX' }, headers: { accept: 'text/markdown' } }), res);
        expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
        expect(res.body).not.toContain('plaincast-boot');
        expect(res.headers['cache-control']).toBe('public, s-maxage=900, stale-while-revalidate=3600');
        expect(selfCalls).toEqual([]);
    });
});
