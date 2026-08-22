// Vercel serverless function: the server-rendered homepage at /.
//
// WHY THIS EXISTS: docs/index.html ships an empty #sections shell — every word
// of forecast content loads client-side from api.weather.gov, whose robots.txt
// disallows crawlers. To an agent that does not run JavaScript (most of them),
// and to a JS-rendering crawler that respects the upstream robots.txt, the
// homepage was a masthead and a loading state. This serves the same page with
// the latest discussion regex-translated (no AI spend) into #sections, and
// answers `Accept: text/markdown` with a prose edition. docs/js/app.js
// overwrites #sections wholesale on load, so for browsers this is pure
// progressive enhancement — the rendered page is byte-for-byte today's page
// plus content in the slot that said "Setting the type…".
//
// ROUTING: `/` rewrites here (vercel.json). Rewrites are evaluated AFTER
// `handle: filesystem`, so a deployed static docs/index.html would shadow this
// function and it would never run — that is why docs/index.html joins docs/o in
// .vercelignore. It stays committed (local dev, scripts/build-offices.mjs,
// tests/seo-pages.test.js) and reaches the functions through includeFiles.
//
// THE TRADE, STATED PLAINLY: the homepage no longer has a static-file floor.
// Every response path below degrades to the exact committed docs/index.html
// bytes, so any failure INSIDE the handler is invisible — but a failure to
// invoke the function at all has no static net, where before it did. This is
// the same trade already accepted for /o/<CODE>/ and /national/.

import { OFFICE_NAMES, OFFICE_TIMEZONES, SECTION_NAMES } from '../docs/js/offices.js';
import { escHtml } from '../scripts/build-offices.mjs';
import { fetchAFDList, fetchAFDProduct, productUrlFromItem } from './_utils.js';
import { regexTranslate } from './_afd-sections.js';
import { loadTemplate, editionSections as fullEdition } from './office-page.js';
import { renderHomeMarkdown } from './_edition-markdown.js';
import { sendNegotiated, HTML, MARKDOWN, send406, setVary, selectRepresentation, acceptHeader } from './_negotiate.js';
import { sendError } from './_errors.js';

// Exact skeleton markup in docs/index.html that the SSR content replaces.
// If the template drifts and this marker disappears, we throw → baked page.
const LOADING_DIV = '<div class="loading" id="loading">Setting the type…</div>';

// The office the app itself opens to (docs/js/app.js: `let currentOffice = 'LOX'`)
// when there is no ?office=, no saved choice, and no geolocation.
const DEFAULT_OFFICE = 'LOX';

// Shorter than the office page's four. The homepage is an invitation, not the
// edition of record: /o/<CODE>/ is the canonical home of a full discussion, and
// two sections is enough to prove there is real content here without making
// the homepage a duplicate of it.
const MAX_SECTIONS = 2;

// `/?office=OKX` is the legacy form documented in llms.txt and still linked
// from the SSR note. Honour it, but only for offices that exist — the value is
// echoed into HTML, so it is validated against OFFICE_NAMES, never trusted.
export function resolveOffice(raw) {
    const code = String(raw || '').toUpperCase();
    return OFFICE_NAMES[code] ? code : DEFAULT_OFFICE;
}

function titleCase(key) {
    return String(key).toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
}

function formatIssued(iso, tz) {
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return null;
        return d.toLocaleString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric',
            hour: 'numeric', minute: '2-digit',
            timeZone: tz, timeZoneName: 'short',
        });
    } catch { return null; }
}

// The decoded sections both representations render from — the office page's
// own selection, trimmed. Sharing the selector is the point: the homepage must
// never disagree with /o/<CODE>/ about what the current discussion says.
export function editionSections(productText) {
    return fullEdition(productText).slice(0, MAX_SECTIONS);
}

