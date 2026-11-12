// Boot data for the React app, embedded by the server-rendered pages
// (api/home.js for `/`, api/office-page.js for `/o/CODE/`).
//
// The page already fetches the latest AFD product to build its digest. Handing
// that product to the app (plus the edition's AI translations and the "since
// the last update" sentence the CDN already holds) lets the first React paint
// be the finished page: final text, final positions, no skeleton, no
// regex-then-AI swap while the reader scrolls.
//
//   <script type="application/json" id="plaincast-boot">{…}</script>
//
// A `type="application/json"` block is data, not script: browsers never
// execute it, so the CSP (`script-src 'self'`, no 'unsafe-inline') is
// unaffected. It is placed outside <main>, just before the app's module
// script, so main-content extractors and the Markdown twin never see it.
//
// Shape (v1):
//   { v: 1, office, product: { id, issuanceTime, productText },
//     translations: { "<section key>": "<markdown>" } | null,
//     translationsComplete: boolean,
//     changelog?: { changelog: string|null, since, updated } }
// `changelog` is present only when the server got a definitive answer for
// THIS issuance; absent means "unknown, fetch it yourself".
import { fetchSelfJson } from './_self.js';
import { PROD_SCRIPT } from '../scripts/app-shell.mjs';

export const BOOT_ID = 'plaincast-boot';
export const BOOT_VERSION = 1;

// Cache policy: a page that carries a complete translation keeps the
// handler's normal CDN window. One without (cold translation, partial
// result, self-fetch timeout) is regenerated soon, so the next reader gets
// the finished page once the translation exists.
export const SHORT_CACHE = 'public, s-maxage=120, stale-while-revalidate=3600';

export function cacheControlFor(boot, fullCache) {
    return boot && boot.translationsComplete ? fullCache : SHORT_CACHE;
}

// JSON for an HTML <script> data block. `<` / `>` / `&` are escaped so no
// sequence in the forecast text (`</script>`, `<!--`) can end the element or
// open a comment; U+2028/U+2029 are escaped for old JS-string consumers.
export function serializeBoot(data) {
    return JSON.stringify(data)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

export function bootScript(data) {
    return `<script type="application/json" id="${BOOT_ID}">${serializeBoot(data)}</script>`;
}

// Inserts the block before the app's module script. A shell without that
// tag (template drift) simply carries no boot block: the app then loads the
// way it always has, so this never fails the page.
export function insertBoot(html, data) {
    if (!data || typeof html !== 'string' || !html.includes(PROD_SCRIPT)) return html;
    return html.replace(PROD_SCRIPT, () => `${bootScript(data)}\n    ${PROD_SCRIPT}`);
}

function sameInstant(a, b) {
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

// The translate-issuance response → { translations, complete }. Only string
// sections survive, and only for the office + id that were asked for.
export function pickTranslations(res, office, id) {
    if (!res || typeof res !== 'object') return { translations: null, complete: false };
    if (res.office && res.office !== office) return { translations: null, complete: false };
    if (res.id && res.id !== id) return { translations: null, complete: false };
    const src = res.sections;
    if (!src || typeof src !== 'object' || Array.isArray(src)) return { translations: null, complete: false };
    const translations = {};
    for (const [key, text] of Object.entries(src)) {
        if (typeof text === 'string' && text.trim()) translations[key] = text;
    }
    if (Object.keys(translations).length === 0) return { translations: null, complete: false };
    return { translations, complete: res.complete === true };
}

// The /api/changelog response → the embedded value, or undefined when the
// server does not know the answer for THIS issuance (transient failure, a
// different latest pair, timeout).
export function pickChangelog(res, issuanceTime) {
    if (!res || typeof res !== 'object' || res.transient) return undefined;
    if (res.changelog !== null && typeof res.changelog !== 'string') return undefined;
    // `updated` is the issuance time of the edition the sentence describes.
    if (!res.updated || !sameInstant(res.updated, issuanceTime)) return undefined;
    return {
        changelog: res.changelog || null,
        since: typeof res.since === 'string' ? res.since : null,
        updated: res.updated,
    };
}

// Same-site fetches of what the browser would otherwise request on load.
// Both go through api/_self.js: short timeout, never throws, null off-Vercel.
// Start this as soon as the edition id is known and await it last.
export function fetchBootExtras(office, id, { timeoutMs = 400 } = {}) {
    const q = `office=${encodeURIComponent(office)}`;
    return Promise.all([
        fetchSelfJson(`/api/translate-issuance?${q}&id=${encodeURIComponent(id)}`, { timeoutMs }),
        fetchSelfJson(`/api/changelog?${q}`, { timeoutMs }),
    ]).then(([translation, changelog]) => ({ translation, changelog }));
}

export function buildBoot({ office, product, extras }) {
    if (!product || typeof product.productText !== 'string' || !product.productText || !product.id) return null;
    const { translations, complete } = pickTranslations(extras?.translation, office, product.id);
    const boot = {
        v: BOOT_VERSION,
        office,
        product: {
            id: String(product.id),
            issuanceTime: typeof product.issuanceTime === 'string' ? product.issuanceTime : null,
            productText: product.productText,
        },
        translations,
        translationsComplete: Boolean(translations) && complete,
    };
    const changelog = pickChangelog(extras?.changelog, product.issuanceTime);
    if (changelog !== undefined) boot.changelog = changelog;
    return boot;
}
