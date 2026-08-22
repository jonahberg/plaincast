import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_SLUGS } from '../api/_pages.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

const vercel = JSON.parse(read('vercel.json'));
const rewrites = vercel.rewrites;
const llms = read('docs', 'llms.txt');
const vercelignore = read('.vercelignore');

// The routing order is the fragile part of this whole feature: Vercel
// evaluates rewrites in order, AFTER `handle: filesystem`. Get the order
// wrong and either the catch-all eats a real route, or the homepage keeps
// serving a static shell and api/home.js never runs.
describe('vercel.json routing invariants', () => {
    const sources = rewrites.map(r => r.source);
    const idx = (s) => sources.indexOf(s);

    it('routes / to the server-rendered homepage', () => {
        expect(rewrites.find(r => r.source === '/')?.destination).toBe('/api/home');
    });

    it('excludes docs/index.html from the static output, or the / rewrite is shadowed', () => {
        // Rewrites run after the filesystem check, so a deployed static
        // docs/index.html would win and api/home.js would never execute.
        expect(vercelignore).toMatch(/^docs\/index\.html$/m);
        expect(vercelignore).toMatch(/^docs\/o$/m);
    });

    it('ships the homepage shell from api/, not from the ignored docs/index.html', () => {
        // .vercelignore removes a file from the FUNCTION bundle as well as the
        // static output — verified on a preview deploy, where both handlers
        // lost their template and 307-looped against each other. The shell the
        // functions load must therefore be the api/ twin.
        expect(vercel.functions['api/home.js'].includeFiles).toBe('api/_home-shell.html');
        expect(vercel.functions['api/office-page.js'].includeFiles).toBe('api/_home-shell.html');
        expect(vercelignore).not.toMatch(/^api\/_home-shell\.html$/m);
    });

    it('ships the trust-page shell with api/page.js', () => {
        expect(vercel.functions['api/page.js'].includeFiles).toBe('api/_page-shell.html');
    });

    it('routes the developer portal', () => {
        expect(rewrites.find(r => r.source === '/developers')?.destination).toBe('/api/page?slug=developers');
        expect(rewrites.find(r => r.source === '/developers/')?.destination).toBe('/api/page?slug=developers');
    });

    it('routes every trust page, with and without a trailing slash', () => {
        for (const slug of PAGE_SLUGS) {
            expect(rewrites.find(r => r.source === `/${slug}`)?.destination).toBe(`/api/page?slug=${slug}`);
            expect(rewrites.find(r => r.source === `/${slug}/`)?.destination).toBe(`/api/page?slug=${slug}`);
        }
    });

    it('puts the 404 catch-all LAST, so it can never shadow a real route', () => {
        const last = rewrites[rewrites.length - 1];
        expect(last.destination).toBe('/api/not-found');
        expect(last.source).toContain(':path');
    });

    it('exempts /_vercel/ from the catch-all (analytics + speed insights)', () => {
        const last = rewrites[rewrites.length - 1];
        expect(last.source).toContain('(?!_vercel/)');
        // and the pattern the platform generates must actually reject it
        const re = new RegExp('^(?:/((?!_vercel/).*))$');
        expect(re.test('/_vercel/insights/script.js')).toBe(false);
        expect(re.test('/nonexistent-path')).toBe(true);
    });

    it('every pre-existing route still comes before the catch-all', () => {
        const catchAll = sources.length - 1;
        for (const s of ['/api/:path*', '/o/:code', '/o/:code/', '/national', '/national/', '/']) {
            expect(idx(s)).toBeGreaterThanOrEqual(0);
            expect(idx(s)).toBeLessThan(catchAll);
        }
    });

    it('leaves the sitewide security headers untouched', () => {
        const csp = JSON.stringify(vercel.headers);
        expect(csp).toContain("script-src 'self'");
        expect(csp).toContain('X-Frame-Options');
    });
});

