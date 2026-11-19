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
// ChST / SST where Intl prints "GMT+10" / "GMT-11" (Guam, American Samoa).
import { formatInZone } from '../shadcn/src/lib/format.js';
import { fetchAFDList, fetchAFDProduct, productUrlFromItem } from './_utils.js';
import { regexTranslate } from './_afd-sections.js';
import {
    loadTemplate, editionSections as fullEdition, wantsBoot,
    aiForSections, aiSectionBody, issuedHtml, withAi, STORE_CACHE, CACHE_TAG_HEADER,
} from './office-page.js';
import { buildBoot, cacheControlFor, fetchBootExtras, insertBoot, SHORT_CACHE } from './_boot.js';
import { AI_FOR_AGENTS, HOME_TAG, STORE_RENDER, officeTag, readRenderableEdition, switchOn } from './_store.js';
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

const FULL_CACHE = 'public, s-maxage=900, stale-while-revalidate=3600';

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
        return formatInZone(d, {
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
// `opts` only with PLAINCAST_AI_FOR_AGENTS=1 ({ ai, issuanceTime }; see
// api/office-page.js buildSsrHtml): absent, the output is the switch-off page.
export function buildHomeSsr(code, city, sections, issued, opts = null) {
    if (sections.length === 0) throw new Error('home: no renderable sections');
    const ai = opts?.ai || null;
    const offices = Object.keys(OFFICE_NAMES).length;

    const standfirst = ai
        ? `        <p class="ssr-standfirst">Plaincast decodes the National Weather Service's Area Forecast ` +
          `Discussion — the real forecast, written 3 to 4 times a day by the meteorologist on shift — into ` +
          `plain English. The discussion is where a forecaster explains their reasoning: which models ` +
          `disagree, what they are watching, and how confident they are. Below is the current edition for ` +
          `${escHtml(city)}: each section opens with a plain-English summary written by AI (Claude), followed ` +
          `by the forecaster's own text with its shorthand expanded. Every one of the ` +
          `<a href="/national/">${offices} forecast offices</a> has its own edition.</p>\n`
        : `        <p class="ssr-standfirst">Plaincast decodes the National Weather Service's Area Forecast ` +
          `Discussion — the real forecast, written 3 to 4 times a day by the meteorologist on shift — into ` +
          `plain English. The discussion is where a forecaster explains their reasoning: which models ` +
          `disagree, what they are watching, and how confident they are. Below is the current edition for ` +
          `${escHtml(city)}, with its shorthand expanded. The full experience — an AI plain-English summary ` +
          `beside the annotated original — loads with JavaScript, and every one of the ` +
          `<a href="/national/">${offices} forecast offices</a> has its own edition.</p>\n`;

    const metaLine = issued
        ? `        <p class="ssr-meta">Area Forecast Discussion · National Weather Service ${escHtml(city)} (${escHtml(code)}) · issued ${issuedHtml(issued, opts?.issuanceTime, Boolean(opts))}.</p>\n`
        : `        <p class="ssr-meta">Area Forecast Discussion · National Weather Service ${escHtml(city)} (${escHtml(code)}).</p>\n`;

    const articles = sections.map(s => {
        const name = escHtml(SECTION_NAMES[s.key] || titleCase(s.key));
        const aiText = ai ? ai.get(s.key) : null;
        const body = aiText
            ? aiSectionBody(aiText, s.paras)
            : s.paras.map(p => `            <p>${escHtml(regexTranslate(p))}</p>`).join('\n');
        return `        <article class="forecast-section ssr">\n` +
            `            <h2 class="section-title">${name}</h2>\n` +
            `${body}\n` +
            `        </article>`;
    });

    const note = ai
        ? `        <p class="ssr-note">Each summary above is written by AI (Claude) from the National Weather Service ` +
          `text that follows it. Read the whole ${escHtml(city)} discussion at <a href="/o/${escHtml(code)}/">/o/${escHtml(code)}/</a>, ` +
          `see <a href="/o/${escHtml(code)}/?view=changelog">what changed since the last one</a>, or open ` +
          `<a href="/national/">The National Desk</a> for where the weather is today.</p>`
        : `        <p class="ssr-note">This is the plain-text edition, decoded without AI so it loads anywhere. ` +
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

    // Switches, read per request (api/_store.js). All off: the live path
    // below, byte for byte as before.
    const storeRender = switchOn(STORE_RENDER);
    const aiForAgents = switchOn(AI_FOR_AGENTS);
    // The homepage shows an office's edition: tag it with that office (the
    // poller purges by office) and `home`.
    if (storeRender) res.setHeader(CACHE_TAG_HEADER, `${officeTag(code)},${HOME_TAG}`);

    try {
        const boot = Boolean(baked) && wantsBoot(chosen, req.query);
        const wantExtras = boot || aiForAgents;
        let product;
        let extrasPending;
        const stored = storeRender ? await readRenderableEdition(code) : null;
        if (stored) {
            product = stored.current;
            extrasPending = wantExtras ? fetchBootExtras(code, product.id) : null;
        } else {
            const items = await fetchAFDList(code, { signal: AbortSignal.timeout(8000) });
            const prodUrl = productUrlFromItem(items[0]);
            if (!prodUrl) throw new Error('no AFD product listed');
            // Boot extras run in parallel with the product fetch (see office-page.js).
            const latestId = items[0]?.id || null;
            extrasPending = wantExtras && latestId ? fetchBootExtras(code, latestId) : null;
            const prod = await fetchAFDProduct(prodUrl, { signal: AbortSignal.timeout(8000) });
            const text = typeof prod?.productText === 'string' ? prod.productText : '';
            if (!text) throw new Error('empty AFD product');
            product = { id: prod?.id || latestId, issuanceTime: prod?.issuanceTime, productText: text };
        }
        const text = product.productText;
        const extras = extrasPending ? await extrasPending : null;
        const ai = aiForAgents ? aiForSections(text, extras?.translation, code, product.id, MAX_SECTIONS) : null;

        const sections = withAi(editionSections(text), ai);
        const issued = formatIssued(product.issuanceTime, OFFICE_TIMEZONES[code] || 'America/Los_Angeles');
        const markdown = renderHomeMarkdown({
            code, city, sections, issued, edition: true,
            ...(aiForAgents ? { aiIncluded: Boolean(ai), issuedIso: product.issuanceTime } : {}),
        });

        let html = null;
        const fullCache = stored ? STORE_CACHE : FULL_CACHE;
        let cacheControl = fullCache;
        if (baked) {
            if (!baked.includes(LOADING_DIV)) throw new Error('skeleton marker missing from template');
            // replacer fn: `$`-sequences in forecast text must not be interpreted
            html = baked.replace(LOADING_DIV, () => buildHomeSsr(code, city, sections, issued,
                aiForAgents ? { ai, issuanceTime: product.issuanceTime } : null));
            if (boot && extrasPending) {
                const bootData = buildBoot({
                    office: code,
                    product: { id: product.id, issuanceTime: product.issuanceTime, productText: text },
                    extras,
                });
                html = insertBoot(html, bootData);
                cacheControl = cacheControlFor(bootData, fullCache);
            }
        }
        // With the AI switch on, a page still waiting for its translation is
        // regenerated soon, in both representations, so the AI text lands.
        if (aiForAgents && !ai) cacheControl = SHORT_CACHE;

        return sendNegotiated(req, res, {
            [HTML]: html || minimalHtml(markdown),
            [MARKDOWN]: markdown,
        }, { cacheControl });
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
