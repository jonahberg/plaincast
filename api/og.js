// Vercel serverless function: per-office OG share card, rendered as a real
// PNG (Twitter/iMessage/Slack/Discord/Facebook all refuse SVG og:images).
//
// GET /api/og?office=LOX          → latest edition's takeaway  (s-maxage=3600)
// GET /api/og?office=LOX&id=...   → that pinned edition's card (s-maxage=86400)
//
// Node runtime on purpose: matches every other endpoint's (req, res) handler
// style, keeps the shared _utils/_afd-sections imports, and lets vercel.json
// `includeFiles` ship the card font subsets. @vercel/og's Node build renders
// through satori + resvg-wasm, no native deps.
//
// Unfurls must never 404: any invalid input, missing edition, NWS failure, or
// render failure 302s to the static /og-image.png instead.

import { readFileSync } from 'node:fs';
import { ImageResponse } from '@vercel/og';
import { OFFICE_NAMES, OFFICE_TIMEZONES } from '../docs/js/offices.js';
import { fetchAFDList, fetchAFDProduct, productUrlFromItem } from './_utils.js';
import { extractLede, regexTranslate, sectionHealth } from './_afd-sections.js';

// ─── The Dispatch card identity (DESIGN.md) ─────────────────────────
// Warm paper, ink, hairline rules. Dark text on paper only — no gradients,
// no icons. Fraunces for the wordmark + city, Source Serif for the takeaway.
const PAPER = '#f7f3ea';
const INK = '#211d17';
const RULE = '#d8cdb6';
const MUTED = '#6d6453';
const WIDTH = 1200;
const HEIGHT = 630;

// Same id contract as api/translate-issuance.js.
const ID_RE = /^[\w.:-]+$/;
const ID_MAX = 64;

const FALLBACK_TAKEAWAY = 'What the forecast actually says.';

// Card-only static TTF subsets (satori cannot read the site's woff2 files).
// Fraunces is pinned at wght 600; Source Serif 4 at 400; latin + latin-1
// punctuation coverage, ~27KB/~35KB. import.meta.url-relative reads are
// traced by Vercel's bundler; vercel.json includeFiles is belt-and-braces.
let fontCache = null;
function loadFonts() {
    if (!fontCache) {
        fontCache = [
            readFileSync(new URL('./_og-fonts/fraunces-card.ttf', import.meta.url)),
            readFileSync(new URL('./_og-fonts/source-serif-card.ttf', import.meta.url)),
        ];
    }
    return fontCache;
}

// Offices already warned about unparseable AFDs (format drift), once per instance.
const warnedOffices = new Set();

// ─── clampTakeaway ──────────────────────────────────────────────────
// extractLede caps at ~500 chars — too long for a 3-line deck. Expand NWS
// shorthand, collapse whitespace, and cap at ~240 chars on a sentence
// boundary; satori's lineClamp adds the ellipsis if a line still overflows.
export function clampTakeaway(lede, max = 240) {
    let t = regexTranslate(String(lede ?? ''));
    t = t.replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    const sentences = t.match(/[^.!?]+[.!?]+(?:\s+|$)/g);
    if (sentences) {
        let out = '';
        for (const s of sentences) {
            if ((out + s).trim().length > max) break;
            out += s;
        }
        out = out.trim();
        if (out) return out;
    }
    return t.slice(0, max - 1).trimEnd() + '…';
}

// ─── buildDateline ──────────────────────────────────────────────────
// "Area Forecast Discussion · Fri, Jul 3, 7:49 PM EDT" in the office's
// local time (same date/time split as api/feed.js — a single
// toLocaleString varies across ICU versions).
export function buildDateline(issuanceTime, office) {
    const base = 'Area Forecast Discussion';
    const issued = issuanceTime ? new Date(issuanceTime) : null;
    if (!issued || Number.isNaN(issued.getTime())) return base;
    const timeZone = OFFICE_TIMEZONES[office] || 'UTC';
    const date = issued.toLocaleDateString('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' });
    const time = issued.toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    return `${base} \u00b7 ${date}, ${time}`.replace(/[\u202f\u00a0]/g, ' ');
}

