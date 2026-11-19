// Vercel serverless function: server-rendered per-office page for /o/<CODE>/.
//
// WHY THIS EXISTS: the baked static office pages (docs/o/<CODE>/index.html)
// ship an empty #sections shell — all forecast content loads client-side from
// api.weather.gov, whose robots.txt disallows crawlers, so even JS-rendering
// Googlebot indexes a blank page. This function serves the same baked page
// with the latest AFD regex-translated (no AI spend) into #sections as a
// crawlable, no-JS-readable baseline. docs/js/app.js overwrites #sections
// wholesale on load, so for browsers this is pure progressive enhancement.
//
// ROUTING (verified against @vercel/routing-utils, which Vercel uses to
// transform vercel.json): rewrites are evaluated AFTER `handle: filesystem`,
// so a deployed static file would shadow the rewrite — that is why docs/o is
// excluded from deployment in .vercelignore. Headers become `continue: true`
// routes evaluated BEFORE the filesystem/rewrites and match the incoming
// request path, so the sitewide CSP/security headers still apply here.
//
// CONTENT NEGOTIATION: this URL serves two representations. `Accept:
// text/markdown` gets the same decoded sections as prose (api/_edition-markdown.js:
// no AI, unless PLAINCAST_AI_FOR_AGENTS=1 and a complete stored translation of
// this edition exists, then labelled as such); anything else gets the page.
//
// THE ENGINE (api/_store.js, api/cron-refresh.js), switches read per request,
// all default off:
//   PLAINCAST_STORE_RENDER=1   render from the poller's edition store (zero
//                              NWS calls) when it is fresh and current; tag
//                              every response with the office's cache tag.
//   PLAINCAST_AI_FOR_AGENTS=1  the stored AI text in <main> and the Markdown,
//                              labelled, with the NWS original kept.
// With both off, every response is the pre-engine page, pinned byte for byte
// by tests/engine-switches-off.test.js. Regardless of the switches, the
// issuance time is data: <time datetime> in the dateline and dateModified in
// the page's WebPage JSON-LD. Every response path sets
// `Vary: Accept` — with two bodies behind one URL, omitting it lets the CDN
// hand an agent the HTML variant or a browser the Markdown one, whichever
// landed in the cache first.
//
// FAIL-SAFE DESIGN: on ANY error the response degrades to the exact baked
// page bytes (renderOfficePage(template, ...) — byte-identical to the
// committed docs/o/<CODE>/index.html, enforced by tests/seo-pages.test.js),
// i.e. worst case is precisely today's behavior. The template ships with the
// function via `functions.*.includeFiles` in vercel.json.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICE_NAMES, OFFICE_TIMEZONES, SECTION_NAMES } from '../docs/js/offices.js';
import { isTabularSection } from '../docs/js/tabular.js';
import { isUntranslatable } from '../docs/js/untranslatable.js';
import { renderOfficePage, escHtml, officeTitle } from '../scripts/build-offices.mjs';
import { ASSET_PLACEHOLDERS } from '../scripts/app-shell.mjs';
import { fetchAFDList, fetchAFDProduct, productUrlFromItem } from './_utils.js';
import { regexTranslate } from './_afd-sections.js';
import { renderEditionMarkdown } from './_edition-markdown.js';
import {
    sendNegotiated, send406, selectRepresentation, acceptHeader, HTML, MARKDOWN,
} from './_negotiate.js';
import { sendError } from './_errors.js';
import { buildBoot, cacheControlFor, fetchBootExtras, insertBoot, SHORT_CACHE } from './_boot.js';
import { AI_FOR_AGENTS, STORE_RENDER, officeTag, readRenderableEdition, switchOn } from './_store.js';
import { CACHE_TAG_HEADER, tagResponse } from './_shared-cache.js';
import { displaySections, sectionHeadings, translatableSections } from './_translatable.js';
import { aiParagraphs } from './_ai-text.js';
// ChST / SST where Intl prints "GMT+10" / "GMT-11" (Guam, American Samoa).
import { formatInZone } from '../shadcn/src/lib/format.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FULL_CACHE = 'public, s-maxage=900, stale-while-revalidate=3600';
// A page rendered from the edition store (PLAINCAST_STORE_RENDER=1).
// STALENESS INVARIANT: the store renders an edition only while the poller's
// heartbeat is at most HEARTBEAT_FRESH_MS (api/_store.js, 10 min) old, and a
// copy rendered at the end of that window may then sit in the CDN for this
// s-maxage. Window + s-maxage must stay within FULL_CACHE's 15 minutes, the
// bound the live path has today (tests/engine-config.test.js pins it).
export const STORE_CACHE = 'public, s-maxage=300, stale-while-revalidate=3600';
// The CDN cache tag header (comma-separated tags).
export { CACHE_TAG_HEADER };