// The audit finding: "No agent instruction file with when-to-use guidance."
describe('llms.txt tells agents when to reach for Plaincast', () => {
    it('has a when-to-use section', () => {
        expect(llms).toContain('## When to use Plaincast');
    });

    it('names concrete good fits and concrete poor fits, not marketing copy', () => {
        expect(llms).toContain('**Good fits');
        expect(llms).toContain('**Poor fits');
        // a poor fit must be a real refusal, not a humblebrag
        expect(llms).toContain('Life-safety decisions');
        expect(llms).toContain('outside the United States');
    });

    it('documents how to call it, including the Markdown contract', () => {
        expect(llms).toContain('**How to call it');
        expect(llms).toContain('Accept: text/markdown');
        expect(llms).toContain('Vary: Accept');
        expect(llms).toContain('406');
        expect(llms).toContain('https://plaincast.live/o/<CODE>/');
        expect(llms).toContain('?view=changelog');
    });

    it('links the trust anchors and the machine-readable index', () => {
        for (const slug of PAGE_SLUGS) {
            expect(llms).toContain(`https://plaincast.live/${slug}`);
        }
        expect(llms).toContain('https://plaincast.live/sitemap.xml');
        expect(llms).toContain('.well-known/security.txt');
    });

    it('names the developer resources at predictable URLs', () => {
        expect(llms).toContain('## Developer resources');
        expect(llms).toContain('https://plaincast.live/developers');
        expect(llms).toContain('https://plaincast.live/openapi.json');
        // named with the product in them, for name-based search
        expect(llms).toContain('**Plaincast developer documentation:**');
        expect(llms).toContain('**Plaincast OpenAPI specification:**');
    });

    it('is honest about what does not exist', () => {
        expect(llms).toContain('no MCP server');
        expect(llms).toContain('No API keys');
    });

    it('states the NOAA non-affiliation', () => {
        expect(llms).toContain('not affiliated');
    });
});

// The Ora audit reported "no H1 tag" against a page whose masthead H1 was right
// there in the raw HTML. Reproducing their character count pinned the cause: a
// main-content extractor that strips <header>, <footer> and form controls as
// boilerplate — which removed the ONLY H1 on every page. Each page now carries a
// second H1 inside <main> naming that page's own content. This test IS the
// diagnosis: if the main-content H1 is ever removed, it fails.
describe('every page keeps an H1 after boilerplate stripping', () => {
    const strip = (html) => html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<select[\s\S]*?<\/select>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '');
    const textOf = (html) => strip(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    const templates = {
        'docs/index.html': read('docs', 'index.html'),
        'docs/o/OKX/index.html': read('docs', 'o', 'OKX', 'index.html'),
        'api/_national-shell.html': read('api', '_national-shell.html'),
        'api/_page-shell.html': read('api', '_page-shell.html'),
    };

    for (const [name, html] of Object.entries(templates)) {
        it(`${name} still has an H1 once header/footer/select are stripped`, () => {
            expect(strip(html)).toMatch(/<h1[\s>]/);
        });
    }

    it('the surviving H1 sits inside <main>, where the content is', () => {
        for (const [name, html] of Object.entries(templates)) {
            const main = html.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);
            expect(main, `${name} has a <main>`).toBeTruthy();
            expect(main[1]).toMatch(/<h1[\s>]/);
        }
    });

    it('names the product, so a name-based search has something to match', () => {
        for (const [name, html] of Object.entries(templates)) {
            const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map(m => m[1]);
            expect(h1s.join(' ')).toContain('Plaincast');
        }
    });

    it('per-office pages name their own office, not the generic homepage text', () => {
        const okx = read('docs', 'o', 'OKX', 'index.html');
        expect(okx).toContain('<h1 class="sr-only">New York (OKX)');
        expect(okx).not.toContain('<h1 class="sr-only">Plaincast — the National Weather Service forecast, decoded');
    });

    it('the static template alone clears 500+ characters after stripping', () => {
        // The served page adds the SSR forecast digest on top of this floor.
        expect(textOf(read('docs', 'index.html')).length).toBeGreaterThan(500);
    });
});

describe('robots.txt still welcomes agents and points at the sitemap', () => {
    const robots = read('docs', 'robots.txt');
    it('allows the major AI crawlers', () => {
        for (const ua of ['GPTBot', 'ClaudeBot', 'PerplexityBot']) {
            expect(robots).toContain(ua);
        }
        expect(robots).toContain('Sitemap: https://plaincast.live/sitemap.xml');
    });
});

// Release rule (CLAUDE.md): any change under docs/ must bump CACHE_NAME, or
// returning PWA clients get new HTML against an old stylesheet.
describe('service worker', () => {
    it('precaches / — which is now a function, not a static file', () => {
        expect(read('docs', 'sw.js')).toContain("'/',");
    });
});
