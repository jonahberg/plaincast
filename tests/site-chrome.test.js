// The server-rendered pages outside the React SPA (/national/, the trust
// pages, the 404) share the SPA's shadcn look: one header, the SPA's theme
// key, the system font stack. These pin the parts that drift silently.
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HTML_BODY as NOT_FOUND_HTML } from '../api/not-found.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

const SHELLS = {
    'api/_page-shell.html': read('api', '_page-shell.html'),
    'api/_national-shell.html': read('api', '_national-shell.html'),
    'api/not-found.js HTML_BODY': NOT_FOUND_HTML,
};
const headerOf = (html) => (html.match(/<header class="site-header">[\s\S]*?<\/header>/) || [null])[0];

describe('shared site chrome', () => {
    it('every shell carries the same header, byte for byte', () => {
        const headers = Object.values(SHELLS).map(headerOf);
        expect(headers[0]).toBeTruthy();
        for (const h of headers) expect(h).toBe(headers[0]);
    });

    it('the header has the wordmark, both nav links, and a theme toggle', () => {
        const h = headerOf(SHELLS['api/_page-shell.html']);
        expect(h).toContain('<a href="/" class="brand">');
        expect(h).toContain('<a href="/national/">National Desk</a>');
        expect(h).toContain('data-theme-toggle');
        // No H1 in the header: the page's H1 lives in <main> (heading rule).
        expect(h).not.toMatch(/<h1[\s>]/);
    });

    for (const [name, html] of Object.entries(SHELLS)) {
        it(`${name}: shadcn stylesheet + theme scripts, no serif webfonts`, () => {
            expect(html).toContain('href="/styles.css"');
            expect(html).toContain('<script src="/js/theme-init.js"></script>');
            expect(html).toContain('<script defer src="/js/site-chrome.js"></script>');
            expect(html).not.toContain('/fonts/fonts.css');
            expect(html).not.toContain('.woff2');
        });

        // CSP is script-src 'self' (tests/csp.test.js): inline handlers and
        // inline script bodies are refused by the browser.
        it(`${name}: no inline on*= handlers and no inline script bodies`, () => {
            expect(html).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
            const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/gi)]
                .map(m => m[1].trim()).filter(Boolean);
            expect(inline).toEqual([]);
        });

        it(`${name}: its H1 sits inside <main> and names the product`, () => {
            const main = html.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);
            expect(main).toBeTruthy();
            const h1 = main[1].match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
            expect(h1).toBeTruthy();
            expect(h1[1]).toContain('Plaincast');
        });
    }

    it('the 404 stays noindex', () => {
        expect(NOT_FOUND_HTML).toContain('<meta name="robots" content="noindex">');
    });
});

describe('theme persistence matches the SPA', () => {
    const init = read('docs', 'js', 'theme-init.js');
    const chrome = read('docs', 'js', 'site-chrome.js');
    const spaInit = read('shadcn', 'public', 'theme-init.js');

    it('the SPA stores the theme under plaincast-theme', () => {
        // If this fails the SPA changed its key and the two below must follow.
        expect(spaInit).toContain("'plaincast-theme'");
    });
    it('theme-init reads plaincast-theme first, legacy theme as fallback', () => {
        expect(init).toMatch(/getItem\('plaincast-theme'\)\s*\|\|\s*localStorage\.getItem\('theme'\)/);
    });
    it('the toggle writes plaincast-theme', () => {
        expect(chrome).toContain("setItem('plaincast-theme'");
    });
});

describe('stylesheet mirrors the SPA tokens', () => {
    const css = read('docs', 'styles.css');
    const spa = read('shadcn', 'src', 'index.css');
    const block = (src, sel) => (src.match(new RegExp(`^${sel.replace('.', '\\.')} \\{([\\s\\S]*?)^\\}`, 'm')) || [])[1] || '';
    const tokens = (src) => Object.fromEntries([...src.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));

    for (const sel of [':root', '.dark']) {
        it(`${sel} tokens used here equal the SPA's`, () => {
            const mine = tokens(block(css, sel));
            const theirs = tokens(block(spa, sel));
            for (const k of ['background', 'foreground', 'card', 'muted', 'muted-foreground', 'border', 'destructive', 'primary']) {
                expect(mine[k]).toBe(theirs[k]);
            }
        });
    }
});