// The app uses boot data only for the latest edition of the reading view
// (src/App.jsx): a ?edition= permalink or the ?view=changelog ledger loads
// its own data, so those URLs skip the shared-store reads and the block.
export function wantsBoot(chosen, query) {
    if (chosen !== HTML) return false;
    if (query?.edition) return false;
    if (query?.view === 'changelog') return false;
    return true;
}

// Exact skeleton markup in the baked page that the SSR content replaces.
// If the template drifts and this marker disappears, we throw → baked page.
const LOADING_DIV = '<div class="loading" id="loading">Setting the type…</div>';

// Narrative AFD sections worth server-rendering, in no particular order —
// document order is preserved; we take the first MAX_SECTIONS matches.
const NARRATIVE_KEYS = new Set([
    'SYNOPSIS', 'KEY MESSAGES', 'WHAT HAS CHANGED', 'UPDATE', 'DISCUSSION',
    'SHORT TERM', 'NEAR TERM', 'LONG TERM', 'EXTENDED',
]);
const MAX_SECTIONS = 4;
const MAX_PARAS_PER_SECTION = 6;

// RSS permalinks are /o/<CODE>/?edition=<id>. When a crawler unfurls one, the
// share meta must point at that pinned issuance's OG card, not just the latest.
// Same UUID-ish id contract as api/og.js (?id=) and api/translate-issuance.js;
// validated strictly before it is echoed into HTML (never trust query input).
const EDITION_RE = /^[\w.:-]+$/;
const EDITION_MAX = 64;

export function validEdition(raw) {
    const e = String(raw || '');
    return e && e.length <= EDITION_MAX && EDITION_RE.test(e) ? e : null;
}

// Rewrite the baked page's share meta to a pinned-edition OG card. The baked
// page already carries per-office og:image=/api/og?office=<CODE> (twice: og +
// twitter) and og:url=/o/<CODE>/. og:url gains the ?edition= permalink, but
// canonical intentionally stays /o/<CODE>/ (SEO dedup).
export function pinEditionMeta(html, code, edition) {
    return html
        .split(`content="https://plaincast.live/api/og?office=${code}"`)
        .join(`content="https://plaincast.live/api/og?office=${code}&amp;id=${edition}"`)
        .replace(
            `<meta property="og:url" content="https://plaincast.live/o/${code}/">`,
            `<meta property="og:url" content="https://plaincast.live/o/${code}/?edition=${edition}">`
        );
}

// Lazy template load (never at module scope: a boot-time throw would take
// down the baked fallback too).
//
// api/_home-shell.html FIRST and docs/index.html only as a local fallback:
// docs/index.html is in .vercelignore (it would otherwise shadow the `/`
// rewrite), and an ignored file is absent from the function bundle too — so on
// Vercel only the api/ copy exists. The two are byte-identical, generated and
// pinned by scripts/build-offices.mjs + tests/seo-pages.test.js.
let templateCache = null;
export function loadTemplate() {
    if (templateCache) return templateCache;
    const candidates = [
        join(__dirname, '_home-shell.html'),              // repo + nft bundle layout
        join(process.cwd(), 'api', '_home-shell.html'),   // /var/task/api (includeFiles)
        join(__dirname, '..', 'docs', 'index.html'),      // local dev / tests
        join(process.cwd(), 'docs', 'index.html'),
    ];
    let lastErr = null;
    for (const p of candidates) {
        let html;
        try {
            html = readFileSync(p, 'utf8');
        } catch (err) { lastErr = err; continue; }
        templateCache = html;
        const problem = unrewrittenShellError(html);
        if (problem) console.error(problem);
        return templateCache;
    }
    throw lastErr || new Error('office-page: homepage shell not found');
}

