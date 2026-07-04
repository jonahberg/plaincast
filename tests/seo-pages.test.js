import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICE_NAMES } from '../docs/js/offices.js';
import { renderOfficePage, renderSitemap } from '../scripts/build-offices.mjs';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
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

    it('sitemap.xml matches the generator', () => {
        expect(readFileSync(join(DOCS, 'sitemap.xml'), 'utf8')).toBe(renderSitemap(codes));
    });

    it('each page is self-canonical, de-genericized, and uses absolute asset paths', () => {
        for (const code of codes) {
            const html = read(code);
            expect(html).toContain(`<link rel="canonical" href="https://plaincast.live/o/${code}/">`);
            expect(html).not.toContain('<title>Plaincast - What the forecast actually says</title>');
            expect(html).toContain('href="/styles.css"');
            expect(html).toContain('src="/js/app.js"');
            expect(html).toContain(`href="/api/feed?office=${code}"`);
        }
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
