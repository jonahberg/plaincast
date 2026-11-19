import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICE_NAMES } from '../docs/js/offices.js';
import { renderOfficePage, renderSitemap } from '../scripts/build-offices.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
// The generator's template is the production app shell (shadcn/index.html
// + built asset refs), not the legacy docs/index.html.
const { buildAppShell } = await import('../scripts/build-offices.mjs').then(() => import('../scripts/app-shell.mjs'));
const template = buildAppShell();
const codes = Object.keys(OFFICE_NAMES);

function read(code) {
    try { return readFileSync(join(DOCS, 'o', code, 'index.html'), 'utf8'); } catch (e) { return null; }
}

describe('per-office SEO pages stay in sync with the app shell (shadcn/index.html)', () => {
    it('every committed office page matches the generator (else run `bun scripts/build-offices.mjs`)', () => {
        const drifted = codes.filter(code => read(code) !== renderOfficePage(template, code, OFFICE_NAMES[code]));
        expect(drifted).toEqual([]);
    });

    // api/_home-shell.html is what the deployed functions actually read:
    // docs/index.html is in .vercelignore (it would shadow the `/` rewrite),
    // and an ignored file never reaches the function bundle either. If this
    // drifts, the homepage and every /o/<CODE>/ page serve a stale shell.
    it('api/_home-shell.html is byte-identical to the app shell (else run `bun scripts/build-offices.mjs`)', () => {
        expect(readFileSync(join(ROOT, 'api', '_home-shell.html'), 'utf8')).toBe(template);
    });

    it('sitemap.xml matches the generator, which is deterministic', () => {
        const committed = readFileSync(join(DOCS, 'sitemap.xml'), 'utf8');
        expect(committed).toBe(renderSitemap(codes));
        expect(renderSitemap(codes)).toBe(renderSitemap(codes));
    });

    // A generation date in <lastmod> was false for every URL: the edition
    // pages change several times a day, the prose pages rarely. No URL
    // carries one; changefreq stays.
    it('no sitemap URL carries a <lastmod>; every URL keeps its changefreq', () => {
        const committed = readFileSync(join(DOCS, 'sitemap.xml'), 'utf8');
        const locs = [...committed.matchAll(/<loc>/g)].length;
        expect(locs).toBe(codes.length + 6); // homepage + /national/ + 4 prose pages + every office
        expect(committed).not.toContain('<lastmod>');
        expect([...committed.matchAll(/<changefreq>(?:daily|monthly)<\/changefreq>/g)].length).toBe(locs);
    });

    it('the sitemap lists the trust-anchor pages and the developer portal', () => {
        const committed = readFileSync(join(DOCS, 'sitemap.xml'), 'utf8');
        for (const slug of ['about', 'contact', 'developers', 'privacy']) {
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
            expect(html).toContain('href="/assets/app.css"');
            expect(html).toContain('src="/assets/app.js"');
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
        expect(links.length).toBe(codes.length);
        const byCode = new Map(links.map(m => [m[1], m[2]]));
        expect([...byCode.keys()].sort()).toEqual([...codes].sort());
        for (const code of codes) {
            expect(byCode.get(code)).toBe(OFFICE_NAMES[code]);
        }
    });

    it('rendered office pages keep every office link and mark their own with aria-current', () => {
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
        expect(blocks.length).toBe(1); // the office's own WebPage only
        for (const [, json] of blocks) {
            expect(() => JSON.parse(json)).not.toThrow();
        }
    });
});

// Structured data per page type. The site-wide blocks (WebApplication,
// FAQPage, HowTo) describe the homepage and stay there; every page carries
// exactly one WebPage, whose @id is its own canonical URL.
function jsonLdBlocks(html) {
    return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
}
function allIds(node, out = []) {
    if (Array.isArray(node)) for (const v of node) allIds(v, out);
    else if (node && typeof node === 'object') {
        if (typeof node['@id'] === 'string') out.push(node['@id']);
        for (const v of Object.values(node)) allIds(v, out);
    }
    return out;
}

describe('structured data by page type', () => {
    it('the homepage carries WebPage, WebApplication, FAQPage and HowTo, all valid JSON, no duplicate @id', () => {
        const blocks = jsonLdBlocks(template);
        expect(blocks.map(b => b['@type'])).toEqual(['WebPage', 'WebApplication', 'FAQPage', 'HowTo']);
        expect(blocks[0]['@id']).toBe('https://plaincast.live/');
        const ids = allIds(blocks);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('every office page carries only its own WebPage (+ breadcrumb), valid JSON, no duplicate @id', () => {
        for (const code of codes) {
            const blocks = jsonLdBlocks(read(code));
            expect(blocks.map(b => b['@type'])).toEqual(['WebPage']);
            expect(blocks[0]['@id']).toBe(`https://plaincast.live/o/${code}/`);
            expect(blocks[0].breadcrumb['@type']).toBe('BreadcrumbList');
            const ids = allIds(blocks);
            expect(new Set(ids).size).toBe(ids.length);
        }
    });

    it('no page claims JavaScript is required (every page is server-rendered)', () => {
        expect(template).not.toContain('browserRequirements');
        expect(read('LOX')).not.toContain('browserRequirements');
    });

    it('the homepage office count comes from the roster, never a literal in shadcn/index.html', () => {
        const n = codes.length;
        const ld = JSON.stringify(jsonLdBlocks(template));
        expect(ld).toContain(`"${n} NWS forecast offices"`);
        expect(ld).toContain(`Plaincast supports ${n} NWS forecast offices`);
        expect(ld).toContain(`Plaincast supports ${n} offices across the United States`);
        expect(template).not.toContain('__OFFICE_COUNT__');
        // The source holds the placeholder, so the count cannot go stale there.
        const source = readFileSync(join(ROOT, 'shadcn', 'index.html'), 'utf8');
        expect(source).not.toMatch(/\b\d+ (?:NWS forecast )?offices\b/);
        expect(source.split('__OFFICE_COUNT__').length - 1).toBe(3);
    });
});