// Deploy self-check (hashed assets). The committed shell names placeholder
// assets (/assets/app.js, …) that a hashed build does not contain;
// scripts/prepare-deploy.mjs rewrites them to the build's files in the Vercel
// build checkout, which is only correct if the functions are bundled AFTER the
// buildCommand. If this bundle got the un-rewritten file instead, every `/` and
// /o/<CODE>/ page loads a script and stylesheet that 404. Say so once per
// instance (the template is cached), plainly; never guess file names. Off
// Vercel (tests, local) the placeholders are expected, so it stays quiet.
export function unrewrittenShellError(html, env = process.env) {
    if (!env.VERCEL || typeof html !== 'string') return null;
    const left = ASSET_PLACEHOLDERS.filter(p => html.includes(`"${p}"`));
    if (!left.length) return null;
    return `office-page: api/_home-shell.html in this function bundle still names the un-hashed placeholder asset(s) ${left.join(', ')}, which do not exist in a hashed build: scripts/prepare-deploy.mjs's rewrite did not reach the function bundle, so / and /o/<CODE>/ load no app. Revert the hashed-assets commit (CLAUDE.md, Release rule).`;
}

function titleCase(key) {
    return String(key).toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
}

// Last-resort HTML when the shell cannot be loaded at all: the office's
// Markdown representation in a real document, with its canonical and a real
// H1 inside <main> (the heading rule), so the URL still says what it is.
export function minimalOfficeHtml(code, city, markdown) {
    const canonical = `https://plaincast.live/o/${code}/`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escHtml(officeTitle(city))}</title>
    <link rel="canonical" href="${canonical}">
    <link rel="alternate" type="text/markdown" href="${canonical}">
    <link rel="stylesheet" href="/styles.css">
