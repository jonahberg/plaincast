// Vercel serverless function: server-rendered national front page at /national/.
//
// WHY THIS EXISTS: The National Desk is the one Plaincast page whose whole
// point is "where is the weather today" — and every input (api.weather.gov's
// active-alert feed, the SPC Convective Outlooks) sits behind a robots.txt
// that disallows crawlers. Rendered client-side it would be a blank page to
// Googlebot and to anyone without JS. This function ships the baked shell
// with the whole composed desk typeset into it — census strip, risk moment,
// standfirst, running copy, day rail, severe wire, outlook clock — with no
// AI and no client JS required.
//
// NO AI HERE, DELIBERATELY: the standfirst is the SPC's own SUMMARY paragraph
// run through regexTranslate (abbreviation expansion only), and the running
// copy is the SPC's own post-summary discussion. The AI-written deck arrives
// later, client-side, and swaps #desk-deck — which is why the SSR lede must
// render that id even though this file never calls a model, and why the
// de-dup fallback leaves the slot EMPTY rather than dropping it.
//
// ROUTING: /national and /national/ rewrite here (vercel.json). Rewrites are
// evaluated AFTER `handle: filesystem`, so a static docs/national/index.html
// would shadow this function — that is exactly why the shell lives at
// api/_national-shell.html instead (underscore-prefixed, so Vercel does not
// treat it as an endpoint) and reaches the function via includeFiles.
//
// FAIL-SAFE DESIGN: two upstreams are HARD (the severe alert feed and the
// Day 1 outlook) — either one failing means the exact baked shell bytes,
// status 200, short CDN window. Everything else is SOFT: national totals and
// the Day 2/Day 3 outlooks each degrade to their own cell's absence, never
// to a worse page. The shell is a complete page on its own — masthead,
// colophon, and a typeset index of all 68 local editions — so the worst case
// is a good page, never an error.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICE_NAMES, OFFICE_TIMEZONES } from '../docs/js/offices.js';
import { escHtml } from '../scripts/build-offices.mjs';
import { fetchSevereAlerts, fetchAlertTotals, fetchSpcOutlook } from './_utils.js';
import { regexTranslate } from './_afd-sections.js';
import {
    groupDispatches, buildCensus, parseSpcOutlook, parseRiskCategory,
    parseDiscussionBody, digestArea, formatExpiry, nextOutlookTime,
} from './_national.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Exact skeleton markup in the baked shell that the SSR content replaces.
// If the shell drifts and this marker disappears, we throw → baked shell.
const MARKER = '<div class="loading" id="desk-loading">Setting the type…</div>';

// The wire is a front page, not a database dump: twelve offices is as long as
// the column reads before it stops being scannable. The rest become a count.
const WIRE_MAX = 12;

// The strip is one row on a phone. Four event classes plus the national total
// and the quiet count is the most that fits before it wraps into a table.
const STRIP_MAX = 4;

// A rail note is a caption, not a sentence — SPC region prose runs long
// ("PORTIONS OF THE OHIO VALLEY AND PARTS OF THE CENTRAL HIGH PLAINS").
const RAIL_NOTE_MAX = 60;

// Said only when a product actually parsed and outlined nothing. A cell whose
// fetch FAILED gets a bare dash: silence is honest, "no risk" would be a
// claim about the sky we have no product to back.
const NO_RISK_NOTE = 'No organized severe risk outlined';

// Every covered desk. The quiet count's denominator and the census strip's
// arithmetic both derive from the roster, never from a baked 68.
const DESK_COUNT = Object.keys(OFFICE_NAMES).length;

