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
- RSS per office: \`https://plaincast.live/api/feed?office=<CODE>\`

Every page above also serves Markdown to \`Accept: text/markdown\`.

[About](https://plaincast.live/about) · [Contact](https://plaincast.live/contact) · [Privacy](https://plaincast.live/privacy)
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
    <meta name="theme-color" content="#f7f3ea">
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌤️</text></svg>">
    <link rel="stylesheet" href="/fonts/fonts.css">
    <script src="/js/theme-init.js"></script>
    <link rel="stylesheet" href="/styles.css">
</head>
<body>
<div class="atmosphere" aria-hidden="true">
    <div class="atmosphere-wash"></div>
    <div class="atmosphere-glow"></div>
    <div class="atmosphere-grain"></div>
</div>
<div class="sheet">
<header class="masthead header">
    <div class="wrap masthead-inner">
        <div class="folio folio-left"><a href="/">Plaincast</a></div>
        <div class="nameplate-block">
            <h1 class="nameplate">Not found</h1>
        </div>
        <div class="folio folio-right">404</div>
        <p class="motto">What the forecast actually says</p>
        <div class="rule-double" role="presentation"></div>
        <p class="dateline">
            <span class="dateline-city">PLAINCAST</span>
            <span class="dateline-sep" aria-hidden="true">·</span>
            <span class="dateline-date">No such page</span>
        </p>
    </div>
</header>
<main class="wrap main" id="page">
    <article class="page-prose">
        <p>That path does not exist. Plaincast is a small site; here is all of it.</p>
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
            <li>RSS per office: <code>/api/feed?office=&lt;CODE&gt;</code></li>
        </ul>
        <p class="ssr-note">Every page above also serves Markdown to <code>Accept: text/markdown</code>.</p>
    </article>
</main>
<footer class="colophon">
    <div class="wrap colophon-inner">
        <div class="colophon-rule" role="presentation"></div>
        <p class="colophon-line colophon-links">
            <a href="/">Home</a>
            <span class="dot" aria-hidden="true">·</span>
            <a href="/national/">The National Desk</a>
            <span class="dot" aria-hidden="true">·</span>
            <a href="/about">About</a>
            <span class="dot" aria-hidden="true">·</span>
            <a href="/contact">Contact</a>
            <span class="dot" aria-hidden="true">·</span>
            <a href="/privacy">Privacy</a>
        </p>
    </div>
</footer>
</div><!-- /.sheet -->
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