</head>
<body>
<main>
<h1>${escHtml(city)} (${escHtml(code)}) — the National Weather Service forecast in plain English</h1>
<pre>${escHtml(markdown)}</pre>
</main>
</body>
</html>
`;
}

// Pick the top narrative sections (document order). Falls back to any
// substantial section when an office's format has no recognized narrative key.
// Never a table (docs/js/tabular.js): it is not narrative, its rows would be
// joined into one line of numbers, and it has no AI translation to show, so
// a stored one from before tables were excluded can never surface here.
export function pickSections(sections) {
    const prose = sections.filter(s => !isTabularSection(s.key, s.text));
    const narrative = prose.filter(s => NARRATIVE_KEYS.has(s.key));
    const pool = narrative.length > 0
        ? narrative
        : prose.filter(s => String(s.text || '').replace(/\s+/g, ' ').trim().length >= 200);
    const seen = new Set();
    const out = [];
    for (const s of pool) {
        if (seen.has(s.key)) continue;
        seen.add(s.key);
        out.push(s);
        if (out.length === MAX_SECTIONS) break;
    }
    return out;
}

// Section text → clean prose paragraphs. Mirrors the proven cleanup in
// _afd-sections.js sectionProse (bullet markers, issuance-timestamp
// remnants), but keeps paragraph boundaries instead of flattening to a lede.
export function sectionParagraphs(text) {
    return String(text || '')
        .split(/\n\s*\n+/)
        .map(p => p
            .split('\n')
            .map(line => line.replace(/^\s*(?:\d+[\).]\s+|[-*]\s+)/, ''))
            .join(' '))
        .map(p => p
            .replace(/^\s*(?:\d{1,2}\/\d{3,4}\s*(?:AM|PM|Z)?\.?\s*)+/i, '')
            .replace(/^\s*As of [^.\n]*\.{2,3}\s*/i, '')
            .replace(/^\s*Issued at [^.\n]*\d{4}\s*/i, '')
            .replace(/\s+/g, ' ')
            .trim())
        .filter(p => p.length >= 40)
        .slice(0, MAX_PARAS_PER_SECTION);
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

// The decoded edition both representations render from: the picked narrative
// sections, cleaned into paragraphs. Shape: [{ key, paras: [string] }].
// One source of truth, so the HTML page and its Markdown twin can never
// disagree about which sections an edition contains.
// `name` is the section's heading: distinct within the product (a NEAR TERM
// beside a SHORT TERM is "Near Term", as in the app; _translatable.js).
export function editionSections(productText) {
    const all = displaySections(productText);
    const headings = sectionHeadings(all);
    const out = [];
    for (const s of pickSections(all.map((x, i) => ({ ...x, name: headings[i] })))) {
        const paras = sectionParagraphs(s.text);
        if (paras.length === 0) continue;
        out.push({ key: s.key, name: s.name, paras });
    }
    return out;
}

// The decoded sections with their AI text attached (the Markdown twin's
// input when PLAINCAST_AI_FOR_AGENTS=1 shows it); unchanged without `ai`.
export function withAi(sections, ai) {
    if (!ai) return sections;
    return sections.map(s => (ai.get(s.key) ? { ...s, ai: ai.get(s.key) } : s));
}

// Assemble the server-rendered #sections content: dateline (the issuance
// time as <time datetime>), optional deterministic changelog line (no AI),
// one <article> per narrative section, and a closing line pointing at the
// interactive experience.
//
// `opts.ai` exists only with PLAINCAST_AI_FOR_AGENTS=1 (absent, the output is
// the switch-off page): Map(raw section key → stored translation) when a
// COMPLETE set for this exact edition covers every rendered section that can
// carry one (aiForSections). Each such section then leads with the AI text,
// labelled as an AI summary, and keeps the NWS text in a closed <details>
// labelled as the original.
export function buildSsrHtml(code, city, productText, issuanceTime, changelogHtml, opts = null) {
    const ai = opts?.ai || null;
    const articles = [];
    for (const s of editionSections(productText)) {
        const name = s.name || SECTION_NAMES[s.key] || titleCase(s.key);
        const nws = s.paras.map(p => `            <p>${escHtml(regexTranslate(p))}</p>`).join('\n');
        const aiText = ai ? ai.get(s.key) : null;
        if (aiText) {
            articles.push(
                `        <article class="forecast-section ssr">\n` +
                `            <h2 class="section-title">${escHtml(name)}</h2>\n` +
                `${aiSectionBody(aiText, s.paras)}\n` +
                `        </article>`
            );
            continue;
        }
        articles.push(
            `        <article class="forecast-section ssr">\n` +
            `            <h2 class="section-title">${escHtml(name)}</h2>\n` +
            `${nws}\n` +
            `        </article>`
        );
    }
    if (articles.length === 0) throw new Error('office-page: no renderable sections');

    const tz = OFFICE_TIMEZONES[code] || 'America/Los_Angeles';
    const issued = formatIssued(issuanceTime, tz);
    const metaLine = issued
        ? `        <p class="ssr-meta">Area Forecast Discussion · National Weather Service ${escHtml(city)} (${escHtml(code)}) · issued ${issuedHtml(issued, issuanceTime)}.</p>\n`
        : `        <p class="ssr-meta">Area Forecast Discussion · National Weather Service ${escHtml(city)} (${escHtml(code)}).</p>\n`;

    // No link to "the interactive edition": it is this URL (the legacy
    // /?office=<CODE> form now 308s back here), and it loads over this text
    // whenever JavaScript runs.
    const note = ai
        ? `        <p class="ssr-note">Each section above opens with a plain-English summary written by AI (Claude) from the ` +
          `National Weather Service's text, which follows it as the original; a section only a sentence or two long ` +
          `has no summary. The full Plaincast experience — the ` +
          `annotated original, with the <a href="/o/${escHtml(code)}/?view=changelog">forecast changelog</a> — loads ` +
          `automatically with JavaScript.</p>`
        : `        <p class="ssr-note">This is the plain-text edition, decoded without AI so it loads anywhere. ` +
          `The full Plaincast experience — plain-English summaries beside the annotated original, with the ` +
          `<a href="/o/${escHtml(code)}/?view=changelog">forecast changelog</a> — loads automatically with JavaScript.</p>`;

    return `\n${metaLine}${changelogHtml || ''}${articles.join('\n')}\n${note}\n    `;
}

// "issued <date>", with the instant as machine-readable data (the NWS
// issuanceTime, ISO 8601) whenever it parses.
export function issuedHtml(issued, issuanceTime) {
    const iso = isoInstant(issuanceTime);
    return iso ? `<time datetime="${escHtml(iso)}">${escHtml(issued)}</time>` : escHtml(issued);
}

function isoInstant(t) {
    if (typeof t !== 'string' || !Number.isFinite(Date.parse(t))) return null;
    return t;
}

// The label every AI summary carries in the HTML, and the one on the NWS
// original that follows it. Shared with api/home.js.
export const AI_LABEL_HTML = 'Plain-English summary written by AI (Claude) from the National Weather Service text below.';
export const NWS_ORIGINAL_HTML = 'The original: National Weather Service text, shorthand expanded';

