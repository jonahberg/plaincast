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

    it('states the NOAA non-affiliation', () => {
        expect(llms).toContain('not affiliated');
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
