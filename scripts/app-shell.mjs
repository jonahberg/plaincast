// The production app shell: shadcn/index.html (the dev source, script src
// /src/main.jsx) transformed to reference the BUILT assets. Deterministic —
// no Vite run needed — because shadcn/vite.config.js pins stable output
// names (assets/app.js, assets/vendor.js, assets/app.css).
//
// This transform is the single source of the served HTML shell:
// scripts/build-offices.mjs feeds its output to api/_home-shell.html (what
// api/home.js + api/office-page.js load) and to every baked docs/o/<CODE>/
// page. Vite's own dist/index.html is DELETED at deploy
// (scripts/prepare-deploy.mjs) so it can never shadow the `/` rewrite.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const APP_SHELL_SOURCE = join(__dirname, '..', 'shadcn', 'index.html');

const DEV_SCRIPT = '<script type="module" src="/src/main.jsx"></script>';
const CSS_MARKER = '<!--app-css-->';

const PROD_HEAD =
    '<link rel="stylesheet" crossorigin href="/assets/app.css">\n' +
    '    <link rel="modulepreload" crossorigin href="/assets/vendor.js">';
const PROD_SCRIPT = '<script type="module" crossorigin src="/assets/app.js"></script>';

export function buildAppShell(source = readFileSync(APP_SHELL_SOURCE, 'utf8')) {
    if (!source.includes(DEV_SCRIPT)) {
        throw new Error(`app-shell: dev script marker missing from shadcn/index.html (${DEV_SCRIPT})`);
    }
    if (!source.includes(CSS_MARKER)) {
        throw new Error(`app-shell: css marker missing from shadcn/index.html (${CSS_MARKER})`);
    }
    return source
        .replace(CSS_MARKER, PROD_HEAD)
        .replace(DEV_SCRIPT, PROD_SCRIPT);
}
