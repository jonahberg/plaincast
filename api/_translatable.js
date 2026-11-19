// Which sections of an AFD get an AI translation, and under which key. Pure
// (no AI SDK), so the page functions can join a stored translation set to
// the sections they render without loading the model client. Used by
// api/translate-issuance.js (which re-exports both) and api/office-page.js.
//
// Files prefixed with `_` are not treated as endpoints by Vercel.
import { SECTION_NAMES } from '../docs/js/offices.js';
import { isTabularSection } from '../docs/js/tabular.js';
import { extractSections } from './_afd-sections.js';

// Mirror the client parser's section keying (SECTION_NAMES map, else Title Case)
// so returned keys line up with what app.js renders.
export function displayKey(rawKey) {
    return SECTION_NAMES[rawKey] || rawKey.charAt(0) + rawKey.slice(1).toLowerCase();
}

// Sections that are never AI-translated: alerts render from the live alerts
// API, tables (docs/js/tabular.js: the model rewrites rows of station
// numbers as prose and swaps highs with lows) are already as plain as they
// get, and sub-minimum fragments aren't worth a model call.
const SKIP_KEYS = new Set(['Active Alerts']);
const MIN_SECTION_CHARS = 20;
const MAX_SECTION_CHARS = 10000;
const MAX_SECTIONS = 10;

// The display keys of an edition's tables. None is ever translated now, so a
// stored translation under one of these keys predates the rule (and may
// carry swapped numbers): readers drop it (api/_boot.js; the server-rendered
// digest never renders a table at all, api/office-page.js pickSections).
export function tabularDisplayKeys(productText) {
    return new Set(extractSections(productText)
        .filter(s => isTabularSection(s.key, s.text))
        .map(s => displayKey(s.key)));
}

// The sections of one product that get a model call, in document order:
// [{ key: <display key>, text }]. This is also the definition of a COMPLETE
// translation set (api/translate-issuance.js translateEdition: one
// translation per section listed here), for the on-demand endpoint and the
// poller alike, so an excluded section can never leave an edition incomplete.
export function translatableSections(productText) {
    return extractSections(productText)
        .filter(s => !isTabularSection(s.key, s.text))
        .map(s => ({ key: displayKey(s.key), text: s.text }))
        .filter(s => !SKIP_KEYS.has(s.key))
        .filter(s => s.text.length >= MIN_SECTION_CHARS && s.text.length <= MAX_SECTION_CHARS)
        .slice(0, MAX_SECTIONS);
}
