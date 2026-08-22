// Trust-anchor page content: /about, /contact, /privacy.
//
// WHY THIS EXISTS: these are the pages an agent reads to decide whether a site
// is a real thing run by a real person before it recommends it. They are also
// the pages most likely to rot, so the content lives here as structured blocks
// and renders to BOTH the HTML page and its Markdown representation from one
// source — there is no second copy to forget to update.
//
// Every factual claim below is checked against the code: the localStorage keys
// are the ones docs/js/app.js writes, the AI path is api/translate.js, the
// IP-geolocation path is api/whereami.js, the analytics scripts are the two
// <script defer> tags in the page shells.
//
// Files prefixed with `_` are not treated as endpoints by Vercel.

// A block is one of:
//   { p: 'prose' }                      → paragraph
//   { h: 'Heading' }                    → <h2> / '## '
//   { ul: ['item', ...] }               → list
//   { dl: [['term', 'definition'], ...] } → definition list
//   { pre: 'shell text' }                → preformatted block (fenced in Markdown)
//
// Inline markup is written as Markdown links — [text](href) — and converted
// for the HTML rendering. Keep it to links; anything richer belongs in prose.

export const PAGES = {
    about: {
        slug: 'about',
        title: 'About Plaincast',
        folio: 'About',
        dateline: 'What this is, and who makes it',
        description: 'Plaincast translates National Weather Service Area Forecast Discussions into plain English. What it is, how it works, where the data comes from, and who runs it.',
        blocks: [
            { p: 'Plaincast is a free, independent website that takes the National Weather Service\'s Area Forecast Discussion — the real forecast, written 3 to 4 times a day by the meteorologist on shift — and translates it into plain English.' },
            { p: 'An Area Forecast Discussion is the most informative weather product the government publishes and the least readable. It is where a forecaster explains their reasoning: which models disagree, what they are watching, how confident they are, and what would have to change for the forecast to bust. None of that survives the trip to a weather app icon. But it is written in dense shorthand for other meteorologists — "hgts fall aft 12Z w/ shrtwv trof apchg the cwa" — so almost nobody outside the field reads it.' },
            { p: 'Plaincast puts the plain-English summary beside the annotated original, so you can read the translation and still check the forecaster\'s actual words. Nothing is hidden behind the summary.' },

            { h: 'How it works' },
            { ul: [
                'The latest discussion is fetched live from the National Weather Service API for any of 68 forecast offices. Nothing is scraped, and no key is required — it is public data.',
                'Each section is summarized by Anthropic\'s Claude Haiku into readable prose. The model summarizes; it never forecasts, and it is never asked to add information the forecaster did not write.',
                'The original text is annotated in parallel: 230+ meteorological terms carry hover definitions, 109 abbreviation patterns are expanded, and Zulu times are converted to the office\'s local clock.',
                'A confidence reading is derived from the forecaster\'s own hedging language — "high confidence" and "models diverge" are counted, not guessed at.',
                'Every page is readable without JavaScript and without AI: the server renders a decoded plain-text edition first, and the interactive one loads over it.',
            ] },

            { h: 'Where the data comes from' },
            { p: 'Every forecast, alert, and outlook on this site originates with the National Weather Service and the Storm Prediction Center, both part of NOAA. Plaincast adds no observations, no model runs, and no forecasting of its own. It is a reading layer, not a source.' },
            { p: 'Plaincast is not affiliated with, endorsed by, or operated by NOAA, the National Weather Service, or any government agency.' },

            { h: 'When not to use it' },
            { p: 'For a life-safety decision, read the original. During a warning, go to [weather.gov](https://www.weather.gov) or your local office directly — Plaincast summarizes a discussion product that can be up to six hours old, and a machine translation is one more layer between you and the forecaster. Plaincast is for understanding the forecast, not for taking shelter.' },

            { h: 'Who makes it' },
            { p: 'Plaincast is built and run by Jonah Berg as an independent project. It is free, has no accounts, runs no ads, and sells nothing. The source is public.' },
            { ul: [
                'Source code: [github.com/jonahberg/plaincast](https://github.com/jonahberg/plaincast)',
                'The author: [jonahberg.com](https://jonahberg.com)',
                'Get in touch: [/contact](/contact)',
            ] },
        ],
    },

    contact: {
        slug: 'contact',
        title: 'Contact Plaincast',
        folio: 'Contact',
        dateline: 'How to reach a human',
        description: 'How to report a bug, a bad translation, a security issue, or a missing forecast office on Plaincast — and what to expect when you do.',
        blocks: [
            { p: 'Plaincast is run by one person, Jonah Berg, and every channel below reaches him directly. There is no support queue and no ticket robot.' },

            { h: 'Report a bug or a bad translation' },
            { p: 'Open an issue at [github.com/jonahberg/plaincast/issues](https://github.com/jonahberg/plaincast/issues). This is the fastest route and the one to prefer, because the fix and the discussion end up in the same public place.' },
            { p: 'A translation that misreads the forecaster is the single most useful thing to report. Include the office code and roughly when you read it — for example "OKX, Thursday morning" — so the issuance can be found. Discussions are replaced 3 to 4 times a day, so a screenshot of what you saw helps more than a link.' },

            { h: 'Report a security issue' },
            { p: 'Security contact and policy are published at [/.well-known/security.txt](/.well-known/security.txt), per [RFC 9116](https://www.rfc-editor.org/rfc/rfc9116). Please report vulnerabilities there rather than in a public issue thread.' },

            { h: 'Ask for a forecast office' },
            { p: 'Plaincast covers 68 of the National Weather Service\'s forecast offices — the ones covering the largest share of the population. If yours is missing, open an issue naming the three-letter office code and it will be considered for the next batch. Every covered office is listed in [/llms.txt](/llms.txt) and [/sitemap.xml](/sitemap.xml).' },

            { h: 'Everything else' },
            { p: 'For anything that is not about the site itself — writing, work, or the other projects — [jonahberg.com](https://jonahberg.com) is the front door.' },
            { p: 'Two things Plaincast cannot help with. It cannot answer "what is the weather going to do" — read your local edition, or ask the National Weather Service. And it cannot change a forecast: every word on this site is the NWS\'s, and corrections to a forecast belong with the office that issued it.' },
        ],
    },

    developers: {
        slug: 'developers',
        title: 'Plaincast for developers',
        folio: 'Developers',
        dateline: 'The API, the Markdown contract, and the machine-readable index',
        description: 'Plaincast developer documentation: the read-only NWS API endpoints, the Accept: text/markdown contract every page honours, the OpenAPI spec, and the rate limits. No API key, no signup.',
        blocks: [
            { p: 'Plaincast is a reading layer over the National Weather Service. Everything below is free, needs no API key and no account, and returns data that originates with NOAA. If you are an AI agent deciding how to call this site, start with the Markdown contract — it is the part of Plaincast most worth calling.' },
            { ul: [
                'Machine-readable spec: [/openapi.json](/openapi.json) (OpenAPI 3.1)',
                'Agent guidance and every office code: [/llms.txt](/llms.txt)',
                'Every page on the site: [/sitemap.xml](/sitemap.xml)',
                'Source: [github.com/jonahberg/plaincast](https://github.com/jonahberg/plaincast)',
            ] },

            { h: 'The Markdown contract' },
            { p: 'Every page on Plaincast serves two representations from one URL. Send `Accept: text/markdown` and you get the decoded forecast as clean prose — no nav, no scripts, no DOM. This is the fastest way to read Plaincast programmatically, and it needs no endpoint at all: request the page URL you already know.' },
            { pre: 'curl -H "Accept: text/markdown" https://plaincast.live/o/OKX/' },
            { p: 'The site is [acceptmarkdown.com](https://acceptmarkdown.com) compliant: `Vary: Accept` is set on every response, q-values are honoured, and an `Accept` that cannot be satisfied returns `406` listing what is available. Pages also advertise `<link rel="alternate" type="text/markdown">`. Every page is server-rendered, so no JavaScript execution is required either way.' },
            { dl: [
                ['https://plaincast.live/', 'Site overview plus the current edition for the default office.'],
                ['https://plaincast.live/o/<CODE>/', 'One office\'s Area Forecast Discussion, decoded. 3-letter NWS code.'],
                ['https://plaincast.live/national/', 'The National Desk: SPC Day 1 outlook and every office under a severe warning.'],
                ['https://plaincast.live/about', 'These trust pages serve Markdown too.'],
            ] },

            { h: 'JSON endpoints' },
            { p: 'A small read-only surface for the data that is not a page. All are `GET`, all are CDN-cached, none need a key.' },
            { dl: [
                ['GET /api/feed?office=<CODE>', 'RSS 2.0 for one office — a new item per issuance, with the delta.'],
                ['GET /api/conditions?office=<CODE>', 'Current temperature and the seasonal normal. JSON.'],
                ['GET /api/og?office=<CODE>', 'The office\'s share card as a 1200×630 PNG.'],
                ['GET /api/whereami', 'The nearest covered office for the caller\'s IP, or 204 if none. JSON, never cached.'],
            ] },
            { pre: 'curl https://plaincast.live/api/conditions?office=LOX\n{"temp":72,"normal":75,"delta":-3}' },
            { p: 'The AI-backed endpoints (`/api/translate`, `/api/translate-issuance`, `/api/changelog`, `/api/explain-alert`, `/api/national-lede`) are this site\'s own backend. They spend model budget per call and are rate-limited per IP, so they are deliberately left out of the spec and are not supported for third-party use. If you want the AI summary, read the page — it is already in there.' },

            { h: 'Errors' },
            { p: 'Every `/api/*` failure returns JSON with a stable machine `code`, a human `error` string, a `hint` naming the fix, and a `docs` link. Branch on `code`, never on the prose.' },
            { pre: 'curl -i https://plaincast.live/api/conditions?office=ZZZ\n\nHTTP/2 400\ncontent-type: application/json; charset=utf-8\n\n{\n  "error": "Invalid office",\n  "code": "invalid_office",\n  "hint": "Pass ?office=<CODE> with a 3-letter NWS office code, e.g. ?office=LOX...",\n  "docs": "https://plaincast.live/developers"\n}' },
            { p: 'Codes in use: `invalid_office`, `invalid_id`, `invalid_request`, `method_not_allowed`, `not_found`, `rate_limited`, `upstream_error`, `timeout`, `forbidden`, `internal_error`. They are a contract — new codes get added, existing ones are never repurposed. An unknown `/api/*` path returns `404` as JSON, listing the endpoints that do exist.' },

            { h: 'Rate limits and etiquette' },
            { ul: [
                'No key, no signup, no quota to request. The limit is per IP: 30 requests a minute on the AI endpoints, and no fixed limit on the page and feed URLs beyond what the CDN absorbs.',
                'Send a descriptive `User-Agent` naming your project. Anonymous floods are the only thing that would force a key.',
                'Responses are CDN-cached and carry real `Cache-Control`. Honour it rather than polling — Area Forecast Discussions are reissued 3 to 4 times a day, not continuously.',
                'Data is the National Weather Service\'s and is public domain. Plaincast adds the decoding, not the forecast. Attribute NOAA, and say the plain English came from a machine.',
            ] },

            { h: 'What Plaincast does not have' },
            { p: 'Stated plainly so you do not go looking: there are no API keys, no OAuth, no accounts, no sandbox or staging environment, no webhooks, no write endpoints, and no MCP server. Nothing here is gated, so there is nothing to provision — the production URLs above are the only environment, and they are safe to call from a test.' },
            { p: 'If you need something that is missing, open an issue at [github.com/jonahberg/plaincast/issues](https://github.com/jonahberg/plaincast/issues). See also [/about](/about), [/contact](/contact) and [/privacy](/privacy).' },
        ],
    },

    privacy: {
        slug: 'privacy',
        title: 'Privacy on Plaincast',
        folio: 'Privacy',
        dateline: 'What is collected, and what is not',
        description: 'Plaincast has no accounts, no advertising, and no tracking cookies. What the site stores in your browser, what it sends to third parties, and why.',
        blocks: [
            { p: 'Plaincast has no accounts, no sign-up, no advertising, no advertising or analytics cookies, and no third-party trackers. Nothing you read here is tied to an identity, because there is no identity to tie it to. This page describes what actually happens, service by service.' },

            { h: 'What stays in your browser' },
            { p: 'These are stored locally by your browser and are never transmitted to Plaincast or anyone else. Clearing your site data removes all of them.' },
            { dl: [
                ['theme', 'Light or dark, if you have used the toggle.'],
                ['plaincast-office', 'The last forecast office you read, so the site opens there next time.'],
                ['plaincast-visits', 'A count of visits, used only to decide when to offer the "add to home screen" prompt.'],
                ['plaincast-install-dismissed', 'A flag set when you dismiss that prompt, so it is not offered again.'],
                ['Session cache', 'The current discussion text, held in sessionStorage so a reload does not re-fetch it. It is discarded when you close the tab.'],
            ] },

            { h: 'What leaves your browser' },
            { ul: [
                'Forecast requests go to the National Weather Service API (api.weather.gov) from your browser. Those requests reach NOAA directly and are subject to the [NWS privacy policy](https://www.weather.gov/privacy).',
                'Forecast text is sent to Anthropic\'s Claude, through the Vercel AI Gateway, to be summarized. What is sent is the National Weather Service\'s published forecast text — never anything you typed, and never anything identifying you. Plaincast has no input field.',
                'The site is hosted on Vercel, which terminates every request and keeps standard server logs, including IP addresses. Vercel is also where the per-IP rate limit on the translation endpoint is enforced, using the forwarded IP for the length of that check only.',
                'Vercel Web Analytics and Speed Insights run on the page. Both are configured by Vercel to be cookie-free and to record aggregate page and performance data without a cross-site identifier.',
            ] },

            { h: 'Location' },
            { p: 'Plaincast never asks for your location on its own. On a first visit with no office already chosen, your browser may offer the standard location permission prompt so the nearest forecast office can be pre-selected; declining it simply falls back to Los Angeles, and the coordinates are used in your browser to pick an office and are not sent to Plaincast or stored.' },
            { p: 'The National Desk uses a coarser signal: Vercel supplies an approximate city-level latitude and longitude derived from the connecting IP address, which the server exchanges with the National Weather Service for a forecast-office code. That response is marked never-to-be-cached, the coordinates are not logged by Plaincast, and no permission prompt is involved because no device location is read.' },

            { h: 'Children, sale of data, and requests' },
            { p: 'Plaincast is not directed at children, and it knowingly collects nothing from anyone. There is no personal data to sell, share, or trade, and none is sold, shared, or traded. Because no account exists and nothing is keyed to a person, there is generally nothing to look up in response to an access or deletion request — but if you believe otherwise, write to the address in [/.well-known/security.txt](/.well-known/security.txt) and it will be answered.' },

            { h: 'Changes' },
            { p: 'This page is versioned in public along with the code that it describes. Its history — every word ever changed, and when — is at [github.com/jonahberg/plaincast](https://github.com/jonahberg/plaincast).' },
        ],
    },
};

