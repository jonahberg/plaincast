// Vercel serverless function: the catch-all 404.
//
// WHY THIS EXISTS: Vercel's default 404 is a real 404 — the status was never
// the problem — but its body is three lines of plain text and a request id. An
// agent that mistypes a URL learns nothing from it. This returns the same
// honest status with a short body that says where to look instead: the sitemap,
// llms.txt, the National Desk, and the shape of an office URL.
//
// ROUTING: a catch-all rewrite in vercel.json, placed LAST so every real route
// and every static file matches first. Rewrites are evaluated AFTER
// `handle: filesystem`, so this can only ever be reached by a path that
// genuinely does not exist.
//
// COST: a catch-all rewrite means one invocation per distinct bad path, which
// is a small denial-of-wallet surface. The response is therefore CDN-cacheable
// for an hour, so a flood against the SAME path costs one invocation, not one
// per request. Vary is set because the body negotiates.

import { sendNegotiated, HTML, MARKDOWN } from './_negotiate.js';

const CACHE = 'public, s-maxage=3600, stale-while-revalidate=86400';

// Deliberately short. A 404 is a signpost, not a page — the job is to name the
// four URLs that will actually get an agent or a reader unstuck.
export const MARKDOWN_BODY = `# 404 — no such page on Plaincast

That path does not exist. Plaincast is a small site; here is all of it.

- [Home](https://plaincast.live/) — your local edition, the latest NWS Area Forecast Discussion in plain English
- [The National Desk](https://plaincast.live/national/) — where the weather is today: the SPC outlook and every office under a severe warning
- Any forecast office: \`https://plaincast.live/o/<CODE>/\` — a three-letter NWS office code, e.g. [/o/OKX/](https://plaincast.live/o/OKX/) for New York
- What changed since the last discussion: \`https://plaincast.live/o/<CODE>/?view=changelog\`

## Machine-readable index

- [/sitemap.xml](https://plaincast.live/sitemap.xml) — every page on the site
- [/llms.txt](https://plaincast.live/llms.txt) — what Plaincast is for, when to use it, and every supported office code
- [/robots.txt](https://plaincast.live/robots.txt)
- [/openapi.json](https://plaincast.live/openapi.json) — the OpenAPI 3.1 spec for the JSON endpoints
- [/developers](https://plaincast.live/developers) — API docs, the Markdown contract, rate limits
- RSS per office: \`https://plaincast.live/api/feed?office=<CODE>\`

Every page above also serves Markdown to \`Accept: text/markdown\`.

[Developers](https://plaincast.live/developers) · [About](https://plaincast.live/about) · [Contact](https://plaincast.live/contact) · [Privacy](https://plaincast.live/privacy)
`;

// The HTML twin. Standalone and dependency-free on purpose: a 404 must not be
// able to fail for the same reason the page the reader asked for failed.
export const HTML_BODY = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>404 — no such page · Plaincast</title>
    <meta name="description" content="That path does not exist on Plaincast. Here is the whole site: your local edition, the National Desk, every forecast office, and the machine-readable index.">
    <meta name="robots" content="noindex">
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
    <meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme: dark)">
    <link rel="icon" href="/icon.svg" type="image/svg+xml">
    <script src="/js/theme-init.js"></script>
    <script defer src="/js/site-chrome.js"></script>
    <link rel="stylesheet" href="/styles.css">
</head>
<body>
<a class="skip-link" href="#page">Skip to content</a>
<!-- Site header: mirrors shadcn/src/components/Header.jsx (wordmark, nav,
     GitHub, theme toggle). Byte-identical across api/_page-shell.html,
     api/_national-shell.html and api/not-found.js (tests/site-chrome.test.js);
     /js/site-chrome.js marks the current nav link and wires the toggle. -->
<header class="site-header">
    <div class="container site-header-inner">
        <a href="/" class="brand">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/></svg>
            <span>Plaincast</span>
        </a>
        <span class="header-sep" aria-hidden="true"></span>
        <nav class="site-nav" aria-label="Site">
            <a href="/">Forecast</a>
            <a href="/national/">National Desk</a>
        </nav>
        <div class="header-actions">
            <a class="icon-btn hide-mobile" href="https://github.com/jonahberg/plaincast" target="_blank" rel="noopener noreferrer" aria-label="Source on GitHub" title="Source on GitHub">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
            </a>
            <button type="button" class="icon-btn" data-theme-toggle aria-label="Toggle dark mode" title="Toggle theme" hidden>
                <svg class="icon-moon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
                <svg class="icon-sun" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
            </button>
        </div>
    </div>
</header>
<main class="container container-narrow main" id="page">
    <div class="page-intro">
        <p class="page-kicker">404</p>
        <h1 class="page-title">No such page<span class="sr-only"> · Plaincast</span></h1>
        <p class="page-description">That path does not exist. Plaincast is a small site; here is all of it.</p>
    </div>
    <article class="card page-prose">
        <ul class="page-list">
            <li><a href="/">Home</a> — your local edition, the latest NWS Area Forecast Discussion in plain English</li>
            <li><a href="/national/">The National Desk</a> — where the weather is today: the SPC outlook and every office under a severe warning</li>
            <li>Any forecast office: <code>/o/&lt;CODE&gt;/</code> — a three-letter NWS office code, e.g. <a href="/o/OKX/">/o/OKX/</a> for New York</li>
            <li>What changed since the last discussion: <code>/o/&lt;CODE&gt;/?view=changelog</code></li>
        </ul>
        <h2 class="section-title">Machine-readable index</h2>
        <ul class="page-list">
            <li><a href="/sitemap.xml">/sitemap.xml</a> — every page on the site</li>
            <li><a href="/llms.txt">/llms.txt</a> — what Plaincast is for, when to use it, and every supported office code</li>
            <li><a href="/robots.txt">/robots.txt</a></li>
            <li><a href="/openapi.json">/openapi.json</a> — the OpenAPI 3.1 spec for the JSON endpoints</li>
            <li><a href="/developers">/developers</a> — API docs, the Markdown contract, rate limits</li>
            <li>RSS per office: <code>/api/feed?office=&lt;CODE&gt;</code></li>
        </ul>
        <p class="ssr-note">Every page above also serves Markdown to <code>Accept: text/markdown</code>.</p>
    </article>
</main>
<footer class="site-footer">
    <div class="container site-footer-inner">
        <p>Data from the <a href="https://www.weather.gov" target="_blank" rel="noopener noreferrer">National Weather Service</a>.</p>
        <nav class="footer-links" aria-label="About Plaincast">
            <a href="/">Home</a>
            <a href="/national/">National Desk</a>
            <a href="/developers">Developers</a>
            <a href="/about">About</a>
            <a href="/contact">Contact</a>
            <a href="/privacy">Privacy</a>
        </nav>
    </div>
</footer>
</body>
</html>
`;

export default async function handler(req, res) {
    return sendNegotiated(
        req, res,
        { [HTML]: HTML_BODY, [MARKDOWN]: MARKDOWN_BODY },
        { status: 404, cacheControl: CACHE },
    );
}