// Upstream budget. Five independent fetches run in parallel, each with its
// own fresh signal (an AbortSignal is single-use — sharing one would abort
// all five the moment the first timer fired).
const FETCH_TIMEOUT_MS = 8000;
const sig = () => ({ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

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

// SPC products shout ("SLIGHT"). The display faces are cased in the source
// text, not by CSS, so the markup reads like the page reads.
function sentenceWord(s) {
    const t = String(s).toLowerCase().trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
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

// Clip on whole text, BEFORE escaping — clipping escaped markup could cut an
// entity in half and emit `&am`. Clips on the last word boundary in the back
// third so region prose ends on a word ("…THE SOUTHERN…"), not a fragment
// ("…SOUTHERN APPALA…"); a single unbroken token still clips hard.
function clipNote(s) {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    if (t.length <= RAIL_NOTE_MAX) return t;
    const cut = t.slice(0, RAIL_NOTE_MAX - 1);
    const space = cut.lastIndexOf(' ');
    return `${(space > RAIL_NOTE_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// The census index strip: the whole national picture in one rule-bounded row.
// Replaces v1's census ledger. `totals` is soft data — the all-severities
// national count is omitted entirely when it is unavailable — but the quiet
// count is arithmetic on data we already have, so it always prints.
export function buildStripHtml(census, totals, quiet) {
    const cells = [];
    if (Number.isFinite(totals?.total)) {
        cells.push(`<span><b>${escHtml(totals.total)}</b>&nbsp;active</span>`);
    }
    for (const c of (census || []).slice(0, STRIP_MAX)) {
        cells.push(`<span><b>${escHtml(c.count)}</b>&nbsp;${escHtml(c.event)}</span>`);
    }
    cells.push(`<span><b>${escHtml(quiet)}</b>/${escHtml(DESK_COUNT)} desks quiet</span>`);
    return `<section class="desk-strip" aria-label="National alert census">
        ${cells.join('\n        ')}
    </section>`;
}

// The risk moment: the Day-1 categorical word set as the page's hero, over a
// small line naming the risk type and the outlined regions.
//
// CALM FACE: no outlined risk is not an empty section — it is the day's
// actual news, so it gets a line of its own and no display word.
//
// The regions string arrives as SPC wrote it (SHOUTED, often with a leading
// article that reads wrong once the display is lowercased): strip the leading
// "THE " here, and let the stylesheet do the lowercasing.
export function buildRiskHtml(risk) {
    if (!risk?.level) {
        return `<section class="desk-risk">
        <p class="desk-risk-quiet">Quiet skies nationally</p>
    </section>`;
    }
    const regions = String(risk.regions ?? '').replace(/^THE\s+/i, '').replace(/\s+/g, ' ').trim();
    const tail = regions ? ` · ${escHtml(regions)}` : '';
    return `<section class="desk-risk">
        <p class="desk-risk-word">${escHtml(sentenceWord(risk.level))}</p>
        <p class="desk-risk-of">risk of severe thunderstorms${tail}</p>
    </section>`;
}

// The standfirst: the deterministic deck (#desk-deck, which the client later
// swaps for the AI edition) and the attribution line. Throws when there is no
// summary — the handler turns that into the baked shell, because a national
// front page with no national story is not a page.
//
// `deckSuppressed` is the de-dup fallback (spec §5): when no post-summary
// narrative parsed, the SUMMARY runs as the running copy instead, and this
// slot must not say the same thing a second time. The <p> still ships, empty,
// because /js/national.js swaps it by id — dropping it would break the AI
// deck for every reader on a no-discussion product.
export function buildLedeHtml({ summary, issuanceTime, deckSuppressed = false }) {
    if (!summary) throw new Error('national-desk: no outlook summary');
    const issuedAt = formatIssuedUtc(issuanceTime);
    const issued = issuedAt ? ` · issued ${escHtml(issuedAt)}` : '';
    const deck = deckSuppressed ? '' : escHtml(regexTranslate(summary));
    return `<section class="desk-lede">
        <p class="desk-deck" id="desk-deck">${deck}</p>
        <p class="desk-attrib">From the Storm Prediction Center's Day 1 Convective Outlook${issued}.</p>
    </section>`;
}

// The running copy: the SPC's own discussion narrative, abbreviation-expanded
// and nothing more. regexTranslate lives here rather than at the call site so
// both sources (discussion body, and the SUMMARY on the fallback path) get
// identical treatment.
export function buildCopyHtml(paragraphs) {
    const paras = (paragraphs || []).filter(Boolean);
    if (paras.length === 0) return '';
    const items = paras.map(p => `        <p>${escHtml(regexTranslate(p))}</p>`);
    return `<section class="desk-copy">
${items.join('\n')}
    </section>`;
}

// The day rail: today, tomorrow, and the day after. Cell shape is
// {label, level|null, note|null} — a null level prints an em dash, and a null
// note prints nothing at all, which is how a FAILED Day 2/3 fetch is told
// apart from a parsed product that outlined no risk.
export function buildRailHtml(rails) {
    const cells = (rails || []).map((r, i) => {
        const level = r?.level ? escHtml(sentenceWord(r.level)) : '—';
        const note = clipNote(r?.note);
        const noteHtml = note ? `<p class="desk-rail-note">${escHtml(note)}</p>` : '';
        return `        <div class="desk-rail-day${i === 0 ? ' now' : ''}">` +
            `<h3 class="desk-rail-label">${escHtml(r?.label ?? '')}</h3>` +
            `<p class="desk-rail-level">${level}</p>${noteHtml}</div>`;
    });
    return `<section class="desk-rail" aria-label="Three-day severe outlook">
${cells.join('\n')}
    </section>`;
}

// The Wire: two lines per forecast office under an active severe warning,
// worst first (groupDispatches already sorted). Line 1 names the office and
// its worst event; line 2 says where and until when. Offices Plaincast covers
// link to their desk; the rest are named but unlinked — there is nowhere to
// send the reader, and a dead /o/<CODE>/ link would 404.
//
// The expiry is office-LOCAL, so it needs the office's zone. An uncovered
// office has no entry in OFFICE_TIMEZONES, and formatExpiry would silently
// fall back to the runtime's zone — printing a Cheyenne warning's expiry in
// whatever timezone the serverless host happens to run in. No zone, no time:
// the area digest still carries line 2 on its own.
export function buildWireHtml(rows) {
    const all = rows || [];
    const shown = all.slice(0, WIRE_MAX);
    const items = shown.map(r => {
        const name = r.city
            ? `<a href="/o/${escHtml(r.code)}/">${escHtml(r.city)} (${escHtml(r.code)})</a>`
            : escHtml(r.code);
        const count = r.count > 1 ? ` ×${escHtml(r.count)}` : '';
        const tz = OFFICE_TIMEZONES[r.code];
        const detail = [digestArea(r.areaDesc), tz ? formatExpiry(r.expires, tz) : null]
            .filter(Boolean).map(escHtml).join(' · ');
        const line2 = detail ? `<span class="wire-area">${detail}</span>` : '';
        return `            <li class="wire-item${r.extreme ? ' wire-extreme' : ''}">` +
            `<span class="wire-office">${name}</span>` +
            `<span class="wire-event">${escHtml(r.event)}${count}</span>${line2}</li>`;
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

// The clock: when the next Day 1 outlook lands, and how often this page
// re-inks. Pure arithmetic from the fixed SPC issuance schedule, no fetch.
export function buildClockHtml(nextTime) {
    return `<p class="desk-clock">Next Day 1 outlook expected by ${escHtml(nextTime)}` +
        ` · this page re-inks every 10 minutes.</p>`;
}

// A soft outlook slot → a rail cell. Rejected, or fulfilled-with-nothing,
// both mean "we have no product": bare dash, no note. Only a product we
// actually parsed may say the sky is calm.
function railCell(label, settled) {
    if (settled?.status !== 'fulfilled' || !settled.value) return { label, level: null, note: null };
    const risk = parseRiskCategory(parseSpcOutlook(settled.value.productText).headline);
    return risk
        ? { label, level: risk.level, note: risk.regions || null }
        : { label, level: null, note: NO_RISK_NOTE };
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
        // SOFT set, started first so it runs alongside the hard set. It is an
        // allSettled, which NEVER rejects — so when the hard await below
        // throws and we bail to the baked shell, this promise cannot become
        // an unhandled rejection behind us.
        const softSettled = Promise.allSettled([
            fetchAlertTotals(sig()),
            fetchSpcOutlook('DY2', sig()),
            fetchSpcOutlook('DY3', sig()),
        ]);

        // HARD set: no severe feed or no Day 1 product means no front page.
        const [features, outlook] = await Promise.all([
            fetchSevereAlerts(sig()),
            fetchSpcOutlook('DY1', sig()),
        ]);

        const [totalsR, dy2R, dy3R] = await softSettled;
        const totals = totalsR.status === 'fulfilled' ? totalsR.value : null;

        // fetchSpcOutlook can resolve null (no product listed) — buildLedeHtml
        // then throws on the missing summary and we serve the shell.
        const { headline, summary } = parseSpcOutlook(outlook?.productText);
        const risk = parseRiskCategory(headline);

        // De-dup (spec §5): the standfirst distills the SUMMARY, so the
        // running copy takes the discussion that FOLLOWS it. With no such
        // discussion the SUMMARY runs as copy and the deck stands down —
        // never the same paragraph in both places.
        const body = parseDiscussionBody(outlook?.productText);
        const deckSuppressed = body.length === 0;
        const copy = deckSuppressed ? [summary] : body;

        const rows = groupDispatches(features, OFFICE_NAMES);
        // Desks with nothing on the wire. Only COVERED offices can be quiet —
        // an uncovered office has no desk to be quiet at.
        const quiet = DESK_COUNT - new Set(rows.filter(r => r.city).map(r => r.code)).size;

        const rail = [
            risk
                ? { label: 'Today · Day 1', level: risk.level, note: risk.regions || null }
                : { label: 'Today · Day 1', level: null, note: NO_RISK_NOTE },
            railCell('Tomorrow · Day 2', dy2R),
            railCell('Day 3', dy3R),
        ];

        const ssr = [
            buildStripHtml(buildCensus(features), totals, quiet),
            buildRiskHtml(risk),
            buildLedeHtml({ summary, issuanceTime: outlook?.issuanceTime || null, deckSuppressed }),
            buildCopyHtml(copy),
            buildRailHtml(rail),
            buildWireHtml(rows),
            // Request-time clock. Near a slot boundary a CDN-cached copy can name a
            // slot up to ~30 min past (600s fresh + SWR); "expected by" tolerates it
            // and the next origin render self-corrects. Accepted staleness, not a bug.
            buildClockHtml(nextOutlookTime(new Date().toISOString())),
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
