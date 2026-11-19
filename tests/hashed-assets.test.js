// ─── Content-hashed assets (shadcn/vite.config.js → scripts/prepare-deploy.mjs) ──
// The committed shell names placeholder assets; the deploy rewrites them to
// the build's hashed files from the Vite manifest (scripts/hashed-assets.mjs),
// fills the service worker's precache list, and the functions find the app's
// module script by pattern (api/_boot.js). These drive the exact functions the
// Vercel build runs, against a manifest in the shape Vite 7 writes.

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ASSET_REF, SW_ASSETS_MARKER, assetMap, precacheAssets, rewriteServiceWorker, rewriteShell,
} from '../scripts/hashed-assets.mjs';
import { ASSET_PLACEHOLDERS, PROD_SCRIPT, PROD_SCRIPT_RE, buildAppShell } from '../scripts/app-shell.mjs';
import { renderOfficePage } from '../scripts/build-offices.mjs';
import { BOOT_ID, insertBoot } from '../api/_boot.js';
import { unrewrittenShellError } from '../api/office-page.js';
import { HTML_BODY as NOT_FOUND_HTML } from '../api/not-found.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const SHELL = read('api/_home-shell.html');

// dist/.vite/manifest.json from a real `vite build` (Nov 18 2026). Rollup's
// hash alphabet includes `-`: names cannot be recovered by splitting on it.
const MANIFEST = {
    '../docs/js/diff.js': { file: 'assets/diff-qH-1lO4j.js', name: 'diff', src: '../docs/js/diff.js', isDynamicEntry: true },
    '_vendor-BGxZ6-Lt.js': { file: 'assets/vendor-BGxZ6-Lt.js', name: 'vendor' },
    'index.html': {
        file: 'assets/app-Cwz0-TZT.js', name: 'index', src: 'index.html', isEntry: true,
        imports: ['_vendor-BGxZ6-Lt.js'],
        dynamicImports: ['src/components/ui/sonner.jsx', 'src/components/ChangelogView.jsx', 'src/components/KbdDialog.jsx', '../docs/js/diff.js'],
        css: ['assets/app-CUHbm-mr.css'],
    },
    'src/components/ChangelogView.jsx': {
        file: 'assets/ChangelogView-h2GiLrpe.js', name: 'ChangelogView', src: 'src/components/ChangelogView.jsx', isDynamicEntry: true,
        imports: ['_vendor-BGxZ6-Lt.js', 'index.html', '../docs/js/diff.js'],
    },
    'src/components/KbdDialog.jsx': {
        file: 'assets/KbdDialog-CyKALN3B.js', name: 'KbdDialog', src: 'src/components/KbdDialog.jsx', isDynamicEntry: true,
        imports: ['_vendor-BGxZ6-Lt.js', 'index.html'],
    },
    'src/components/ui/sonner.jsx': {
        file: 'assets/sonner-XTRrx761.js', name: 'sonner', src: 'src/components/ui/sonner.jsx', isDynamicEntry: true,
        imports: ['_vendor-BGxZ6-Lt.js'],
    },
};
const APP = '/assets/app-Cwz0-TZT.js';
const CSS = '/assets/app-CUHbm-mr.css';
const VENDOR = '/assets/vendor-BGxZ6-Lt.js';
const FILES = new Set(precacheAssets(MANIFEST));
const inDist = (u) => FILES.has(u);

describe('vite build config', () => {
    it('emits content-hashed entry, chunks and CSS plus a manifest', async () => {
        const cfg = (await import('../shadcn/vite.config.js')).default;
        const out = cfg.build.rollupOptions.output;
        expect(cfg.build.manifest).toBe(true);
        expect(out.entryFileNames).toBe('assets/app-[hash].js');
        expect(out.chunkFileNames).toBe('assets/[name]-[hash].js');
        expect(out.assetFileNames({ names: ['index.css'] })).toBe('assets/app-[hash].css');
        expect(out.assetFileNames({ names: ['logo.svg'] })).toBe('assets/[name]-[hash][extname]');
    });
});

