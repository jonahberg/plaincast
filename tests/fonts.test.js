import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const FONTS_DIR = join(DOCS, 'fonts');
const FONTS_CSS = join(FONTS_DIR, 'fonts.css');

const MAX_WOFF2_BYTES = 120 * 1024;
const FAMILIES = ['Fraunces', 'Source Serif 4', 'DM Sans', 'JetBrains Mono'];

describe('self-hosted fonts', () => {
    it('docs/fonts/fonts.css exists', () => {
        expect(existsSync(FONTS_CSS)).toBe(true);
    });

    it('every url() in fonts.css resolves to a committed file', () => {
        const css = readFileSync(FONTS_CSS, 'utf8');
        const urls = [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map(m => m[1]);
        expect(urls.length).toBeGreaterThan(0);
        for (const url of urls) {
            // fonts.css uses root-absolute paths (/fonts/x.woff2) served from docs/
            const file = join(DOCS, url.replace(/^\//, ''));
            expect(existsSync(file)).toBe(true);
        }
    });

    it('declares every family styles.css references, with identical names', () => {
        const css = readFileSync(FONTS_CSS, 'utf8');
        for (const fam of FAMILIES) {
            expect(css).toContain(`font-family: '${fam}'`);
        }
    });

    it('index.html no longer references Google Fonts and links fonts.css', () => {
        const html = readFileSync(join(DOCS, 'index.html'), 'utf8');
        expect(html).not.toContain('fonts.googleapis.com');
        expect(html).not.toContain('fonts.gstatic.com');
        expect(html).toContain('href="/fonts/fonts.css"');
    });

    it('preloaded font files exist', () => {
        const html = readFileSync(join(DOCS, 'index.html'), 'utf8');
        const preloads = [...html.matchAll(/rel="preload" href="(\/fonts\/[^"]+)" as="font"/g)].map(m => m[1]);
        expect(preloads.length).toBeGreaterThanOrEqual(2);
        for (const href of preloads) {
            expect(existsSync(join(DOCS, href.replace(/^\//, '')))).toBe(true);
        }
    });

    it('each woff2 is under 120KB and is valid woff2', () => {
        const files = readdirSync(FONTS_DIR).filter(f => f.endsWith('.woff2'));
        expect(files.length).toBeGreaterThan(0);
        for (const f of files) {
            const path = join(FONTS_DIR, f);
            expect(statSync(path).size).toBeLessThan(MAX_WOFF2_BYTES);
            // woff2 magic: 'wOF2'
            const magic = readFileSync(path).subarray(0, 4).toString('ascii');
            expect(magic).toBe('wOF2');
        }
    });

    it('OFL license files are committed alongside the fonts', () => {
        for (const fam of ['Fraunces', 'SourceSerif4', 'DMSans', 'JetBrainsMono']) {
            const lic = join(FONTS_DIR, `OFL-${fam}.txt`);
            expect(existsSync(lic)).toBe(true);
            expect(readFileSync(lic, 'utf8')).toContain('SIL OPEN FONT LICENSE');
        }
    });

    it('vercel.json CSP is same-origin for fonts and /fonts/* is immutable-cached', () => {
        const vercel = JSON.parse(readFileSync(join(DOCS, '..', 'vercel.json'), 'utf8'));
        const all = JSON.stringify(vercel);
        expect(all).not.toContain('fonts.googleapis.com');
        expect(all).not.toContain('fonts.gstatic.com');
        const csp = vercel.headers.flatMap(h => h.headers).find(h => h.key === 'Content-Security-Policy');
        expect(csp.value).toContain("font-src 'self'");
        const fontsRule = vercel.headers.find(h => h.source === '/fonts/(.*)');
        expect(fontsRule.headers[0].value).toContain('immutable');
    });
});
