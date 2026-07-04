// Shared server-side AFD section parsing. Files prefixed with `_` are not
// treated as endpoints by Vercel, so this module is server-only.
//
// NWS is migrating AFDs office-by-office to an impacts-first "Key Message"
// format (e.g. AKQ since Jan 2026, OKX): the classic .SYNOPSIS section is
// replaced by .WHAT HAS CHANGED / .KEY MESSAGES sections. This module parses
// both formats so feed/OG descriptions never fall through to the raw product
// text (which begins with WMO telegraph headers like "000 FXUS61 KOKX 032349").
//
// The header regexes mirror the proven client-side parseSections logic
// (docs/js/app.js / tests/helpers.js), hardened in June 2026 for
// slash-delimited headers like ".AVIATION /14Z TAFS/...". Kept self-contained
// here so serverless functions do not depend on frontend modules — the one
// exception is the shared abbreviation table (docs/js/abbreviations.js, pure
// data, already a server dependency via api/feed.js).

import { BASIC_ABBREVIATIONS } from '../docs/js/abbreviations.js';

// ─── regexTranslate ─────────────────────────────────────────────────
// Deterministic, no-AI plain-English pass: expands NWS abbreviations and
// normalizes "..." separators. Shared by api/office-page.js (server-rendered
// office pages); api/feed.js keeps its own identical copy.
export function regexTranslate(text) {
    let t = String(text ?? '');
    t = t.replace(/\.{3,}/g, '. ');
    t = t.replace(/[ \t]{2,}/g, ' ');
    for (const [pat, rep] of BASIC_ABBREVIATIONS) t = t.replace(pat, rep);
    return t.trim();
}

// Office-prefixed headers, e.g. ".LOX WATCHES/WARNINGS/ADVISORIES..."
// (also matches ".KEY MESSAGES..." with "KEY" as the pseudo-prefix — the
// resulting "MESSAGES" key is canonicalized below).
const OFFICE_HEADER_RE = /^\.[A-Z]{3}\s+([A-Z\s\/]+?)(?:\s*(?:\([^)]*\)|\/[^/]*\/))?\s*\.{2,3}/;
// Plain headers, e.g. ".SYNOPSIS...", ".SHORT TERM /THROUGH TONIGHT/...",
// ".NEAR TERM (rest of tonight)...", ".WHAT HAS CHANGED..."
const PLAIN_HEADER_RE = /^\.([A-Z\s\/]+?)(?:\s*(?:\([^)]*\)|\/[^/]*\/))?\s*\.{2,3}/;

// Canonicalize keys mangled by the office-prefix branch.
const KEY_ALIASES = {
    'MESSAGES': 'KEY MESSAGES',
};

const WMO_TELEGRAPH_LINES = [
    /^\s*$/,                                                  // blank
    /^\d{3}\s*$/,                                             // transmission number, e.g. "000"
    /^[A-Z]{4}\d{2}\s+[A-Z]{4}\s+\d{6}(?:\s+[A-Z]{3})?\s*$/,  // WMO heading, e.g. "FXUS61 KOKX 032349"
    /^AFD[A-Z]{2,3}\s*$/,                                     // AWIPS identifier, e.g. "AFDOKX"
];

// ─── stripWmoHeader ─────────────────────────────────────────────────
// Removes the WMO telegraph preamble (numeric line, FXUS.. line, AFDxxx
// line) and everything from the trailing $$ marker onward (forecaster
// signatures, office URLs).
export function stripWmoHeader(productText) {
    if (typeof productText !== 'string' || !productText) return '';
    let t = productText.replace(/\r\n/g, '\n');
    const lines = t.split('\n');
    let i = 0;
    // Only inspect the first few lines — the telegraph preamble is at the top.
    while (i < lines.length && i < 8 && WMO_TELEGRAPH_LINES.some(re => re.test(lines[i]))) {
        i++;
    }
    t = lines.slice(i).join('\n');
    // Cut at the end-of-product marker; signature noise follows it.
    const end = t.search(/^\$\$\s*$/m);
    if (end !== -1) t = t.slice(0, end);
    return t.replace(/^\n+/, '').replace(/\s+$/, '');
}

function cleanSectionText(text) {
    return text
        .replace(/&&\s*$/, '')
        .replace(/^\s*&&\s*/gm, '')
        .trim();
}