describe('assetMap / precacheAssets', () => {
    it('maps each placeholder to its hashed file from the manifest fields', () => {
        const map = assetMap(MANIFEST);
        expect(map.get('/assets/app.js')).toBe(APP);
        expect(map.get('/assets/app.css')).toBe(CSS);
        expect(map.get('/assets/vendor.js')).toBe(VENDOR);
        expect(map.get('/assets/ChangelogView.js')).toBe('/assets/ChangelogView-h2GiLrpe.js');
        expect(map.get('/assets/diff.js')).toBe('/assets/diff-qH-1lO4j.js');
    });

    it('a name two chunks share maps to null (never a guess)', () => {
        const m = { ...MANIFEST, 'x.js': { file: 'assets/vendor-OTHER123.js', name: 'vendor' } };
        expect(assetMap(m).get('/assets/vendor.js')).toBe(null);
    });

    it('refuses a manifest without exactly one entry or one entry stylesheet', () => {
        const { 'index.html': entry, ...noEntry } = MANIFEST;
        expect(() => assetMap(noEntry)).toThrow(/exactly one entry/);
        expect(() => assetMap({ ...MANIFEST, 'b.html': { ...entry } })).toThrow(/exactly one entry/);
        expect(() => assetMap({ ...MANIFEST, 'index.html': { ...entry, css: [] } })).toThrow(/one stylesheet/);
    });

    it('precaches the entry, its CSS, vendor and all four on-demand chunks, each once', () => {
        expect(precacheAssets(MANIFEST)).toEqual([
            APP, CSS, VENDOR,
            '/assets/sonner-XTRrx761.js',
            '/assets/ChangelogView-h2GiLrpe.js',
            '/assets/diff-qH-1lO4j.js',
            '/assets/KbdDialog-CyKALN3B.js',
        ]);
    });
});

describe('rewriteShell (api/_home-shell.html at deploy)', () => {
    const map = assetMap(MANIFEST);
    const out = rewriteShell(SHELL, map, inDist);

    it('the committed shell names exactly the three placeholders', () => {
        expect([...new Set(SHELL.match(ASSET_REF))].sort()).toEqual([...ASSET_PLACEHOLDERS].sort());
    });

    it('rewrites the stylesheet, the modulepreload and the module script in place', () => {
        expect(out).toContain(`<link rel="stylesheet" crossorigin href="${CSS}">`);
        expect(out).toContain(`<link rel="modulepreload" crossorigin href="${VENDOR}">`);
        expect(out).toContain(`<script type="module" crossorigin src="${APP}"></script>`);
        for (const p of ASSET_PLACEHOLDERS) expect(out).not.toContain(`"${p}"`);
        // Nothing else moves.
        expect(out.replaceAll(CSS, '/assets/app.css').replaceAll(VENDOR, '/assets/vendor.js').replaceAll(APP, '/assets/app.js')).toBe(SHELL);
    });

    it('is a no-op on a shell already rewritten for the same build', () => {
        expect(rewriteShell(out, map, inDist)).toBe(out);
    });

    it('fails on a reference it cannot map (an old build\'s hash, an unknown name)', () => {
        const stale = out.replace(APP, '/assets/app-OLDHASH1.js');
        expect(() => rewriteShell(stale, map, inDist)).toThrow(/app-OLDHASH1\.js: neither a placeholder/);
        const unknown = SHELL.replace('</head>', '<link rel="preload" href="/assets/fonts.css"></head>');
        expect(() => rewriteShell(unknown, map, inDist)).toThrow(/\/assets\/fonts\.css/);
    });

    it('fails when a mapped file is missing from dist', () => {
        expect(() => rewriteShell(SHELL, map, (u) => u !== VENDOR)).toThrow(/vendor-BGxZ6-Lt\.js: not in shadcn\/dist/);
    });

    it('fails when the shell drops a placeholder or the app script tag changes shape', () => {
        const noCss = SHELL.replace('<link rel="stylesheet" crossorigin href="/assets/app.css">', '');
        expect(() => rewriteShell(noCss, map, inDist)).toThrow(/\/assets\/app\.css: the shell no longer references it/);
        const deferred = SHELL.replace(PROD_SCRIPT, '<script type="module" defer crossorigin src="/assets/app.js"></script>');
        expect(() => rewriteShell(deferred, map, inDist)).toThrow(/exactly one app module script/);
    });
});

// The boot data (api/_boot.js) goes right before the app's module script. The
// deployed shell's script names a hashed file, so a string match on the
// committed tag would silently drop the boot block from every page.
describe('boot insertion survives the rewrite', () => {
    const rewritten = rewriteShell(SHELL, assetMap(MANIFEST), inDist);
    const data = { v: 1, office: 'LOX', product: { id: 'x', issuanceTime: null, productText: 'AFD' } };
    const block = new RegExp(`<script type="application/json" id="${BOOT_ID}">[^<]*</script>\\n {4}<script type="module" crossorigin src="${APP.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}"></script>`);

    it('PROD_SCRIPT_RE matches the committed tag and the hashed one, nothing else', () => {
        expect(PROD_SCRIPT_RE.test(PROD_SCRIPT)).toBe(true);
        expect(PROD_SCRIPT_RE.test(`<script type="module" crossorigin src="${APP}"></script>`)).toBe(true);
        expect(PROD_SCRIPT_RE.test(`<link rel="modulepreload" crossorigin href="${VENDOR}">`)).toBe(false);
        expect(PROD_SCRIPT_RE.test('<script type="module" crossorigin src="/assets/vendor-BGxZ6-Lt.js"></script>')).toBe(false);
    });

    it('homepage shell: the block lands right before the hashed script, once', () => {
        const html = insertBoot(rewritten, data);
        expect(html).toMatch(block);
        expect(html.split(`id="${BOOT_ID}"`).length - 1).toBe(1);
        expect(html.indexOf(`id="${BOOT_ID}"`)).toBeGreaterThan(html.lastIndexOf('</main>'));
    });

    it('office page rendered from the rewritten shell: same', () => {
        const html = insertBoot(renderOfficePage(rewritten, 'LOX', 'Los Angeles'), data);
        expect(html).toMatch(block);
    });

    it('the committed (placeholder) shell still works for tests and local runs', () => {
        expect(insertBoot(SHELL, data)).toContain(`</script>\n    ${PROD_SCRIPT}`);
    });
});