// ─── buildCardElement ───────────────────────────────────────────────
// Pure satori element tree (object form — no JSX in this repo), exported so
// tests can assert card content without rasterizing. Layout: masthead
// wordmark over a hairline rule, centered city + small-caps dateline +
// takeaway deck, hairline rule over the plaincast.live folio.
export function buildCardElement({ city, dateline, takeaway }) {
    const div = (style, children) => ({ type: 'div', props: { style, children } });
    return div(
        {
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: PAPER,
            color: INK,
            padding: '64px 72px',
            fontFamily: '"Source Serif 4"',
        },
        [
            // Masthead: Fraunces wordmark bound by a hairline rule.
            div({ display: 'flex', flexDirection: 'column' }, [
                div({ fontFamily: 'Fraunces', fontSize: 38, fontWeight: 600, letterSpacing: '-0.5px' }, 'Plaincast'),
                div({ marginTop: 22, height: 1, width: '100%', backgroundColor: RULE }, undefined),
            ]),
            // Centerpiece: city headline, small-caps dateline, takeaway deck.
            div({ display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'center' }, [
                div({ fontFamily: 'Fraunces', fontSize: 84, fontWeight: 600, letterSpacing: '-1.5px', lineHeight: 1.05 }, city),
                div({ marginTop: 18, fontSize: 21, letterSpacing: '2.5px', color: MUTED }, dateline.toUpperCase()),
                div({ display: 'block', marginTop: 30, fontSize: 33, lineHeight: 1.45, lineClamp: 3 }, takeaway),
            ]),
            // Folio: hairline rule, then the site name.
            div({ display: 'flex', flexDirection: 'column' }, [
                div({ height: 1, width: '100%', backgroundColor: RULE }, undefined),
                div({ marginTop: 20, fontSize: 21, letterSpacing: '1.5px', color: MUTED }, 'plaincast.live'),
            ]),
        ]
    );
}

// ─── renderCardPng ──────────────────────────────────────────────────
export async function renderCardPng({ city, dateline, takeaway }) {
    const [fraunces, sourceSerif] = loadFonts();
    const image = new ImageResponse(buildCardElement({ city, dateline, takeaway }), {
        width: WIDTH,
        height: HEIGHT,
        fonts: [
            { name: 'Fraunces', data: fraunces, weight: 600, style: 'normal' },
            { name: 'Source Serif 4', data: sourceSerif, weight: 400, style: 'normal' },
        ],
    });
    return Buffer.from(await image.arrayBuffer());
}

function fallback(res, { permanent = false } = {}) {
    // Permanently-invalid inputs can cache the redirect for a day; transient
    // NWS/render failures keep it short so recovery is quick.
    res.setHeader('Cache-Control', permanent ? 'public, s-maxage=86400' : 'public, s-maxage=300');
    return res.redirect(302, '/og-image.png');
}

export default async function handler(req, res) {
    const office = String(req.query.office || '').toUpperCase();
    const city = OFFICE_NAMES[office];
    if (!city) return fallback(res, { permanent: true });

    const id = typeof req.query.id === 'string' ? req.query.id.trim() : '';
    if (id && (id.length > ID_MAX || !ID_RE.test(id))) return fallback(res, { permanent: true });

    try {
        const items = (await fetchAFDList(office, { signal: AbortSignal.timeout(5000) })).slice(0, 40);
        let item;
        if (id) {
            // Pinned edition: must name a genuinely retained issuance.
            item = items.find(it => (it?.id || it?.['@id']) === id);
            if (!item) return fallback(res);
        } else {
            item = items[0];
        }
        const prodUrl = productUrlFromItem(item);
        if (!prodUrl) return fallback(res);

        const prod = await fetchAFDProduct(prodUrl, { signal: AbortSignal.timeout(5000) });
        const text = typeof prod?.productText === 'string' ? prod.productText : '';

        const health = sectionHealth(text);
        if (health.sectionCount === 0 && !warnedOffices.has(office)) {
            warnedOffices.add(office);
            console.warn(`[og] AFD format drift: ${office} parsed 0 sections (format=${health.format})`);
        }

        const takeaway = clampTakeaway(extractLede(text)) || FALLBACK_TAKEAWAY;
        const dateline = buildDateline(prod?.issuanceTime, office);

        const png = await renderCardPng({ city, dateline, takeaway });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', id
            ? 'public, s-maxage=86400, stale-while-revalidate=2592000'
            : 'public, s-maxage=3600, stale-while-revalidate=7200');
        return res.status(200).send(png);
    } catch (e) {
        return fallback(res);
    }
}
