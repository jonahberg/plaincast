// Deploy assembly, run by the Vercel buildCommand AFTER `vite build`
// (vercel.json). Shapes shadcn/dist into the static output:
//
//   1. DELETES dist/index.html — rewrites run after `handle: filesystem`, so
//      a static index.html at / would shadow the `/` → api/home.js rewrite
//      (the same reason docs/index.html sits in .vercelignore). The HTML
//      shell is served exclusively by the SSR functions, from the committed
//      api/_home-shell.html twin.
//   2. Copies the legacy static surface out of docs/ — /styles.css, /js/*,
//      /fonts/* keep the national desk + trust-page shells styled and old
//      deep links alive; robots.txt, sitemap.xml, llms.txt, openapi.json,
//      og-image.png, manifest.json are the agent/SEO surface. docs/sw.js is
//      deliberately NOT copied: /sw.js is the shadcn service worker
//      (shadcn/public/sw.js), which takes over old registrations and clears
//      their caches.
//   3. Verifies the built assets exist at the stable names the committed
//      shell references — a rename in shadcn/vite.config.js without a shell
//      regeneration must fail the deploy, not ship a blank page.
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'shadcn', 'dist');
const DOCS = join(ROOT, 'docs');

// 3 first — fail before mutating anything.
const required = ['assets/app.js', 'assets/app.css', 'assets/vendor.js', 'sw.js', 'theme-init.js', 'icon.svg', 'manifest.webmanifest'];
for (const rel of required) {
    if (!existsSync(join(DIST, rel))) {
        throw new Error(`prepare-deploy: missing build output ${rel} — did the vite build run, or did output names drift?`);
    }
}
const shell = readFileSync(join(ROOT, 'api', '_home-shell.html'), 'utf8');
for (const ref of ['/assets/app.js', '/assets/app.css']) {
    if (!shell.includes(ref)) {
        throw new Error(`prepare-deploy: api/_home-shell.html does not reference ${ref} — run \`bun scripts/build-offices.mjs\` and commit`);
    }
}

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
];
for (const [from, to] of COPIES) {
    cpSync(join(DOCS, from), join(DIST, to), { recursive: true });
}

console.log('prepare-deploy: dist assembled (index.html removed, legacy statics copied)');