describe('runtime self-check (api/office-page.js loadTemplate)', () => {
    const rewritten = rewriteShell(SHELL, assetMap(MANIFEST), inDist);

    it('on Vercel, names every placeholder left in the bundled shell', () => {
        const msg = unrewrittenShellError(SHELL, { VERCEL: '1' });
        expect(msg).toContain('/assets/app.css, /assets/vendor.js, /assets/app.js');
        expect(msg).toContain('prepare-deploy');
    });

    it('quiet for a rewritten shell, and off Vercel', () => {
        expect(unrewrittenShellError(rewritten, { VERCEL: '1' })).toBe(null);
        expect(unrewrittenShellError(SHELL, {})).toBe(null);
    });

    it('loadTemplate logs it once per instance, on Vercel only', async () => {
        const saved = process.env.VERCEL;
        const origError = console.error;
        const logged = [];
        console.error = (...a) => logged.push(a.join(' '));
        try {
            process.env.VERCEL = '1';
            const fresh = await import('../api/office-page.js?selfcheck=on');
            expect(fresh.loadTemplate()).toBe(SHELL);
            fresh.loadTemplate();
            expect(logged.filter(l => l.includes('un-hashed placeholder')).length).toBe(1);
            delete process.env.VERCEL;
            const quiet = await import('../api/office-page.js?selfcheck=off');
            quiet.loadTemplate();
            expect(logged.length).toBe(1);
        } finally {
            console.error = origError;
            if (saved === undefined) delete process.env.VERCEL;
            else process.env.VERCEL = saved;
        }
    });
});

describe('rewriteServiceWorker (dist/sw.js at deploy)', () => {
    const SRC = read('shadcn/public/sw.js');

    it('the source carries the marker exactly once and fills it with the list', () => {
        expect(SRC.split(SW_ASSETS_MARKER).length - 1).toBe(1);
        const out = rewriteServiceWorker(SRC, precacheAssets(MANIFEST));
        expect(out).toContain(`const ASSETS = ["${APP}","${CSS}","${VENDOR}",`);
        expect(out).not.toContain(SW_ASSETS_MARKER);
        expect(out.replace(/const ASSETS = \[[^\]]*\];/, SW_ASSETS_MARKER)).toBe(SRC);
    });

    it('fails without the marker or with an empty list', () => {
        expect(() => rewriteServiceWorker('const PRECACHE = [];', ['/a'])).toThrow(/exactly once/);
        expect(() => rewriteServiceWorker(SRC, [])).toThrow(/empty/);
    });
});

describe('every other page and shell', () => {
    it('only api/_home-shell.html names /assets/ (the rest load /styles.css and /js/*)', () => {
        for (const rel of ['api/_page-shell.html', 'api/_national-shell.html']) {
            expect([rel, read(rel).match(ASSET_REF)]).toEqual([rel, null]);
        }
        expect(NOT_FOUND_HTML.match(ASSET_REF)).toBe(null);
    });

    it('the committed shell stays the deterministic generator output (placeholders, no hash)', () => {
        expect(SHELL).toBe(buildAppShell());
        expect(SHELL).not.toMatch(/\/assets\/app-[A-Za-z0-9_-]+\.js/);
    });
});

describe('vercel.json: /assets/* is immutable', () => {
    const vercel = JSON.parse(read('vercel.json'));

    it('one year, immutable, for the hashed files', () => {
        const rule = vercel.headers.find(h => h.source === '/assets/(.*)');
        expect(rule.headers).toEqual([{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }]);
    });

    it('/sw.js and the shell pages are not caught by an immutable rule', () => {
        const immutable = vercel.headers.filter(h => h.headers.some(x => /immutable/.test(x.value))).map(h => h.source);
        expect(immutable.sort()).toEqual(['/assets/(.*)', '/fonts/(.*)']);
    });
});
