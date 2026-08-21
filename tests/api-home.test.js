import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// api/home.js reaches api/office-page.js, which dynamically imports
// api/changelog.js (→ `ai` at module scope). Mock it so this suite is
// hermetic and can never hit the AI Gateway.
mock.module('ai', () => ({
    generateText: async () => { throw new Error('home must never call AI'); },
}));

let mockItems = [];
let mockProducts = {};
let mockListThrows = false;
// A module mock replaces the WHOLE module process-wide (Bun mocks are global),
// so every export of _utils.js must be stubbed here — see the same note in
// tests/api-office-page.test.js.
mock.module('../api/_utils.js', () => ({
    fetchSevereAlerts: async () => [],
    fetchAlertTotals: async () => null,
    fetchSpcDy1: async () => null,
    fetchSpcOutlook: async () => null,
    fetchAlertById: async () => null,
    fetchAFDList: async () => { if (mockListThrows) throw new Error('NWS down'); return mockItems; },
    fetchAFDProduct: async (url) => {
        if (!(url in mockProducts)) throw new Error(`unexpected product url ${url}`);
        return mockProducts[url];
    },
    productUrlFromItem: (item) => item?.id || null,
}));

const { default: handler, resolveOffice, editionSections, buildHomeSsr } = await import('../api/home.js');
const { VARY } = await import('../api/_negotiate.js');

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const TEMPLATE = readFileSync(join(DOCS, 'index.html'), 'utf8');

function mockRes() {
    const res = { headers: {}, code: 200, body: null };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
    res.getHeader = (k) => res.headers[k.toLowerCase()];
    res.status = (c) => { res.code = c; return res; };
    res.send = (b) => { res.body = b; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}
const get = (o = {}) => ({ method: 'GET', query: {}, headers: {}, ...o });

const AFD = `000
FXUS66 KLOX 031140
AFDLOX

Area Forecast Discussion
National Weather Service Los Angeles/Oxnard CA
440 AM PDT Thu Jul 3 2026

.SYNOPSIS...03/440 AM.
Low clouds and fog will continue each night and morning with a chc of
drizzle near the csts through the weekend across the region. Temps will
run near to slightly blw normal through Friday before a warming trend.

&&

.SHORT TERM (Today through Saturday)...
Marine layer around 1500 feet deep this morning. A wknd warming trend
is expected as high pressure builds over the region with temps abv
normal in the vlys by Saturday afternoon and evening. Expect areas of
night and morning low clouds to persist along the coast.

&&

.LONG TERM (Sunday through Wednesday)...
Models are in good agreement that troughing returns early next week
which will bring temperatures back down to near normal levels for the
first week of July across the entire forecast area.

$$
`;

beforeEach(() => {
    mockListThrows = false;
    mockItems = [{ id: 'https://api.weather.gov/products/curr' }];
    mockProducts = {
        'https://api.weather.gov/products/curr': {
            productText: AFD, issuanceTime: '2026-07-03T11:40:00+00:00',
        },
    };
});

describe('office resolution', () => {
    it('defaults to LOX, matching docs/js/app.js', () => {
        expect(resolveOffice(undefined)).toBe('LOX');
        expect(resolveOffice('')).toBe('LOX');
    });
    it('honours ?office= for real offices, case-insensitively', () => {
        expect(resolveOffice('okx')).toBe('OKX');
        expect(resolveOffice('LOT')).toBe('LOT');
    });
    it('never echoes an unknown or hostile ?office= value', () => {
        expect(resolveOffice('ZZZ')).toBe('LOX');
        expect(resolveOffice('"><script>alert(1)</script>')).toBe('LOX');
    });
});

describe('the homepage is readable without JavaScript', () => {
    it('renders real forecast prose into the #sections shell', async () => {
        const res = mockRes();
        await handler(get(), res);
        expect(res.code).toBe(200);
        expect(res.body).not.toContain('<div class="loading" id="loading">Setting the type…</div>');
        expect(res.body).toContain('class="forecast-section ssr"');
        expect(res.body).toContain('Los Angeles');
        // abbreviations expanded, so the prose is genuinely readable
        expect(res.body).toContain('temperatures above normal');
        expect(res.body).not.toContain('temps abv normal');
    });

    // The audit bar: an H1 and 500+ characters of text in the raw HTML.
    it('clears the raw-HTML content bar: an H1 and well over 500 characters of text', async () => {
        const res = mockRes();
        await handler(get(), res);
        expect(res.body).toMatch(/<h1[^>]*>\s*Plaincast\s*<\/h1>/);
        const text = res.body
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<select[\s\S]*?<\/select>/gi, '')  // the office picker is chrome, not content
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ').trim();
        expect(text.length).toBeGreaterThan(2500);
    });

    it('says what Plaincast is, in prose, without needing the forecast', async () => {
        const res = mockRes();
        await handler(get(), res);
        expect(res.body).toContain('class="ssr-standfirst"');
        expect(res.body).toContain('Area Forecast Discussion');
    });

    it('points at the canonical office page rather than duplicating it', async () => {
        const res = mockRes();
        await handler(get({ query: { office: 'OKX' } }), res);
        expect(res.body).toContain('href="/o/OKX/"');
        expect(res.body).toContain('New York');
        // Two sections on the homepage; /o/<CODE>/ is where all four live.
        expect(res.body.match(/class="forecast-section ssr"/g).length).toBeLessThanOrEqual(2);
    });

    it('leaves the rest of the page byte-identical to the committed template', async () => {
        const res = mockRes();
        await handler(get(), res);
        const marker = '<div class="loading" id="loading">Setting the type…</div>';
        const [head, tail] = TEMPLATE.split(marker);
        expect(res.body.startsWith(head)).toBe(true);
        expect(res.body.endsWith(tail)).toBe(true);
    });
});