// ─── extractSections ────────────────────────────────────────────────
// Parses all section headers into [{ key, text }]. Keys are the raw
// uppercase header names (office prefixes stripped), e.g. 'SYNOPSIS',
// 'KEY MESSAGES', 'WHAT HAS CHANGED', 'WATCHES/WARNINGS/ADVISORIES'.
export function extractSections(productText) {
    const text = stripWmoHeader(productText);
    if (!text) return [];
    const sections = [];
    let currentKey = null;
    let currentLines = [];
    const push = () => {
        if (currentKey) sections.push({ key: currentKey, text: cleanSectionText(currentLines.join('\n')) });
    };

    for (const line of text.split('\n')) {
        let rawKey = null;
        let matched = null;
        let m = line.match(OFFICE_HEADER_RE);
        if (m) {
            rawKey = m[1];
            matched = m[0];
        } else {
            m = line.match(PLAIN_HEADER_RE);
            if (m) {
                rawKey = m[1];
                matched = m[0];
            }
        }
        if (rawKey !== null) {
            push();
            rawKey = rawKey.trim();
            currentKey = KEY_ALIASES[rawKey] || rawKey;
            currentLines = [line.replace(matched, '').trim()];
            continue;
        }
        if (line.trim() === '$$') {
            push();
            currentKey = null;
            currentLines = [];
            continue;
        }
        if (/^&&$/.test(line.trim())) continue;
        if (currentKey) currentLines.push(line);
    }
    push();
    return sections;
}

// ─── extractLede ────────────────────────────────────────────────────
// Best "takeaway" text for feeds/OG cards. Preference order:
// SYNOPSIS → KEY MESSAGES (bullets joined into prose) → WHAT HAS CHANGED
// → UPDATE → DISCUSSION → SHORT TERM / NEAR TERM → first substantial
// paragraph after header strip. Never returns WMO header junk.
// Capped at ~500 chars on a sentence boundary.
const LEDE_ORDER = ['SYNOPSIS', 'KEY MESSAGES', 'WHAT HAS CHANGED', 'UPDATE', 'DISCUSSION', 'SHORT TERM', 'NEAR TERM'];
const LEDE_MAX = 500;

function sectionProse(text) {
    // Strip bullet markers ("1) ", "- ", "* ") at line starts so Key
    // Message lists join into readable prose.
    let t = text
        .split('\n')
        .map(line => line.replace(/^\s*(?:\d+[\).]\s+|[-*]\s+)/, ''))
        .join('\n');
    // Strip leading issuance timestamps / boilerplate:
    //   "03/428 PM."  (classic LOX-style header remnant)
    //   "As of 240 PM EDT Friday..." (Key Message format)
    //   "Issued at 300 PM PDT..." (some offices)
    t = t.replace(/^\s*(?:\d{1,2}\/\d{3,4}\s*(?:AM|PM|Z)?\.?\s*)+/i, '');
    t = t.replace(/^\s*As of [^.\n]*\.{2,3}\s*/i, '');
    t = t.replace(/^\s*Issued at [^.\n]*\d{4}\s*/i, '');
    // NWS uses "..." as an inline separator; normalize to sentence breaks.
    t = t.replace(/\.{2,}/g, '. ');
    t = t.replace(/\s+/g, ' ').trim();
    return t;
}

function capAtSentenceBoundary(text, max = LEDE_MAX) {
    if (text.length <= max) return text;
    const sentences = text.match(/[^.!?]+[.!?]+(?:\s+|$)/g);
    if (sentences) {
        let out = '';
        for (const s of sentences) {
            if ((out + s).trim().length > max) break;
            out += s;
        }
        out = out.trim();
        if (out) return out;
    }
    return text.slice(0, max - 3).trimEnd() + '...';
}

function isMastOrJunk(paragraph) {
    return /^\d/.test(paragraph)
        || /^(?:FXUS|AFD)/.test(paragraph)
        || /^Area Forecast Discussion/i.test(paragraph)
        || /^National Weather Service/i.test(paragraph)
        || /^Issued by/i.test(paragraph);
}

export function extractLede(productText) {
    const sections = extractSections(productText);
    const byKey = new Map();
    for (const s of sections) {
        if (!byKey.has(s.key)) byKey.set(s.key, s.text);
    }
    for (const key of LEDE_ORDER) {
        const raw = byKey.get(key);
        if (!raw) continue;
        const prose = sectionProse(raw);
        if (prose && !isMastOrJunk(prose)) return capAtSentenceBoundary(prose);
    }
    // Fallback: first substantial paragraph after the header strip.
    const stripped = stripWmoHeader(productText);
    for (const para of stripped.split(/\n\s*\n/)) {
        const p = sectionProse(para);
        if (p.length < 40) continue;
        if (isMastOrJunk(p)) continue;
        return capAtSentenceBoundary(p);
    }
    return '';
}

// ─── sectionHealth ──────────────────────────────────────────────────
// Parse-health signal for logging format drift as NWS migrates offices
// to the Key Message format.
const CLASSIC_KEYS = new Set(['SYNOPSIS', 'SHORT TERM', 'NEAR TERM', 'LONG TERM', 'EXTENDED', 'DISCUSSION', 'UPDATE']);

export function sectionHealth(productText) {
    const sections = extractSections(productText);
    const keys = new Set(sections.map(s => s.key));
    let format = 'unknown';
    if (keys.has('KEY MESSAGES') || keys.has('WHAT HAS CHANGED')) {
        format = 'key-messages';
    } else if ([...keys].some(k => CLASSIC_KEYS.has(k))) {
        format = 'classic';
    }
    return {
        sectionCount: sections.length,
        hasLede: extractLede(productText).length > 0,
        format,
    };
}