export const PAGE_SLUGS = Object.keys(PAGES);

export function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// [text](href) → <a>. Escapes first, so the link text and the href can never
// carry markup out of the content module. External links get rel/target to
// match the colophon links already in the shells.
function inlineHtml(text) {
    return escHtml(text).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
        const external = /^https?:\/\//.test(href);
        const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : '';
        return `<a href="${href}"${attrs}>${label}</a>`;
    });
}

// [text](href) → text (href). Markdown keeps its links as-is, except that
// site-relative ones are absolutized: an agent that fetched this page as
// Markdown has no base URL to resolve "/contact" against.
function inlineMarkdown(text) {
    return String(text).replace(/\]\((\/[^)\s]*)\)/g, '](https://plaincast.live$1)');
}

export function renderBlocksHtml(blocks) {
    const out = [];
    for (const b of blocks) {
        if (b.h) out.push(`        <h2 class="page-heading">${escHtml(b.h)}</h2>`);
        else if (b.p) out.push(`        <p>${inlineHtml(b.p)}</p>`);
        else if (b.ul) {
            out.push('        <ul class="page-list">');
            for (const li of b.ul) out.push(`            <li>${inlineHtml(li)}</li>`);
            out.push('        </ul>');
        } else if (b.pre) {
            // Not inlineHtml: a code sample is literal text, never markup or links.
            out.push(`        <pre class="page-pre"><code>${escHtml(b.pre)}</code></pre>`);
        } else if (b.dl) {
            out.push('        <dl class="page-defs">');
            for (const [term, def] of b.dl) {
                out.push(`            <dt>${inlineHtml(term)}</dt>`);
                out.push(`            <dd>${inlineHtml(def)}</dd>`);
            }
            out.push('        </dl>');
        }
    }
    return out.join('\n');
}

