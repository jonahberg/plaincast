// Vercel serverless function: server-rendered national front page at /national/.
//
// WHY THIS EXISTS: The National Desk is the one Plaincast page whose whole
// point is "where is the weather today" — and every input (api.weather.gov's
// active-alert feed, the SPC Day 1 Convective Outlook) sits behind a
// robots.txt that disallows crawlers. Rendered client-side it would be a
// blank page to Googlebot and to anyone without JS. This function ships the
// baked shell with a deterministic lede, the severe wire, and the alert
// census typeset into it — no AI, no client JS required.
//
// NO AI HERE, DELIBERATELY: the lede is the SPC's own SUMMARY paragraph run
// through regexTranslate (abbreviation expansion only). The AI-written deck
// arrives later, client-side, and swaps #desk-deck — which is why the SSR
// lede must render that id even though this file never calls a model.
//
// ROUTING: /national and /national/ rewrite here (vercel.json). Rewrites are
// evaluated AFTER `handle: filesystem`, so a static docs/national/index.html
// would shadow this function — that is exactly why the shell lives at
// api/_national-shell.html instead (underscore-prefixed, so Vercel does not
// treat it as an endpoint) and reaches the function via includeFiles.
//
// FAIL-SAFE DESIGN: on ANY error the response is the exact baked shell bytes
// (status 200, short CDN window). The shell is a complete page on its own —
// masthead, colophon, and a typeset index of all 68 local editions — so the
// worst case is a good page, never an error.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICE_NAMES } from '../docs/js/offices.js';
import { escHtml } from '../scripts/build-offices.mjs';
import { fetchSevereAlerts, fetchAlertTotals, fetchSpcDy1 } from './_utils.js';
import { regexTranslate } from './_afd-sections.js';
import { groupDispatches, buildCensus, parseSpcOutlook } from './_national.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Exact skeleton markup in the baked shell that the SSR content replaces.
// If the shell drifts and this marker disappears, we throw → baked shell.
const MARKER = '<div class="loading" id="desk-loading">Setting the type…</div>';

// The wire is a front page, not a database dump: twelve offices is as long as
// the column reads before it stops being scannable. The rest become a count.
const WIRE_MAX = 12;

// Upstream budget. Three independent fetches run in parallel, each with its
// own fresh signal (an AbortSignal is single-use — sharing one would abort
// all three the moment the first timer fired).
const FETCH_TIMEOUT_MS = 8000;

