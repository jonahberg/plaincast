// Deploy assembly, run by the Vercel buildCommand AFTER `vite build`
// (vercel.json), in the build checkout. Shapes shadcn/dist into the static
// output and points the function-bundled shell at this build's
// content-hashed assets:
//
//   1. DELETES dist/index.html — rewrites run after `handle: filesystem`, so
//      a static index.html at / would shadow the `/` → api/home.js rewrite
//      (the same reason docs/index.html sits in .vercelignore). The HTML
//      shell is served exclusively by the SSR functions, from
//      api/_home-shell.html.
//   2. Copies the legacy static surface out of docs/ — /styles.css, /js/*,
//      /fonts/* keep the national desk + trust-page shells styled and old
//      deep links alive; robots.txt, sitemap.xml, llms.txt, openapi.json,
//      og-image.png, manifest.json, .well-known/security.txt are the
//      agent/SEO surface. docs/sw.js is
//      deliberately NOT copied: /sw.js is the shadcn service worker
//      (shadcn/public/sw.js), which takes over old registrations and clears
//      their caches.
//   3. Rewrites api/_home-shell.html IN PLACE, in this checkout only: the
//      committed file names placeholder assets (/assets/app.css,
//      /assets/vendor.js, /assets/app.js); each becomes this build's hashed
//      file, from Vite's manifest (scripts/hashed-assets.mjs). api/home.js
//      and api/office-page.js read that file via functions.*.includeFiles, so
//      this relies on Vercel packaging the functions AFTER the buildCommand,
//      from this checkout (not verified by a deploy when this was written;
//      api/office-page.js loadTemplate() logs an error on Vercel if it ever
//      reads a placeholder). Fails the build on any /assets/ reference it
//      cannot map, on a mapped file missing from dist, and unless the app's
//      module script still matches the pattern api/_boot.js inserts the boot
//      data before.
//   4. Writes the service worker's precache list into dist/sw.js: the
//      entry, its CSS, vendor and every on-demand chunk, from the manifest.
//   5. Deletes dist/.vite (the manifest is build input, not site content).
//
// Everything is derived and checked before anything is written. Run it once
// per `vite build` (a second run finds no manifest and stops). Run locally,
// it rewrites the working copy's api/_home-shell.html: restore it with
// `git checkout -- api/_home-shell.html` before committing
// (tests/seo-pages.test.js fails on a rewritten shell).
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_REF, assetMap, precacheAssets, rewriteServiceWorker, rewriteShell } from './hashed-assets.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'shadcn', 'dist');
const DOCS = join(ROOT, 'docs');
const HOME_SHELL = join(ROOT, 'api', '_home-shell.html');
const MANIFEST = join(DIST, '.vite', 'manifest.json');

// ── Checks (nothing is written until all of them pass) ──
const required = ['sw.js', 'theme-init.js', 'icon.svg', 'favicon.ico', 'apple-touch-icon.png', 'manifest.webmanifest'];
for (const rel of required) {
    if (!existsSync(join(DIST, rel))) {
        throw new Error(`prepare-deploy: missing build output ${rel} — did the vite build run?`);
    }
}
if (!existsSync(MANIFEST)) {
    throw new Error('prepare-deploy: missing shadcn/dist/.vite/manifest.json — run the vite build first (prepare-deploy runs once per build and deletes the manifest)');
}
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const inDist = (urlPath) => existsSync(join(DIST, urlPath.replace(/^\/+/, '')));

const map = assetMap(manifest);
const precache = precacheAssets(manifest);
const missing = precache.filter(u => !inDist(u));
if (missing.length) throw new Error(`prepare-deploy: manifest files missing from shadcn/dist: ${missing.join(', ')}`);
const built = readdirSync(join(DIST, 'assets')).map(f => `/assets/${f}`);
const unlisted = built.filter(u => /\.(?:js|css)$/.test(u) && !precache.includes(u));
if (unlisted.length) console.warn(`prepare-deploy: WARNING built but not reachable from the entry (not precached): ${unlisted.join(', ')}`);

const shell = rewriteShell(readFileSync(HOME_SHELL, 'utf8'), map, inDist);
const sw = rewriteServiceWorker(readFileSync(join(DIST, 'sw.js'), 'utf8'), precache);

// Only api/_home-shell.html is rewritten. The other function-bundled shells
// must not name /assets/ (they load /styles.css and /js/* instead).
for (const rel of ['api/_page-shell.html', 'api/_national-shell.html']) {
    const refs = readFileSync(join(ROOT, rel), 'utf8').match(ASSET_REF);
    if (refs) throw new Error(`prepare-deploy: ${rel} references ${refs[0]}, but only api/_home-shell.html is rewritten to hashed names`);
}

// ── Writes ──
// 1
rmSync(join(DIST, 'index.html'), { force: true });

// 2
const COPIES = [
    ['styles.css', 'styles.css'],
    ['js', 'js'],
    ['fonts', 'fonts'],
    ['og-image.png', 'og-image.png'],
    ['openapi.json', 'openapi.json'],
    ['robots.txt', 'robots.txt'],
    ['sitemap.xml', 'sitemap.xml'],
    ['llms.txt', 'llms.txt'],
    ['manifest.json', 'manifest.json'],
    // RFC 9116 security.txt (and anything else under /.well-known/).
    ['.well-known', '.well-known'],
];
for (const [from, to] of COPIES) {
    cpSync(join(DOCS, from), join(DIST, to), { recursive: true });
}

// 3
writeFileSync(HOME_SHELL, shell);

// 4
writeFileSync(join(DIST, 'sw.js'), sw);

// 5
rmSync(join(DIST, '.vite'), { recursive: true, force: true });

console.log('prepare-deploy: api/_home-shell.html now names this build\'s assets:');
for (const [from, to] of map) if (to && shell.includes(`"${to}"`)) console.log(`  ${from} -> ${to}`);
console.log(`prepare-deploy: dist/sw.js precaches ${precache.length} assets: ${precache.join(', ')}`);
console.log('prepare-deploy: dist assembled (index.html removed, legacy statics copied)');
if (!process.env.VERCEL) {
    console.log('prepare-deploy: NOTE api/_home-shell.html was rewritten in this working copy; `git checkout -- api/_home-shell.html` before committing');
}