// One section's body when the AI summary is shown: the label, the summary
// (the app's own Plain English formatting), then the NWS text, closed.
export function aiSectionBody(aiText, paras) {
    const summary = aiParagraphs(aiText).map(p => `            <p>${p}</p>`).join('\n');
    const nws = paras.map(p => `                <p>${escHtml(regexTranslate(p))}</p>`).join('\n');
    return `            <p class="ssr-ai-label"><small>${AI_LABEL_HTML}</small></p>\n` +
        `${summary}\n` +
        `            <details class="ssr-original">\n` +
        `                <summary>${NWS_ORIGINAL_HTML}</summary>\n` +
        `${nws}\n` +
        `            </details>`;
}

// The stored translation for each server-rendered section, or null when the
// AI text cannot be shown. Shown only for a COMPLETE set whose value names
// exactly this office, edition and product text, and in which every one of
// the first `limit` rendered sections that the shared rule translates
// (docs/js/untranslatable.js) has exactly one translatable counterpart (same
// display key, same source text) with a non-empty translation. A section the
// rule never translates (a short "What has changed" note) is rendered as the
// NWS text and does not hold the rest back. Any doubt → null → the page
// renders as with the switch off.
export function aiForSections(productText, entry, office, id, limit = Infinity) {
    if (!entry || typeof entry !== 'object' || entry.office !== office || entry.id !== id || entry.complete !== true) return null;
    if (typeof entry.productText !== 'string' || entry.productText !== productText) return null;
    const map = entry.sections;
    if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
    const translatable = translatableSections(productText);
    const out = new Map();
    let rendered = 0;
    for (const s of pickSections(displaySections(productText))) {
        if (rendered >= limit) break;
        if (sectionParagraphs(s.text).length === 0) continue; // as editionSections
        rendered++;
        if (isUntranslatable(s.key, s.text)) continue;
        const d = s.display;
        const twins = translatable.filter(t => t.key === d);
        if (twins.length !== 1 || twins[0].text !== s.text) return null;
        const text = map[d];
        if (typeof text !== 'string' || !text.trim() || aiParagraphs(text).length === 0) return null;
        out.set(s.key, text);
    }
    return out.size ? out : null;
}

// dateModified (the issuance instant) in the page's WebPage JSON-LD, the
// block whose @id is `pageId`: https://plaincast.live/o/<CODE>/ on an office
// page (scripts/build-offices.mjs officeJsonLd), https://plaincast.live/ on
// the homepage (shadcn/index.html). No such block, or no parseable time: the
// page is returned unchanged.
export const HOME_PAGE_ID = 'https://plaincast.live/';
export const officePageId = (code) => `https://plaincast.live/o/${code}/`;

export function withDateModified(html, pageId, issuanceTime) {
    const iso = isoInstant(issuanceTime);
    if (!iso) return html;
    const anchor = `"@id": ${JSON.stringify(pageId)},`;
    const at = html.indexOf(anchor);
    if (at < 0) return html;
    const lineStart = html.lastIndexOf('\n', at) + 1;
    const indent = html.slice(lineStart, at);
    const value = JSON.stringify(iso).replace(/</g, '\\u003c');
    return html.slice(0, at + anchor.length) + `\n${indent}"dateModified": ${value},` + html.slice(at + anchor.length);
}

// Both representations of the "what changed" line, or neither. Kept as one
// object so a caller can never render the HTML twin and forget the Markdown one.
const EMPTY_CHANGELOG = Object.freeze({ html: '', markdown: '' });

// Deterministic "what changed" one-liner — reuses changedParagraphs from
// api/changelog.js (dynamically imported so its `ai` dependency can never
// break the baked fallback) but NEVER calls the AI summarizer.
async function deterministicChangelog(code, items, currText) {
    try {
        if (!Array.isArray(items) || items.length < 2) return EMPTY_CHANGELOG;
        const prevUrl = productUrlFromItem(items[1]);
        if (!prevUrl) return EMPTY_CHANGELOG;
        const prev = await fetchAFDProduct(prevUrl, { signal: AbortSignal.timeout(5000) });
        return await changelogLines(code, prev, currText);
    } catch (err) {
        console.warn('office-page: changelog line skipped:', err?.message || err);
        return EMPTY_CHANGELOG;
    }
}

