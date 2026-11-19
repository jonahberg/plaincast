// Content-hashed assets at deploy: the pure half of scripts/prepare-deploy.mjs
// (no file system, no side effects), so tests drive the exact rewrite the
// Vercel build runs, against a fixture manifest.
//
// The committed shell (api/_home-shell.html) names PLACEHOLDER assets —
// /assets/app.css, /assets/vendor.js, /assets/app.js (scripts/app-shell.mjs)
// — because a committed file cannot know a per-build hash. Vite emits
// assets/app-<hash>.js and friends plus a manifest (shadcn/vite.config.js).
// A placeholder is its file's name with the `-<hash>` removed: the entry is
// app.js, the entry's stylesheet app.css, any other chunk <name>.js. The
// mapping comes from the manifest's fields, never from splitting file names:
// Rollup's hash alphabet includes `-` and `_`.
import { ASSET_PLACEHOLDERS, PROD_SCRIPT_RE } from './app-shell.mjs';

// An /assets/ URL path inside HTML (an attribute value; stops at a quote,
// whitespace, a tag bracket or a paren).
export const ASSET_REF = /\/assets\/[^"'\s<>()]+/g;

// dist/sw.js carries this line exactly once; the deploy replaces it with
// the build's hashed asset list (shadcn/public/sw.js).
export const SW_ASSETS_MARKER = 'const ASSETS = [];';

function entryOf(manifest) {
    const keys = Object.keys(manifest || {}).filter(k => manifest[k]?.isEntry);
    if (keys.length !== 1) {
        throw new Error(`hashed-assets: expected exactly one entry in the Vite manifest, found ${keys.length}`);
    }
    return keys[0];
}

// placeholder URL path → this build's URL path. A placeholder that two chunks
// would share maps to null (ambiguous: rewriting it would be a guess).
export function assetMap(manifest) {
    const entryKey = entryOf(manifest);
    const entry = manifest[entryKey];
    const css = entry.css || [];
    if (css.length !== 1) {
        throw new Error(`hashed-assets: expected exactly one stylesheet for the entry, found ${css.length} (/assets/app.css would be ambiguous)`);
    }
    const pairs = [['/assets/app.js', `/${entry.file}`], ['/assets/app.css', `/${css[0]}`]];
    for (const [key, chunk] of Object.entries(manifest)) {
        if (key === entryKey || !chunk?.name || !/\.js$/.test(chunk.file || '')) continue;
        pairs.push([`/assets/${chunk.name}.js`, `/${chunk.file}`]);
    }
    const map = new Map();
    for (const [from, to] of pairs) map.set(from, map.has(from) ? null : to);
    return map;
}

// Every file the app can load, entry first: its stylesheet(s), its static
// imports (vendor), and every on-demand chunk (dynamicImports) with their own
// imports and CSS, each once, in a fixed order. This is the service worker's
// precache list, so the changelog view, the shortcuts dialog, toasts and the
// diff work offline after the first visit.
export function precacheAssets(manifest) {
    const out = [];
    const seen = new Set();
    const visit = (key) => {
        if (seen.has(key)) return;
        seen.add(key);
        const chunk = manifest[key];
        if (!chunk) throw new Error(`hashed-assets: the Vite manifest references a chunk it does not list: ${key}`);
        for (const file of [chunk.file, ...(chunk.css || []), ...(chunk.assets || [])]) {
            const url = `/${file}`;
            if (!out.includes(url)) out.push(url);
        }
        for (const k of chunk.imports || []) visit(k);
        for (const k of chunk.dynamicImports || []) visit(k);
    };
    visit(entryOf(manifest));
    return out;
}

// The shell with every /assets/ reference pointed at this build's file.
// Throws — failing the build — when a reference has no mapping, when its
// file is not in dist (fileExists(urlPath) says), when one of the three
// placeholders is no longer referenced at all, or when the result no longer
// carries exactly one app module script that api/_boot.js can find
// (PROD_SCRIPT_RE). A reference that already names a current file is kept:
// a second run on the same build is a no-op.
export function rewriteShell(html, map, fileExists) {
    const current = new Set([...map.values()].filter(Boolean));
    const refs = [...new Set(html.match(ASSET_REF) || [])];
    const to = new Map();
    const problems = [];
    for (const ref of refs) {
        const target = map.has(ref) ? map.get(ref) : (current.has(ref) ? ref : undefined);
        if (target === undefined) problems.push(`${ref}: neither a placeholder nor a file of this build (Vite manifest)`);
        else if (target === null) problems.push(`${ref}: more than one chunk of this build has that name`);
        else if (!fileExists(target)) problems.push(`${ref} -> ${target}: not in shadcn/dist`);
        else to.set(ref, target);
    }
    for (const p of ASSET_PLACEHOLDERS) {
        if (!refs.includes(p) && !refs.includes(map.get(p))) problems.push(`${p}: the shell no longer references it`);
    }
    if (problems.length) {
        throw new Error('hashed-assets: cannot point api/_home-shell.html at this build\'s assets:\n  - '
            + problems.join('\n  - ')
            + '\n(edited shadcn/index.html or a renamed chunk: run `bun scripts/build-offices.mjs`;'
            + ' a shell left rewritten by an earlier local run: `git checkout -- api/_home-shell.html`)');
    }
    const out = html.replace(ASSET_REF, ref => to.get(ref));
    const tags = out.match(new RegExp(PROD_SCRIPT_RE.source, 'g')) || [];
    const app = map.get('/assets/app.js');
    if (tags.length !== 1 || !tags[0].includes(`"${app}"`)) {
        throw new Error(`hashed-assets: the rewritten shell must carry exactly one app module script for ${app} matching PROD_SCRIPT_RE (found ${tags.length}); api/_boot.js would stop embedding boot data`);
    }
    return out;
}

// dist/sw.js with its asset list filled in.
export function rewriteServiceWorker(src, assets) {
    const n = src.split(SW_ASSETS_MARKER).length - 1;
    if (n !== 1) {
        throw new Error(`hashed-assets: the service worker must contain "${SW_ASSETS_MARKER}" exactly once (found ${n}); the precache list has nowhere to go`);
    }
    if (!assets.length) throw new Error('hashed-assets: empty precache list');
    return src.replace(SW_ASSETS_MARKER, () => `const ASSETS = ${JSON.stringify(assets)};`);
}
