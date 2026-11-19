// ─── Sections that are never AI-translated ──────────────────────────
// One rule, isUntranslatable(key, text), for every place that decides whether
// a section goes to the model: the server's section selection
// (api/_translatable.js translatableSections, which is the edition path, the
// poller and the definition of a COMPLETE translation set), the single-section
// endpoint (api/translate.js buildSectionIndex, so an old client's request is
// refused), and both clients (shadcn/src/App.jsx and docs/js/app.js, which
// never ask and show the NWS text with its shorthand expanded). Pure and
// dependency-free apart from ./tabular.js, so the legacy client can load it
// as is.
//
// Two exclusions:
//   1. Tables (./tabular.js): the model rewrites rows of station numbers as
//      prose and swaps highs with lows.
//   2. Short sections: fewer than MIN_TRANSLATABLE_WORDS words once the
//      section's own stamp is removed (stripHeaderStamp below). Measured on
//      real model output, Nov 18 2026: notes such as "Updated aviation section
//      for the 00Z TAFs. No changes to the forecast.", one-line "What has
//      changed" notes and 8-word spotter statements came back padded to 2-5
//      times their length, or as commentary about the document. They are
//      already plain English.
// A word is a whitespace-separated token with a letter or digit in it, after
// NWS "..." separators become spaces ("TAFs...No" is two words; "-" and "&&"
// are none).

import { isTabularSection } from './tabular.js';

export const MIN_TRANSLATABLE_WORDS = 25;

// Forecaster header stamp at the top of a section: "11/220 PM." = day 11,
// 2:20 PM (LOX writes one after every header; "03/428 PM.", "11/459 PM.").
// The model read "11/22" out of it as a date (LOX Long Term, Nov 11 2026:
// "Sunday, November 22"; that Sunday was Nov 15), so it leaves the PROMPT
// only (api/translate.js). The cache key and AFD verification keep the exact
// section text, which is parity-locked to the client parser. Same shape as
// the lede stripper in api/_afd-sections.js sectionProse, but AM/PM is
// required: a Zulu stamp ("12/0454Z.") already gets a correct local time from
// annotateZuluTimes. Anchored to the start of the text (no m flag): a
// mid-text "11/220" stays.
export const HEADER_STAMP_RE = /^\s*(?:\d{1,2}\/\d{3,4}\s*(?:AM|PM)\b\.?\s*)+/i;
// Most offices open a section with "Issued at 528 PM CST Wed Nov 18 2026"
// (MFL Key Messages: "Updated at 635 PM EST ..."), and the model restated it
// (HGX Aviation, Nov 18 2026: "This aviation forecast, issued Wednesday
// evening, November 18, 2026, at 5:28 PM Central time, warns..."). The page
// already shows the issue time, so the line leaves the PROMPT too. Only that
// exact header shape at the head of the section ("at" optional: MKX writes
// "Issued 545 AM CDT Mon Sep 28 2026"), after any qualifier lines such as
// "(00Z TAF Issuance)" or "(Rest of today through Thursday)", which are
// content and stay (group 1).
// Group 2 is the time itself ("528 PM CST Wed Nov 18 2026"), for
// api/translate.js sectionWrittenTime.
export const ISSUED_LINE_RE = /^(\s*(?:\([^()\n]*\)[ \t]*\r?\n\s*)*)(?:Issued|Updated)(?:[ \t]+at)?[ \t]+(\d{1,4}[ \t]*(?:AM|PM)[ \t]+[A-Z]{2,5}[ \t]+(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)[ \t]+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[ \t]+\d{1,2}[ \t]+\d{4})[ \t]*(?:\r?\n\s*|$)/i;

// The section without its leading stamp and "Issued at" line (a section that
// is nothing but a stamp is returned whole).
export function stripHeaderStamp(text) {
    if (typeof text !== 'string') return text;
    const out = text.replace(HEADER_STAMP_RE, '').replace(ISSUED_LINE_RE, '$1');
    return out.trim() ? out : text;
}

// The section's words, its stamp not counted.
export function sectionWordCount(text) {
    return String(stripHeaderStamp(String(text ?? '')))
        .replace(/\.{2,}/g, ' ')
        .split(/\s+/)
        .filter(w => /[A-Za-z0-9]/.test(w))
        .length;
}

export function isShortSection(text) {
    return sectionWordCount(text) < MIN_TRANSLATABLE_WORDS;
}

// `key` is the raw header ("PRELIMINARY POINT TEMPS/POPS") or the display key
// ("Preliminary point temps/pops"); both decide alike.
export function isUntranslatable(key, text) {
    return isTabularSection(key, text) || isShortSection(text);
}