describe('the homepage negotiates Markdown', () => {
    it('serves Markdown from the same URL, with Vary', async () => {
        const res = mockRes();
        await handler(get({ headers: { accept: 'text/markdown' } }), res);
        expect(res.code).toBe(200);
        expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
        expect(res.headers.vary).toBe(VARY);
        expect(res.body.startsWith('# Plaincast')).toBe(true);
        expect(res.body).toContain('## How to use it');
        expect(res.body).toContain("Today's edition");
    });

    it('sets Vary on the HTML variant too — the half that poisons the cache if missed', async () => {
        const res = mockRes();
        await handler(get(), res);
        expect(res.headers.vary).toBe(VARY);
    });

    it('406s an unsatisfiable Accept without touching the network', async () => {
        mockListThrows = true; // any fetch attempt would throw and change the result
        const res = mockRes();
        await handler(get({ headers: { accept: 'application/pdf' } }), res);
        expect(res.code).toBe(406);
        expect(res.body).toContain('- text/html');
    });

    it('a real browser Accept header gets HTML', async () => {
        const res = mockRes();
        await handler(get({ headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8' } }), res);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.body).toContain('<!DOCTYPE html>');
    });
});

describe('fail-safe: the homepage is never worse than today', () => {
    it('NWS down → the exact committed docs/index.html bytes, status 200', async () => {
        mockListThrows = true;
        const res = mockRes();
        await handler(get(), res);
        expect(res.code).toBe(200);
        expect(res.body).toBe(TEMPLATE);
        expect(res.headers['cache-control']).toBe('public, s-maxage=300');
        expect(res.headers.vary).toBe(VARY);
    });

    it('no AFD product listed → baked page', async () => {
        mockItems = [];
        const res = mockRes();
        await handler(get(), res);
        expect(res.body).toBe(TEMPLATE);
    });

    it('empty product text → baked page', async () => {
        mockProducts['https://api.weather.gov/products/curr'] = { productText: '' };
        const res = mockRes();
        await handler(get(), res);
        expect(res.body).toBe(TEMPLATE);
    });

    it('unparseable product → baked page rather than an empty #sections', async () => {
        mockProducts['https://api.weather.gov/products/curr'] = { productText: 'no sections here at all' };
        const res = mockRes();
        await handler(get(), res);
        expect(res.body).toBe(TEMPLATE);
    });

    it('on the fallback path Markdown still explains what Plaincast is', async () => {
        mockListThrows = true;
        const res = mockRes();
        await handler(get({ headers: { accept: 'text/markdown' } }), res);
        expect(res.code).toBe(200);
        expect(res.body).toContain('## How to use it');
        expect(res.body).not.toContain("Today's edition");
    });

    it('rejects non-GET', async () => {
        const res = mockRes();
        await handler(get({ method: 'POST' }), res);
        expect(res.code).toBe(405);
    });
});

describe('SSR assembly', () => {
    it('escapes forecast text into HTML', () => {
        const sections = [{ key: 'SYNOPSIS', paras: ['Winds <gusting> to 40 mph & "strong".'] }];
        const html = buildHomeSsr('LOX', 'Los Angeles', sections, 'Thursday');
        expect(html).toContain('&lt;gusting&gt;');
        expect(html).toContain('&amp;');
        expect(html).not.toContain('<gusting>');
    });

    it('a `$&` sequence in forecast text survives the template splice literally', async () => {
        mockProducts['https://api.weather.gov/products/curr'] = {
            // replacer fn: `$&` in a STRING replacement would be interpreted
            // here too, mangling the fixture before it reaches the handler.
            productText: AFD.replace('Low clouds and fog', () => 'Low clouds $& fog $1 $` sequences'),
            issuanceTime: '2026-07-03T11:40:00+00:00',
        };
        const res = mockRes();
        await handler(get(), res);
        expect(res.body).toContain('$&amp;');
    });

    it('throws rather than emitting an empty section list', () => {
        expect(() => buildHomeSsr('LOX', 'Los Angeles', [], null)).toThrow();
    });

    it('trims the edition to two sections', () => {
        expect(editionSections(AFD).length).toBe(2);
        expect(editionSections(AFD)[0].key).toBe('SYNOPSIS');
    });
});

describe('the shell-unavailable path never loops', () => {
    // A preview deploy on 2026-08-21 proved this is not hypothetical: with the
    // template missing from both bundles, home.js redirected to /o/LOX/ and
    // office-page.js redirected back, forever. Neither handler may redirect
    // into the other on a template failure.
    it('home.js contains no redirect into an office page', async () => {
        const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'home.js'), 'utf8');
        expect(src).not.toMatch(/Location.*\/o\/\$\{code\}/);
    });

    it('falls back to a real document with an H1, not a redirect', async () => {
        const { minimalHtml } = await import('../api/home.js');
        const html = minimalHtml('# Plaincast\n\nsome markdown');
        expect(html).toContain('<h1>Plaincast</h1>');
        expect(html).toContain('<link rel="canonical" href="https://plaincast.live">');
        expect(html).toContain('&lt;'.length ? '# Plaincast' : '');
    });

    it('escapes the markdown it wraps', async () => {
        const { minimalHtml } = await import('../api/home.js');
        expect(minimalHtml('<script>alert(1)</script>')).not.toContain('<script>alert(1)</script>');
    });
});