export function renderBlocksMarkdown(blocks) {
    const out = [];
    for (const b of blocks) {
        if (b.h) out.push(`## ${b.h}`);
        else if (b.p) out.push(inlineMarkdown(b.p));
        else if (b.pre) out.push('```bash\n' + b.pre + '\n```');
        else if (b.ul) out.push(b.ul.map(li => `- ${inlineMarkdown(li)}`).join('\n'));
        else if (b.dl) out.push(b.dl.map(([t, d]) => `- **${t}** — ${inlineMarkdown(d)}`).join('\n'));
    }
    return out.join('\n\n');
}

export function renderPageMarkdown(page) {
    return `# ${page.title}\n\n> ${page.description}\n\n`
        + `${renderBlocksMarkdown(page.blocks)}\n\n`
        + `---\n\n`
        + `_Plaincast — NWS Area Forecast Discussions in plain English. `
        + `[Home](https://plaincast.live/) · [The National Desk](https://plaincast.live/national/) · `
        + `[About](https://plaincast.live/about) · [Contact](https://plaincast.live/contact) · `
        + `[Privacy](https://plaincast.live/privacy) · [llms.txt](https://plaincast.live/llms.txt)_\n`;
}

// Plain-text length of a page's prose — what a crawler counts as "content".
// Used by tests to hold every trust page above the 500-character bar.
export function pageTextLength(page) {
    return renderBlocksMarkdown(page.blocks).replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim().length;
}
