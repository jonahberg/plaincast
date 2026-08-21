import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICE_NAMES } from '../docs/js/offices.js';
import { renderOfficePage, renderSitemap } from '../scripts/build-offices.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const template = readFileSync(join(DOCS, 'index.html'), 'utf8');
const codes = Object.keys(OFFICE_NAMES);

function read(code) {
    try { return readFileSync(join(DOCS, 'o', code, 'index.html'), 'utf8'); } catch (e) { return null; }
}

describe('per-office SEO pages stay in sync with docs/index.html', () => {
    it('every committed office page matches the generator (else run `bun scripts/build-offices.mjs`)', () => {
        const drifted = codes.filter(code => read(code) !== renderOfficePage(template, code, OFFICE_NAMES[code]));
        expect(drifted).toEqual([]);
    });

    // api/_home-shell.html is what the deployed functions actually read:
    // docs/index.html is in .vercelignore (it would shadow the `/` rewrite),
    // and an ignored file never reaches the function bundle either. If this
    // drifts, the homepage and every /o/<CODE>/ page serve a stale shell.
    it('api/_home-shell.html is byte-identical to docs/index.html (else run `bun scripts/build-offices.mjs`)', () => {
        expect(readFileSync(join(ROOT, 'api', '_home-shell.html'), 'utf8')).toBe(template);
    });

    it('sitemap.xml matches the generator', () => {
        // <lastmod> is stamped with the generation date, so pin the comparison
        // to the committed file's own date (else this drifts daily).
        const committed = readFileSync(join(DOCS, 'sitemap.xml'), 'utf8');
        const lastmod = committed.match(/<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/)?.[1];
        expect(lastmod).toBeTruthy();
        expect(committed).toBe(renderSitemap(codes, lastmod));
    });

    it('every sitemap URL carries a YYYY-MM-DD <lastmod>', () => {
        const committed = readFileSync(join(DOCS, 'sitemap.xml'), 'utf8');
        const locs = [...committed.matchAll(/<loc>/g)].length;
        const stamps = [...committed.matchAll(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g)].length;
        expect(locs).toBe(codes.length + 5); // homepage + /national/ + 3 trust pages + every office
        expect(stamps).toBe(locs);
    });

    it('the sitemap lists the trust-anchor pages', () => {
        const committed = readFileSync(join(DOCS, 'sitemap.xml'), 'utf8');
        for (const slug of ['about', 'contact', 'privacy']) {
            expect(committed).toContain(`<loc>https://plaincast.live/${slug}</loc>`);
        }
    });

    it('each page is self-canonical, de-genericized, and uses absolute asset paths', () => {
        for (const code of codes) {
            const html = read(code);
            expect(html).toContain(`<link rel="canonical" href="https://plaincast.live/o/${code}/">`);
            // rel="alternate" names THIS office's Markdown twin, not the homepage's
            expect(html).toContain(`<link rel="alternate" type="text/markdown" href="https://plaincast.live/o/${code}/">`);
            expect(html).not.toContain('<link rel="alternate" type="text/markdown" href="https://plaincast.live/">');
            expect(html).not.toContain('<title>Plaincast - What the forecast actually says</title>');
            expect(html).toContain('href="/styles.css"');
            expect(html).toContain('src="/js/app.js"');
            expect(html).toContain(`href="/api/feed?office=${code}"`);
        }
    });
});

