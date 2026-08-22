import { describe, it, expect } from 'bun:test';
import handler, { renderPageHtml, loadShell, pageJsonLd } from '../api/page.js';
import { PAGES, PAGE_SLUGS, pageTextLength, renderPageMarkdown } from '../api/_pages.js';
import { VARY } from '../api/_negotiate.js';

function mockRes() {
    const res = { headers: {}, code: 200, body: null };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
    res.getHeader = (k) => res.headers[k.toLowerCase()];
    res.status = (c) => { res.code = c; return res; };
    res.send = (b) => { res.body = b; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}
const get = (slug, accept) => ({
    method: 'GET', query: { slug }, headers: accept ? { accept } : {},
});

describe('trust anchor pages exist and are substantial', () => {
    it('ships /about, /contact, /developers and /privacy', () => {
        expect(PAGE_SLUGS.sort()).toEqual(['about', 'contact', 'developers', 'privacy']);
    });

    // The audit bar: "at least 500 characters of content each". Measured on
    // the prose an extractor would see, with link syntax removed.
    it('every page carries well over 500 characters of prose', () => {
        for (const slug of PAGE_SLUGS) {
            expect(pageTextLength(PAGES[slug])).toBeGreaterThan(500);
        }
    });

    it('the rendered HTML carries that prose too, not just the Markdown', () => {
        for (const slug of PAGE_SLUGS) {
            const html = renderPageHtml(loadShell(), PAGES[slug]);
            const text = html
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ').trim();
            expect(text.length).toBeGreaterThan(500);
            expect(html).toContain('<h1 class="nameplate">');
        }
    });

    it('leaves no unfilled template placeholders', () => {
        for (const slug of PAGE_SLUGS) {
            expect(renderPageHtml(loadShell(), PAGES[slug])).not.toMatch(/\{\{[A-Z_]+\}\}/);
        }
    });

    it('is self-canonical, advertises its Markdown alternate, and carries WebPage JSON-LD', () => {
        for (const slug of PAGE_SLUGS) {
            const html = renderPageHtml(loadShell(), PAGES[slug]);
            expect(html).toContain(`<link rel="canonical" href="https://plaincast.live/${slug}">`);
            expect(html).toContain(`<link rel="alternate" type="text/markdown" href="https://plaincast.live/${slug}">`);
            expect(html).toContain('"@type": "WebPage"');
        }
    });

    it('JSON-LD can never terminate the <script> element early', () => {
        expect(pageJsonLd(PAGES.about)).not.toMatch(/<\/script>[\s\S]*<\/script>/);
        expect(pageJsonLd({ ...PAGES.about, title: '</script><img src=x>' })).not.toContain('</script><img');
    });
});

describe('trust page content is accurate and on-brand', () => {
    // Standing rule: the public name is "Jonah Berg", never the hyphenated form.
    it('never uses the hyphenated surname anywhere', () => {
        for (const slug of PAGE_SLUGS) {
            const md = renderPageMarkdown(PAGES[slug]);
            expect(md).not.toContain('Berg-Ganzarain');
            expect(renderPageHtml(loadShell(), PAGES[slug])).not.toContain('Berg-Ganzarain');
        }
    });

    it('privacy names the real storage keys the app writes', () => {
        const md = renderPageMarkdown(PAGES.privacy);
        for (const key of ['theme', 'plaincast-office', 'plaincast-visits', 'plaincast-install-dismissed']) {
            expect(md).toContain(key);
        }
    });

    it('privacy names every third party that actually receives a request', () => {
        const md = renderPageMarkdown(PAGES.privacy);
        expect(md).toContain('api.weather.gov');
        expect(md).toContain('Anthropic');
        expect(md).toContain('Vercel');
    });

    it('contact routes to real, existing endpoints and invents no email address', () => {
        const md = renderPageMarkdown(PAGES.contact);
        expect(md).toContain('github.com/jonahberg/plaincast/issues');
        expect(md).toContain('/.well-known/security.txt');
        expect(md).not.toMatch(/[\w.]+@[\w.]+\.\w+/);
    });

    it('about states the NOAA non-affiliation', () => {
        expect(renderPageMarkdown(PAGES.about)).toContain('not affiliated');
    });

    it('site-relative links are absolutised in the Markdown representation', () => {
        const md = renderPageMarkdown(PAGES.about);
        expect(md).toContain('(https://plaincast.live/contact)');
        expect(md).not.toMatch(/\]\(\/[a-z]/);
    });
});

describe('page handler', () => {
    it('serves HTML by default with Vary and a long CDN window', async () => {
        const res = mockRes();
        await handler(get('about'), res);
        expect(res.code).toBe(200);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.headers.vary).toBe(VARY);
        expect(res.headers['cache-control']).toContain('s-maxage=');
        expect(res.body).toContain('About Plaincast');
    });

    it('serves Markdown to an agent, from the same URL', async () => {
        const res = mockRes();
        await handler(get('privacy', 'text/markdown'), res);
        expect(res.code).toBe(200);
        expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
        expect(res.headers.vary).toBe(VARY);
        expect(res.body.startsWith('# Privacy on Plaincast')).toBe(true);
    });

    it('406s an Accept it cannot satisfy', async () => {
        const res = mockRes();
        await handler(get('contact', 'application/pdf'), res);
        expect(res.code).toBe(406);
        expect(res.body).toContain('- text/markdown');
        expect(res.headers['cache-control']).toBe('no-store');
    });

    it('a real browser Accept header gets HTML, never Markdown', async () => {
        const res = mockRes();
        await handler(get('about', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'), res);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    });

    it('an unknown slug falls through to the 404 handler, not a blank page', async () => {
        const res = mockRes();
        await handler(get('nope', 'text/markdown'), res);
        expect(res.code).toBe(404);
        expect(res.body).toContain('sitemap.xml');
    });

    it('rejects non-GET', async () => {
        const res = mockRes();
        await handler({ method: 'POST', query: { slug: 'about' }, headers: {} }, res);
        expect(res.code).toBe(405);
    });
});

describe('inline prose markup', () => {
    it('renders `code` spans as <code>, leaving no stray backticks', () => {
        const html = renderPageHtml(loadShell(), PAGES.developers);
        expect(html).toContain('<code>Accept: text/markdown</code>');
        // the shell itself carries no backticks, so any survivor came from content
        expect(html.split('<body>')[1]).not.toContain('`');
    });

    it('keeps backticks intact in the Markdown representation', () => {
        expect(renderPageMarkdown(PAGES.developers)).toContain('`Accept: text/markdown`');
    });

    it('escapes before wrapping, so content can never inject markup', () => {
        const evil = { ...PAGES.about, blocks: [{ p: '`<img src=x onerror=1>`' }] };
        const html = renderPageHtml(loadShell(), evil);
        expect(html).toContain('<code>&lt;img src=x onerror=1&gt;</code>');
        expect(html).not.toContain('<img src=x');
    });
});

describe('the developer portal', () => {
    it('documents the endpoints, the Markdown contract and the error codes', () => {
        const md = renderPageMarkdown(PAGES.developers);
        for (const bit of ['/api/feed', '/api/conditions', '/api/og', '/api/whereami',
                           'Accept: text/markdown', 'invalid_office', '/openapi.json']) {
            expect(md).toContain(bit);
        }
    });

    it('is honest that there are no keys, no sandbox and no MCP server', () => {
        const md = renderPageMarkdown(PAGES.developers);
        for (const bit of ['no API keys', 'no sandbox', 'no MCP server']) {
            expect(md).toContain(bit);
        }
    });

    it('does not advertise the AI backend as a third-party API', () => {
        expect(renderPageMarkdown(PAGES.developers)).toContain('not supported for third-party use');
    });

    it('ships a runnable curl quickstart', () => {
        expect(renderPageMarkdown(PAGES.developers)).toContain('```bash');
        expect(renderPageHtml(loadShell(), PAGES.developers)).toContain('<pre class="page-pre">');
    });
});