// Lazy shell load (never at module scope: a boot-time throw would take down
// the fail-safe path too).
let templateCache = null;
export function loadTemplate() {
    if (templateCache) return templateCache;
    // Probe order matters — this is the repo's first api/-side single-file
    // includeFiles use, so neither candidate is proven by an existing
    // function. __dirname first: it is correct both in the repo checkout and
    // in the nft-traced bundle, which keeps _national-shell.html beside this
    // module. The cwd candidate covers the /var/task layout Vercel
    // materializes from functions["api/national-desk.js"].includeFiles, whose
    // paths are rooted at the project, not at the function directory.
    const candidates = [
        join(__dirname, '_national-shell.html'),             // repo + nft bundle layout
        join(process.cwd(), 'api', '_national-shell.html'),  // /var/task/api (includeFiles)
    ];
    let lastErr = null;
    for (const p of candidates) {
        try {
            templateCache = readFileSync(p, 'utf8');
            return templateCache;
        } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error('national-desk: api/_national-shell.html not found');
}

// SPC headlines shout ("THERE IS A SLIGHT RISK OF..."). The kicker is
// small-caps in CSS, so the source text should read as a sentence.
function sentenceCaseHeadline(headline) {
    const s = String(headline).toLowerCase().trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// The outlook is national, so a local time zone would be a lie. SPC's own
// convention is HHMM UTC ("1942 UTC"). Returns null — not a broken string —
// for a missing or unparseable timestamp, so the caller can omit the whole
// fragment (note: `new Date(null)` is the epoch, not Invalid Date).
function formatIssuedUtc(iso) {
    if (!iso) return null;
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return null;
        const hhmm = d.toLocaleString('en-US', {
            hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
        }).replace(':', '');
        return `${hhmm} UTC`;
    } catch { return null; }
}

// The lede: an SPC-derived kicker, the deterministic deck (#desk-deck, which
// the client later swaps for the AI edition), and the attribution line.
// Throws when there is no summary — the handler turns that into the baked
// shell, because a national front page with no national story is not a page.
export function buildLedeHtml({ headline, summary, issuanceTime }) {
    if (!summary) throw new Error('national-desk: no outlook summary');
    const kicker = headline ? sentenceCaseHeadline(headline) : 'The national outlook';
    const issuedAt = formatIssuedUtc(issuanceTime);
    const issued = issuedAt ? ` · issued ${escHtml(issuedAt)}` : '';
    return `<section class="desk-lede">
        <p class="desk-kicker">${escHtml(kicker)}</p>
        <p class="desk-deck" id="desk-deck">${escHtml(regexTranslate(summary))}</p>
        <p class="desk-attrib">From the Storm Prediction Center's Day 1 Convective Outlook${issued}.</p>
    </section>`;
}

// The Wire: one line per forecast office under an active severe warning,
// worst first (groupDispatches already sorted). Offices Plaincast covers link
// to their desk; the rest are named but unlinked — there is nowhere to send
// the reader, and a dead /o/<CODE>/ link would 404.
export function buildWireHtml(rows) {
    const all = rows || [];
    const shown = all.slice(0, WIRE_MAX);
    const items = shown.map(r => {
        const name = r.city
            ? `<a href="/o/${escHtml(r.code)}/">${escHtml(r.city)} (${escHtml(r.code)})</a>`
            : escHtml(r.code);
        const count = r.count > 1 ? ` ×${escHtml(r.count)}` : '';
        return `            <li class="wire-item${r.extreme ? ' wire-extreme' : ''}">` +
            `<span class="wire-office">${name}</span>` +
            `<span class="wire-event">${escHtml(r.event)}${count}</span></li>`;
    });
    const hidden = all.length - shown.length;
    const overflow = hidden === 1
        ? '…and 1 more office under a severe warning.'
        : `…and ${escHtml(hidden)} more offices under severe warnings.`;
    const more = hidden > 0
        ? `\n        <p class="wire-more">${overflow}</p>`
        : '';
    // An empty wire is news too — say so rather than printing a blank column.
    const body = items.length
        ? `        <ul class="wire-list">\n${items.join('\n')}\n        </ul>${more}`
        : '        <p class="wire-more">No office is under a severe warning right now — a quiet wire is good news.</p>';
    return `<section class="wire" aria-label="Offices under severe warnings">
        <h2 class="wire-label">The Wire · severe warnings by forecast office</h2>
${body}
    </section>`;
}

// The census: what the sky is doing, by event class. Cell markup mirrors
// ledgerCell() in docs/js/app.js exactly so the existing .ledger CSS applies
// (dl.ledger > div.ledger-cell > dt + dd). `totals` is soft data — the
// all-severities national count is omitted entirely when it is unavailable.
export function buildCensusHtml(census, totals) {
    const rows = census || [];
    if (rows.length === 0) return ''; // genuinely quiet: no orphan <dl>
    const cells = rows.map(c =>
        `            <div class="ledger-cell"><dt>${escHtml(c.event)}</dt><dd>${escHtml(c.count)}</dd></div>`);
    const totalLine = Number.isFinite(totals?.total)
        ? `\n        <p class="wire-more">${escHtml(totals.total)} active products nationwide, all severities.</p>`
        : '';
    return `<section class="census" aria-label="Active severe alert census">
        <dl class="ledger">
${cells.join('\n')}
        </dl>${totalLine}
    </section>`;
}

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(405).json({ error: 'GET only' });
    }

    // Baked shell first: this is the guaranteed floor for every response path.
    let baked;
    try {
        baked = loadTemplate();
    } catch (err) {
        // Shell missing from the bundle — there is nothing to serve. Unlike
        // the office pages there is no interactive /national view to redirect
        // into, so the homepage is the only sensible fallback: it is the same
        // forecast data, entered through the reader's local office.
        console.error('national-desk: shell unavailable:', err);
        res.setHeader('Cache-Control', 'public, s-maxage=60');
        res.setHeader('Location', '/');
        return res.status(307).send('');
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    try {
        // Independent upstreams, so run them together; fetchAlertTotals is
        // soft (resolves null rather than throwing) and cannot sink the page.
        const [features, totals, outlook] = await Promise.all([
            fetchSevereAlerts({ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
            fetchAlertTotals({ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
            fetchSpcDy1({ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
        ]);

        // fetchSpcDy1 can resolve null (no product listed) — buildLedeHtml
        // then throws on the missing summary and we serve the shell.
        const { headline, summary } = parseSpcOutlook(outlook?.productText);
        const ssr = [
            buildLedeHtml({ headline, summary, issuanceTime: outlook?.issuanceTime || null }),
            buildWireHtml(groupDispatches(features, OFFICE_NAMES)),
            buildCensusHtml(buildCensus(features), totals),
        ].filter(Boolean).join('\n\n    ');

        if (!baked.includes(MARKER)) throw new Error('skeleton marker missing from shell');

        res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
        // replacer fn: `$`-sequences in NWS/SPC text must not be interpreted
        return res.status(200).send(baked.replace(MARKER, () => ssr));
    } catch (err) {
        // NWS down, format drift, marker drift, anything: exact baked shell,
        // shorter CDN window so recovery is quick.
        console.warn('national-desk: serving baked shell:', err?.message || err);
        res.setHeader('Cache-Control', 'public, s-maxage=300');
        return res.status(200).send(baked);
    }
}