// The same line from an edition already in hand (the store's predecessor).
export async function changelogFromPrevious(code, prev, currText) {
    try {
        return await changelogLines(code, prev, currText);
    } catch (err) {
        console.warn('office-page: changelog line skipped:', err?.message || err);
        return EMPTY_CHANGELOG;
    }
}

async function changelogLines(code, prev, currText) {
    const prevText = typeof prev?.productText === 'string' ? prev.productText : '';
    if (!prevText) return EMPTY_CHANGELOG;
    const { changedParagraphs } = await import('./changelog.js');
    const n = changedParagraphs(prevText, currText).length;
    if (n === 0) return EMPTY_CHANGELOG;
    const tz = OFFICE_TIMEZONES[code] || 'America/Los_Angeles';
    let since = '';
    try {
        const d = new Date(prev?.issuanceTime);
        if (!Number.isNaN(d.getTime())) {
            since = d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
        }
    } catch { /* omit time */ }
    const passages = n === 1 ? 'passage' : 'passages';
    const sinceTxt = since ? ` since the ${since} discussion` : ' since the previous discussion';
    return {
        html: `        <p class="ssr-changelog">Revised in ${n} ${passages}${escHtml(sinceTxt)}. ` +
            `<a href="/o/${escHtml(code)}/?view=changelog">See every revision</a>.</p>\n`,
        markdown: `Revised in ${n} ${passages}${sinceTxt}. ` +
            `[See every revision](https://plaincast.live/o/${code}/?view=changelog).`,
    };
}

// The edition a page renders, from the store (PLAINCAST_STORE_RENDER=1, and
// only when api/_store.js says it may) or live from api.weather.gov:
// { product: { id, issuanceTime, productText }, changelog, extrasPending,
//   fromStore }. `wantExtras` starts the shared-store reads for the edition's
// AI translation and changelog sentence as soon as its id is known. The live
// path throws on any NWS problem (→ the caller's baked fallback).
export async function storeEdition(code, wantExtras) {
    const stored = await readRenderableEdition(code);
    if (!stored) return null;
    const { current } = stored;
    const extrasPending = wantExtras ? fetchBootExtras(code, current.id) : null;
    const changelog = stored.previous ? await changelogFromPrevious(code, stored.previous, current.productText) : EMPTY_CHANGELOG;
    return { product: current, changelog, extrasPending, fromStore: true };
}

