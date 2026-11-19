// The production app shell: shadcn/index.html (the dev source, script src
// /src/main.jsx) transformed to reference the BUILT assets by PLACEHOLDER
// names (/assets/app.css, /assets/vendor.js, /assets/app.js). Deterministic —
// no Vite run needed — because the placeholders never change. The build's
// real files are content-hashed (assets/app-<hash>.js, …;
// shadcn/vite.config.js), and scripts/prepare-deploy.mjs rewrites each
// placeholder to its hashed file in the Vercel build checkout's
// api/_home-shell.html, from the Vite manifest, before the functions are
// bundled. The committed shell never carries a hash.
//
// This transform is the single source of the served HTML shell:
// scripts/build-offices.mjs feeds its output to api/_home-shell.html (what
// api/home.js + api/office-page.js load) and to every baked docs/o/<CODE>/
// page. Vite's own dist/index.html is DELETED at deploy
// (scripts/prepare-deploy.mjs) so it can never shadow the `/` rewrite.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICE_NAMES } from '../docs/js/offices.js';
import { OFFICE_GROUPS } from '../shadcn/src/lib/offices-groups.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const APP_SHELL_SOURCE = join(__dirname, '..', 'shadcn', 'index.html');

const DEV_SCRIPT = '<script type="module" src="/src/main.jsx"></script>';
const CSS_MARKER = '<!--app-css-->';

const PROD_HEAD =
    '<link rel="stylesheet" crossorigin href="/assets/app.css">\n' +
    '    <link rel="modulepreload" crossorigin href="/assets/vendor.js">';
// The committed shell's module script (placeholder name).
export const PROD_SCRIPT = '<script type="module" crossorigin src="/assets/app.js"></script>';

// The placeholder asset paths PROD_HEAD and PROD_SCRIPT name. A deployed
// shell must carry none of them (api/office-page.js checks on Vercel).
export const ASSET_PLACEHOLDERS = ['/assets/app.css', '/assets/vendor.js', '/assets/app.js'];

// The app's module script in EITHER form: the committed placeholder
// (/assets/app.js) or the deployed, rewritten one (/assets/app-<hash>.js;
// Rollup's hash alphabet is [A-Za-z0-9_-]). api/_boot.js inserts the boot
// data block right before the tag this matches, and scripts/prepare-deploy.mjs
// fails the build unless the rewritten shell matches it exactly once, so a
// rewrite can never silently cost the pages their boot data.
export const PROD_SCRIPT_RE = /<script type="module" crossorigin src="\/assets\/app(?:-[A-Za-z0-9_-]+)?\.js"><\/script>/;

// The office index (<ul class="office-index-list …">) is GENERATED: every
// office in picker order (OFFICE_GROUPS), as "City (CODE)" links. Whatever the
// source file lists between the <ul> and </ul> is replaced, so the committed
// shells always carry the whole roster even when shadcn/index.html's own
// hand-written list is stale. Each <li> keeps the indent of the source's
// first one (or the <ul>'s, when the list is empty).
const OFFICE_INDEX_RE = /^([ \t]*)(<ul class="office-index-list[^"]*">)\n([\s\S]*?)^([ \t]*)<\/ul>/m;
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function officeIndexCodes() {
    return OFFICE_GROUPS.flatMap(g => g.codes);
}

export function injectOfficeIndex(html, codes = officeIndexCodes()) {
    const m = html.match(OFFICE_INDEX_RE);
    if (!m) throw new Error('app-shell: <ul class="office-index-list"> … </ul> not found');
    const [whole, ulIndent, open, items, closeIndent] = m;
    const liIndent = items.match(/^([ \t]*)<li>/m)?.[1] ?? ulIndent;
    const lis = codes.map(c => `${liIndent}<li><a href="/o/${c}/">${escHtml(OFFICE_NAMES[c])} (${c})</a></li>`);
    return html.replace(whole, () => `${ulIndent}${open}\n${lis.join('\n')}\n${closeIndent}</ul>`);
}

// The office count in the homepage's structured data ("123 NWS forecast
// offices") is a placeholder in shadcn/index.html, filled here from the
// roster, so the published number cannot drift from the office list.
export const OFFICE_COUNT_TOKEN = '__OFFICE_COUNT__';

export function fillOfficeCount(html, n = Object.keys(OFFICE_NAMES).length) {
    return html.split(OFFICE_COUNT_TOKEN).join(String(n));
}

export function buildAppShell(source = readFileSync(APP_SHELL_SOURCE, 'utf8')) {
    if (!source.includes(DEV_SCRIPT)) {
        throw new Error(`app-shell: dev script marker missing from shadcn/index.html (${DEV_SCRIPT})`);
    }
    if (!source.includes(CSS_MARKER)) {
        throw new Error(`app-shell: css marker missing from shadcn/index.html (${CSS_MARKER})`);
    }
    return injectOfficeIndex(fillOfficeCount(source
        .replace(CSS_MARKER, PROD_HEAD)
        .replace(DEV_SCRIPT, PROD_SCRIPT)));
}