describe('per-office OG share cards', () => {
    it('rendered office pages point og:image and twitter:image at the /api/og PNG card', () => {
        const html = renderOfficePage(template, 'LOX', OFFICE_NAMES.LOX);
        expect(html).toContain('<meta property="og:image" content="https://plaincast.live/api/og?office=LOX">');
        expect(html).toContain('<meta property="og:image:type" content="image/png">');
        expect(html).toContain('<meta name="twitter:image" content="https://plaincast.live/api/og?office=LOX">');
        expect(html).toContain('<meta property="og:image:width" content="1200">');
        expect(html).toContain('<meta property="og:image:height" content="630">');
        expect(html).not.toContain('https://plaincast.live/og-image.png');
    });

    it('the og:image URL is office-specific', () => {
        const okx = renderOfficePage(template, 'OKX', OFFICE_NAMES.OKX);
        expect(okx).toContain('content="https://plaincast.live/api/og?office=OKX"');
        expect(okx).not.toContain('office=LOX');
    });

    it('the homepage template keeps the static og-image.png', () => {
        expect(template).toContain('<meta property="og:image" content="https://plaincast.live/og-image.png">');
        expect(template).toContain('<meta name="twitter:image" content="https://plaincast.live/og-image.png">');
    });

    it('the homepage template carries generic og/twitter image:alt', () => {
        expect(template).toContain('<meta property="og:image:alt" content="The NWS forecast, decoded into plain English">');
        expect(template).toContain('<meta name="twitter:image:alt" content="The NWS forecast, decoded into plain English">');
    });

    it('rendered office pages rewrite og/twitter image:alt to the office city', () => {
        const html = renderOfficePage(template, 'LOX', OFFICE_NAMES.LOX);
        expect(html).toContain('<meta property="og:image:alt" content="Latest NWS forecast for Los Angeles, decoded into plain English">');
        expect(html).toContain('<meta name="twitter:image:alt" content="Latest NWS forecast for Los Angeles, decoded into plain English">');
        // the generic homepage alt is gone
        expect(html).not.toContain('content="The NWS forecast, decoded into plain English"');
    });
});

describe('footer office index (internal links to all /o/ pages)', () => {
    it('the template links every office exactly once, as City (CODE)', () => {
        const links = [...template.matchAll(/<li><a href="\/o\/([A-Z]{3})\/"[^>]*>([^<]+) \((\1)\)<\/a><\/li>/g)];
        expect(links.length).toBe(codes.length); // 68
        const byCode = new Map(links.map(m => [m[1], m[2]]));
        expect([...byCode.keys()].sort()).toEqual([...codes].sort());
        for (const code of codes) {
            expect(byCode.get(code)).toBe(OFFICE_NAMES[code]);
        }
    });

    it('rendered office pages keep all 68 links and mark their own with aria-current', () => {
        const html = renderOfficePage(template, 'LOX', OFFICE_NAMES.LOX);
        const hrefs = [...html.matchAll(/<li><a href="\/o\/([A-Z]{3})\/"/g)].map(m => m[1]);
        expect(hrefs.length).toBe(codes.length);
        expect(html).toContain('<a href="/o/LOX/" aria-current="page">Los Angeles (LOX)</a>');
        expect(html).not.toContain('<a href="/o/OKX/" aria-current="page">');
    });
});

describe('per-office structured data', () => {
    it('each rendered page carries office-specific WebPage + Place + BreadcrumbList JSON-LD', () => {
        const html = renderOfficePage(template, 'LOX', OFFICE_NAMES.LOX);
        expect(html).toContain('"@type": "BreadcrumbList"');
        expect(html).toContain('"@type": "Place"');
        expect(html).toContain('"@id": "https://plaincast.live/o/LOX/"');
        expect(html).toContain('"name": "Los Angeles"');
        expect(html).toContain('https://plaincast.live/o/LOX/?view=changelog');
    });

    it('the JSON-LD is unique per office (no longer byte-identical to the homepage)', () => {
        const lox = renderOfficePage(template, 'LOX', OFFICE_NAMES.LOX);
        const okx = renderOfficePage(template, 'OKX', OFFICE_NAMES.OKX);
        const block = (html) => html.match(/"@type": "WebPage"[\s\S]*?BreadcrumbList[\s\S]*?<\/script>/)[0];
        expect(block(lox)).not.toBe(block(okx));
        // the homepage template itself has no per-office block
        expect(template).not.toContain('"@type": "BreadcrumbList"');
    });

    it('every JSON-LD block on a rendered page parses as valid JSON', () => {
        const html = renderOfficePage(template, 'LOX', OFFICE_NAMES.LOX);
        const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
        expect(blocks.length).toBeGreaterThanOrEqual(4); // WebApplication, FAQ, HowTo + office block
        for (const [, json] of blocks) {
            expect(() => JSON.parse(json)).not.toThrow();
        }
    });
});
