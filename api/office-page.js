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
// FAIL-SAFE DESIGN: on ANY error the response degrades to the exact baked
// page bytes (renderOfficePage(template, ...) — byte-identical to the
// committed docs/o/<CODE>/index.html, enforced by tests/seo-pages.test.js),
// i.e. worst case is precisely today's behavior. The template ships with the
// function via `functions.*.includeFiles` in vercel.json.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICE_NAMES, OFFICE_TIMEZONES, SECTION_NAMES } from '../docs/js/offices.js';
import { renderOfficePage, escHtml } from '../scripts/build-offices.mjs';
import { fetchAFDList, fetchAFDProduct, productUrlFromItem } from './_utils.js';
import { extractSections, regexTranslate } from './_afd-sections.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// Lazy template load (never at module scope: a boot-time throw would take
// down the baked fallback too). Tries the bundled layout first, then cwd.
let templateCache = null;
export function loadTemplate() {
    if (templateCache) return templateCache;
    const candidates = [
        join(__dirname, '..', 'docs', 'index.html'), // repo + nft bundle layout
        join(process.cwd(), 'docs', 'index.html'),   // /var/task/docs (includeFiles)
    ];
    let lastErr = null;
    for (const p of candidates) {
        try {
            templateCache = readFileSync(p, 'utf8');
            return templateCache;
        } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error('office-page: docs/index.html not found');
}

function titleCase(key) {
    return String(key).toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
}

// Pick the top narrative sections (document order). Falls back to any
// substantial section when an office's format has no recognized narrative key.
export function pickSections(sections) {
    const narrative = sections.filter(s => NARRATIVE_KEYS.has(s.key));
    const pool = narrative.length > 0
        ? narrative
        : sections.filter(s => String(s.text || '').replace(/\s+/g, ' ').trim().length >= 200);
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
        return d.toLocaleString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric',
            hour: 'numeric', minute: '2-digit',
            timeZone: tz, timeZoneName: 'short',
        });
    } catch { return null; }
}

// Assemble the server-rendered #sections content: dateline, optional
// deterministic changelog line (no AI), one <article> per narrative section,
// and a closing line pointing at the interactive experience.
export function buildSsrHtml(code, city, productText, issuanceTime, changelogHtml) {
    const picked = pickSections(extractSections(productText));
    const articles = [];
    for (const s of picked) {
        const paras = sectionParagraphs(s.text);
        if (paras.length === 0) continue;
        const name = SECTION_NAMES[s.key] || titleCase(s.key);
        const body = paras.map(p => `            <p>${escHtml(regexTranslate(p))}</p>`).join('\n');
        articles.push(
            `        <article class="forecast-section ssr">\n` +
            `            <h2 class="section-title">${escHtml(name)}</h2>\n` +
            `${body}\n` +
            `        </article>`
        );
    }
    if (articles.length === 0) throw new Error('office-page: no renderable sections');

    const tz = OFFICE_TIMEZONES[code] || 'America/Los_Angeles';
    const issued = formatIssued(issuanceTime, tz);
    const metaLine = issued
        ? `        <p class="ssr-meta">Area Forecast Discussion · National Weather Service ${escHtml(city)} (${escHtml(code)}) · issued ${escHtml(issued)}.</p>\n`
        : `        <p class="ssr-meta">Area Forecast Discussion · National Weather Service ${escHtml(city)} (${escHtml(code)}).</p>\n`;

    const note =
        `        <p class="ssr-note">This is the plain-text edition, decoded without AI so it loads anywhere. ` +
        `The full Plaincast experience — plain-English summaries beside the annotated original, with the ` +
        `<a href="/o/${escHtml(code)}/?view=changelog">forecast changelog</a> — loads automatically with JavaScript, ` +
        `or <a href="/?office=${escHtml(code)}">open the interactive edition</a>.</p>`;

    return `\n${metaLine}${changelogHtml || ''}${articles.join('\n')}\n${note}\n    `;
}

// Deterministic "what changed" one-liner — reuses changedParagraphs from
// api/changelog.js (dynamically imported so its `ai` dependency can never
// break the baked fallback) but NEVER calls the AI summarizer.
async function deterministicChangelog(code, items, currText) {
    try {
        if (!Array.isArray(items) || items.length < 2) return '';
        const prevUrl = productUrlFromItem(items[1]);
        if (!prevUrl) return '';
        const prev = await fetchAFDProduct(prevUrl, { signal: AbortSignal.timeout(5000) });
        const prevText = typeof prev?.productText === 'string' ? prev.productText : '';
        if (!prevText) return '';
        const { changedParagraphs } = await import('./changelog.js');
        const n = changedParagraphs(prevText, currText).length;
        if (n === 0) return '';
        const tz = OFFICE_TIMEZONES[code] || 'America/Los_Angeles';
        let since = '';
        try {
            const d = new Date(prev?.issuanceTime);
            if (!Number.isNaN(d.getTime())) {
                since = d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
            }
        } catch { /* omit time */ }
        const passages = n === 1 ? 'passage' : 'passages';
        const sinceTxt = since ? ` since the ${escHtml(since)} discussion` : ' since the previous discussion';
        return `        <p class="ssr-changelog">Revised in ${n} ${passages}${sinceTxt}. ` +
            `<a href="/o/${escHtml(code)}/?view=changelog">See every revision</a>.</p>\n`;
    } catch (err) {
        console.warn('office-page: changelog line skipped:', err?.message || err);
        return '';
    }
}

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(405).json({ error: 'GET only' });
    }

    const code = String(req.query?.code || '').toUpperCase();
    const city = OFFICE_NAMES[code];
    if (!city) {
        // Unknown office → same outcome as the static filesystem today: 404.
        res.setHeader('Cache-Control', 'public, s-maxage=3600');
        return res.status(404).send('Not found');
    }

    // Baked page first: this is the guaranteed floor for every response path.
    let baked;
    try {
        baked = renderOfficePage(loadTemplate(), code, city);
    } catch (err) {
        // Template missing from the bundle — cannot reproduce the baked page.
        // Degrade to a redirect into the interactive app rather than an error.
        console.error('office-page: template unavailable:', err);
        res.setHeader('Cache-Control', 'public, s-maxage=60');
        res.setHeader('Location', `/?office=${code}`);
        return res.status(307).send('');
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    try {
        const items = await fetchAFDList(code, { signal: AbortSignal.timeout(8000) });
        const prodUrl = productUrlFromItem(items[0]);
        if (!prodUrl) throw new Error('no AFD product listed');
        const prod = await fetchAFDProduct(prodUrl, { signal: AbortSignal.timeout(8000) });
        const text = typeof prod?.productText === 'string' ? prod.productText : '';
        if (!text) throw new Error('empty AFD product');

        const changelogHtml = await deterministicChangelog(code, items, text);
        const ssr = buildSsrHtml(code, city, text, prod?.issuanceTime, changelogHtml);
        if (!baked.includes(LOADING_DIV)) throw new Error('skeleton marker missing from template');

        res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
        // replacer fn: `$`-sequences in forecast text must not be interpreted
        return res.status(200).send(baked.replace(LOADING_DIV, () => ssr));
    } catch (err) {
        // NWS down, format drift, marker drift, anything: exact baked page,
        // shorter CDN window so recovery is quick.
        console.warn('office-page: serving baked fallback:', err?.message || err);
        res.setHeader('Cache-Control', 'public, s-maxage=300');
        return res.status(200).send(baked);
    }
}