export async function liveEdition(code, wantExtras) {
    const items = await fetchAFDList(code, { signal: AbortSignal.timeout(8000) });
    const prodUrl = productUrlFromItem(items[0]);
    if (!prodUrl) throw new Error('no AFD product listed');
    // Boot extras (AI translations + changelog sentence, read from the
    // shared store the AI endpoints write) start now, in parallel with
    // the product and changelog fetches; awaited last, they add at most
    // the store's short read timeout.
    const latestId = items[0]?.id || null;
    const extrasPending = wantExtras && latestId ? fetchBootExtras(code, latestId) : null;
    const prod = await fetchAFDProduct(prodUrl, { signal: AbortSignal.timeout(8000) });
    const text = typeof prod?.productText === 'string' ? prod.productText : '';
    if (!text) throw new Error('empty AFD product');
    const changelog = await deterministicChangelog(code, items, text);
    return {
        product: { id: prod?.id || latestId, issuanceTime: prod?.issuanceTime, productText: text },
        changelog, extrasPending, fromStore: false,
    };
}

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendError(res, 405, 'method_not_allowed', 'GET only', { allow: ['GET', 'HEAD'] });
    }

    // Decide the representation BEFORE any network work: an Accept header
    // nothing here can satisfy should cost nothing upstream.
    const accept = acceptHeader(req);
    const chosen = selectRepresentation(accept, [HTML, MARKDOWN]);
    if (!chosen) return send406(res, [HTML, MARKDOWN], accept);

    const code = String(req.query?.code || '').toUpperCase();
    const city = OFFICE_NAMES[code];
    if (!city) {
        // Unknown office → still a 404, but with the site map body an agent can
        // recover from instead of the two words it used to get.
        const { default: notFound } = await import('./not-found.js');
        return notFound(req, res);
    }

    // Baked page first: this is the guaranteed floor for every response path.
    let baked;
    try {
        baked = renderOfficePage(loadTemplate(), code, city);
    } catch (err) {
        // Template missing from the bundle — cannot reproduce the baked page.
        // Serve the office's Markdown twin as a plain document. NEVER a
        // redirect: this used to 307 to /?office=<CODE>, which vercel.json
        // now 308s straight back to /o/<CODE>/ — an endless loop on exactly
        // the failure this branch exists for (and api/home.js shares the
        // same shell, so a redirect anywhere else meets the same fate).
        console.error('office-page: template unavailable:', err);
        const canonical = officePageId(code);
        const markdown = renderEditionMarkdown({
            code, city, sections: [], issued: null, changelogNote: '', canonical, moreHref: canonical,
        });
        return sendNegotiated(req, res, {
            [HTML]: minimalOfficeHtml(code, city, markdown),
            [MARKDOWN]: markdown,
        }, { cacheControl: 'public, s-maxage=60' });
    }

    // Pinned-edition permalink (from RSS): point the share meta at that
    // issuance's OG card. Applied to `baked` so both the SSR and the fallback
    // response paths carry it. Invalid/absent edition → latest-edition meta.
    const edition = validEdition(req.query?.edition);
    if (edition) baked = pinEditionMeta(baked, code, edition);

    // Switches, read per request (api/_store.js). All off: the live path
    // below, byte for byte as before.
    const storeRender = switchOn(STORE_RENDER);
    const aiForAgents = switchOn(AI_FOR_AGENTS);
    // Every response that shows this office's edition carries its tag, so
    // the poller's purge reaches every cached copy, live or stored.
    if (storeRender) await tagResponse(res, officeTag(code));

    try {
        const boot = wantsBoot(chosen, req.query);
        const wantExtras = boot || aiForAgents;
        const src = (storeRender ? await storeEdition(code, wantExtras) : null) || await liveEdition(code, wantExtras);
        const { product, changelog, extrasPending } = src;
        const text = product.productText;
        const extras = extrasPending ? await extrasPending : null;
        const ai = aiForAgents ? aiForSections(text, extras?.translation, code, product.id) : null;
        const ssr = buildSsrHtml(code, city, text, product.issuanceTime, changelog.html,
            aiForAgents ? { ai } : null);
        if (!baked.includes(LOADING_DIV)) throw new Error('skeleton marker missing from template');

        const canonical = `https://plaincast.live/o/${code}/`;
        const markdown = renderEditionMarkdown({
            code, city,
            sections: withAi(editionSections(text), ai),
            issued: formatIssued(product.issuanceTime, OFFICE_TIMEZONES[code] || 'America/Los_Angeles'),
            changelogNote: changelog.markdown,
            canonical,
            moreHref: canonical,
            ...(aiForAgents ? { aiIncluded: Boolean(ai), issuedIso: product.issuanceTime } : {}),
        });

        // replacer fn: `$`-sequences in forecast text must not be interpreted
        let html = withDateModified(baked.replace(LOADING_DIV, () => ssr), officePageId(code), product.issuanceTime);
        const fullCache = src.fromStore ? STORE_CACHE : FULL_CACHE;
        let cacheControl = fullCache;
        if (boot && extrasPending) {
            const bootData = buildBoot({
                office: code,
                product: { id: product.id, issuanceTime: product.issuanceTime, productText: text },
                extras,
            });
            html = insertBoot(html, bootData);
            cacheControl = cacheControlFor(bootData, fullCache);
        }
        // With the AI switch on, a page still waiting for its translation is
        // regenerated soon, in both representations, so the AI text lands.
        if (aiForAgents && !ai) cacheControl = SHORT_CACHE;
        return sendNegotiated(req, res, {
            [HTML]: html,
            [MARKDOWN]: markdown,
        }, { cacheControl });
    } catch (err) {
        // NWS down, format drift, marker drift, anything: exact baked page,
        // shorter CDN window so recovery is quick. Markdown degrades to the
        // page's own description — an agent still learns what this URL is.
        console.warn('office-page: serving baked fallback:', err?.message || err);
        return sendNegotiated(req, res, {
            [HTML]: baked,
            [MARKDOWN]: renderEditionMarkdown({
                code, city, sections: [], issued: null, changelogNote: '',
                canonical: `https://plaincast.live/o/${code}/`,
                moreHref: `https://plaincast.live/o/${code}/`,
            }),
        }, { cacheControl: 'public, s-maxage=300' });
    }
}