// The homepage's #sections content: a standfirst that says what this site is
// (the part an agent most needs and JavaScript cannot be relied on to deliver),
// then the decoded edition, then a pointer to the canonical office page.
export function buildHomeSsr(code, city, sections, issued) {
    if (sections.length === 0) throw new Error('home: no renderable sections');

    const standfirst =
        `        <p class="ssr-standfirst">Plaincast decodes the National Weather Service's Area Forecast ` +
        `Discussion — the real forecast, written 3 to 4 times a day by the meteorologist on shift — into ` +
        `plain English. The discussion is where a forecaster explains their reasoning: which models ` +
        `disagree, what they are watching, and how confident they are. Below is the current edition for ` +
        `${escHtml(city)}, with its shorthand expanded. The full experience — an AI plain-English summary ` +
        `beside the annotated original — loads with JavaScript, and every one of the ` +
        `<a href="/national/">68 forecast offices</a> has its own edition.</p>\n`;

    const metaLine = issued
        ? `        <p class="ssr-meta">Area Forecast Discussion · National Weather Service ${escHtml(city)} (${escHtml(code)}) · issued ${escHtml(issued)}.</p>\n`
        : `        <p class="ssr-meta">Area Forecast Discussion · National Weather Service ${escHtml(city)} (${escHtml(code)}).</p>\n`;

    const articles = sections.map(s => {
        const name = escHtml(SECTION_NAMES[s.key] || titleCase(s.key));
        const body = s.paras.map(p => `            <p>${escHtml(regexTranslate(p))}</p>`).join('\n');
        return `        <article class="forecast-section ssr">\n` +
            `            <h2 class="section-title">${name}</h2>\n` +
            `${body}\n` +
            `        </article>`;
    });

    const note =
        `        <p class="ssr-note">This is the plain-text edition, decoded without AI so it loads anywhere. ` +
        `Read the whole ${escHtml(city)} discussion at <a href="/o/${escHtml(code)}/">/o/${escHtml(code)}/</a>, ` +
        `see <a href="/o/${escHtml(code)}/?view=changelog">what changed since the last one</a>, or open ` +
        `<a href="/national/">The National Desk</a> for where the weather is today.</p>`;

    return `\n${standfirst}${metaLine}${articles.join('\n')}\n${note}\n    `;
}

// Last-resort HTML when the shell cannot be loaded at all: the Markdown
// representation, wrapped in a real document with a real H1 so the page is
// still readable, still crawlable, and still says what this site is.
export function minimalHtml(markdown) {
    const esc = escHtml(markdown);
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Plaincast - What the forecast actually says</title>
    <meta name="description" content="NWS meteorologists write the real forecasts 3-4x daily, but in dense shorthand. Plaincast uses AI to translate them into plain English anyone can read.">
    <link rel="canonical" href="https://plaincast.live">
    <link rel="alternate" type="text/markdown" href="https://plaincast.live/">
    <link rel="stylesheet" href="/styles.css">
</head>
<body>
<h1>Plaincast</h1>
<pre>${esc}</pre>
</body>
</html>
`;
}

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendError(res, 405, 'method_not_allowed', 'GET only', { allow: ['GET', 'HEAD'] });
    }

    // Decide the representation BEFORE any network work: an unsatisfiable
    // Accept should cost nothing upstream.
    const accept = acceptHeader(req);
    const chosen = selectRepresentation(accept, [HTML, MARKDOWN]);
    if (!chosen) return send406(res, [HTML, MARKDOWN], accept);

    const code = resolveOffice(req.query?.office);
    const city = OFFICE_NAMES[code];

    // Baked page first: this is the guaranteed floor for every HTML path.
    let baked = null;
    try {
        baked = loadTemplate();
    } catch (err) {
        // Shell missing from the bundle. Deliberately NOT a redirect to
        // /o/<CODE>/: api/office-page.js redirects back here on the same
        // failure, and a preview deploy on 2026-08-21 turned exactly that pair
        // into an infinite 307 loop when .vercelignore stripped the template
        // out of both bundles. Serve the words instead — a plain page is a
        // worse homepage, a loop is no homepage at all.
        console.error('home: shell unavailable:', err);
    }

    try {
        const items = await fetchAFDList(code, { signal: AbortSignal.timeout(8000) });
        const prodUrl = productUrlFromItem(items[0]);
        if (!prodUrl) throw new Error('no AFD product listed');
        const prod = await fetchAFDProduct(prodUrl, { signal: AbortSignal.timeout(8000) });
        const text = typeof prod?.productText === 'string' ? prod.productText : '';
        if (!text) throw new Error('empty AFD product');

        const sections = editionSections(text);
        const issued = formatIssued(prod?.issuanceTime, OFFICE_TIMEZONES[code] || 'America/Los_Angeles');
        const markdown = renderHomeMarkdown({ code, city, sections, issued, edition: true });

        let html = null;
        if (baked) {
            if (!baked.includes(LOADING_DIV)) throw new Error('skeleton marker missing from template');
            // replacer fn: `$`-sequences in forecast text must not be interpreted
            html = baked.replace(LOADING_DIV, () => buildHomeSsr(code, city, sections, issued));
        }

        return sendNegotiated(req, res, {
            [HTML]: html || minimalHtml(markdown),
            [MARKDOWN]: markdown,
        }, { cacheControl: 'public, s-maxage=900, stale-while-revalidate=3600' });
    } catch (err) {
        // NWS down, format drift, marker drift, anything: the exact committed
        // page bytes, shorter CDN window so recovery is quick. The Markdown
        // twin keeps the site description — the part that does not depend on
        // any upstream — so an agent still learns what Plaincast is.
        console.warn('home: serving baked fallback:', err?.message || err);
        const markdown = renderHomeMarkdown({ code, city, sections: [], issued: null, edition: false });
        return sendNegotiated(req, res, {
            [HTML]: baked || minimalHtml(markdown),
            [MARKDOWN]: markdown,
        }, { cacheControl: 'public, s-maxage=300' });
    }
}
