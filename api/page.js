// Vercel serverless function: the trust-anchor pages — /about, /contact, /privacy.
//
// WHY THIS EXISTS: an agent deciding whether to recommend a site reads these
// three URLs to check that a real, accountable thing is behind it. Plaincast
// had none of them.
//
// WHY A FUNCTION AND NOT THREE STATIC FILES: content negotiation. A static
// file cannot answer `Accept: text/markdown`, and these pages are pure prose —
// exactly the content an agent would rather read as Markdown than as DOM. One
// handler, one content module (api/_pages.js), two renderings, no second copy
// of the text to drift.
//
// ROUTING: /about, /contact, /privacy rewrite here (vercel.json). Rewrites are
// evaluated AFTER `handle: filesystem`, so a static docs/about/index.html would
// shadow this function — which is why the shell lives at api/_page-shell.html
// (underscore-prefixed, so Vercel does not treat it as an endpoint) and reaches
// the function through includeFiles, the same convention as the National Desk.
//
// FAIL-SAFE DESIGN: there are no upstreams. The only failure mode is the shell
// missing from the bundle, which degrades to a complete, unstyled Markdown-ish
// rendering of the same words rather than an error — the content is the point,
// the typography is not.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    PAGES, escHtml, renderBlocksHtml, renderPageMarkdown,
} from './_pages.js';
import { sendNegotiated, HTML, MARKDOWN } from './_negotiate.js';
import { sendError } from './_errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// These pages change when the code changes, not on a clock. Cache them hard at
// the edge and let a deploy be the invalidation.
const CACHE = 'public, s-maxage=86400, stale-while-revalidate=604800';

let shellCache = null;
export function loadShell() {
    if (shellCache) return shellCache;
    const candidates = [
        join(__dirname, '_page-shell.html'),                    // repo + nft bundle layout
        join(process.cwd(), 'api', '_page-shell.html'),         // /var/task/api (includeFiles)
    ];
    let lastErr = null;
    for (const p of candidates) {
        try {
            shellCache = readFileSync(p, 'utf8');
            return shellCache;
        } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error('page: _page-shell.html not found');
}

// WebPage + BreadcrumbList, matching the per-office JSON-LD contract in
// scripts/build-offices.mjs. `<` escaped so the JSON can never terminate the
// <script> element early.
export function pageJsonLd(page) {
    const url = `https://plaincast.live/${page.slug}`;
    const data = {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        '@id': url,
        'url': url,
        'name': page.title,
        'description': page.description,
        'inLanguage': 'en-US',
        'isPartOf': { '@type': 'WebSite', 'name': 'Plaincast', 'url': 'https://plaincast.live' },
        'publisher': { '@type': 'Person', 'name': 'Jonah Berg', 'url': 'https://jonahberg.com' },
        'breadcrumb': {
            '@type': 'BreadcrumbList',
            'itemListElement': [
                { '@type': 'ListItem', 'position': 1, 'name': 'Plaincast', 'item': 'https://plaincast.live/' },
                { '@type': 'ListItem', 'position': 2, 'name': page.title, 'item': url },
            ],
        },
    };
    const json = JSON.stringify(data, null, 4).replace(/</g, '\\u003c');
    return `    <script type="application/ld+json">\n    ${json.split('\n').join('\n    ')}\n    </script>`;
}

export function renderPageHtml(shell, page) {
    // replacer fns throughout: `$`-sequences in content must not be
    // interpreted as replacement patterns.
    const content = renderBlocksHtml(page.blocks);
    const jsonld = pageJsonLd(page);
    return shell
        .split('{{TITLE}}').join(escHtml(page.title))
        .split('{{DESCRIPTION}}').join(escHtml(page.description))
        .split('{{SLUG}}').join(page.slug)
        .split('{{FOLIO}}').join(escHtml(page.folio))
        .split('{{DATELINE}}').join(escHtml(page.dateline))
        .replace('{{JSONLD}}', () => jsonld)
        .replace('{{CONTENT}}', () => content);
}

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendError(res, 405, 'method_not_allowed', 'GET only', { allow: ['GET', 'HEAD'] });
    }

    const slug = String(req.query?.slug || '').toLowerCase();
    const page = PAGES[slug];
    if (!page) {
        // Only the three rewrites in vercel.json reach here, so this is a
        // routing bug rather than a user-visible 404 — but never guess.
        const { default: notFound } = await import('./not-found.js');
        return notFound(req, res);
    }

    const markdown = renderPageMarkdown(page);
    let html;
    try {
        html = renderPageHtml(loadShell(), page);
    } catch (err) {
        // Shell missing from the bundle: serve the words anyway. Markdown in a
        // <pre> is a worse page, not a broken one.
        console.error('page: shell unavailable:', err?.message || err);
        html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">`
            + `<title>${escHtml(page.title)} · Plaincast</title>`
            + `<link rel="canonical" href="https://plaincast.live/${page.slug}">`
            + `</head><body><h1>${escHtml(page.title)}</h1><pre>${escHtml(markdown)}</pre></body></html>`;
    }

    return sendNegotiated(req, res, { [HTML]: html, [MARKDOWN]: markdown }, { cacheControl: CACHE });
}
