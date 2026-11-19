// Which sections of an AFD get an AI translation, and under which key. Pure
// (no AI SDK), so the page functions can join a stored translation set to
// the sections they render without loading the model client. Used by
// api/translate-issuance.js (which re-exports both) and api/office-page.js.
//
// Files prefixed with `_` are not treated as endpoints by Vercel.
import { SECTION_NAMES } from '../docs/js/offices.js';
import { isUntranslatable } from '../docs/js/untranslatable.js';
import { sectionDisplayKeys } from '../shadcn/src/lib/afd.js';
import { extractSections } from './_afd-sections.js';

// One raw header's display name on its own (SECTION_NAMES map, else sentence
// case). Within a product, use displaySections: two sections never share a
// key there (NEAR TERM is "Near Term" beside a SHORT TERM).
export function displayKey(rawKey) {
    return SECTION_NAMES[rawKey] || rawKey.charAt(0) + rawKey.slice(1).toLowerCase();
}

// extractSections with each section's display key (`display`), assigned per
// product by the client's own rule (shadcn/src/lib/afd.js
// sectionDisplayKeys, a pure module), so the keys line up with what the app
// renders and asks for.
export function displaySections(productText) {
    const sections = extractSections(productText);
    const keys = sectionDisplayKeys(sections.map(s => s.key));
    return sections.map((s, i) => ({ ...s, display: keys[i] }));
}

// The server pages' heading for each section of a product: the heading they
// have always printed (SECTION_NAMES, else Title Case), unless the product
// renamed the section to keep it distinct ("Near Term").
export function sectionHeadings(sections) {
    const titleCase = (k) => String(k).toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
    return sections.map(s => (s.display && s.display !== displayKey(s.key)
        ? s.display
        : SECTION_NAMES[s.key] || titleCase(s.key)));
}

// Sections that are never AI-translated: alerts render from the live alerts
// API, and the shared rule (docs/js/untranslatable.js isUntranslatable, the
// same one both clients and /api/translate apply) excludes tables (the model
// rewrites rows of station numbers as prose and swaps highs with lows) and
// sections under 25 words (already plain; the model padded them or wrote
// about the document).
const SKIP_KEYS = new Set(['Active Alerts']);
const MIN_SECTION_CHARS = 20;
const MAX_SECTION_CHARS = 10000;
const MAX_SECTIONS = 10;

// The display keys of an edition's never-translated sections (tables, short
// notes). A stored translation under one of these keys predates the rule (a
// table's may carry swapped numbers): readers drop it (api/_boot.js; the
// server-rendered digest never renders a table, api/office-page.js
// pickSections, and shows short sections without AI, aiForSections).
export function untranslatableDisplayKeys(productText) {
    return new Set(displaySections(productText)
        .filter(s => isUntranslatable(s.key, s.text))
        .map(s => s.display));
}

// The sections of one product that get a model call, in document order:
// [{ key: <display key>, text }]. This is also the definition of a COMPLETE
// translation set (api/translate-issuance.js translateEdition: one
// translation per section listed here), for the on-demand endpoint and the
// poller alike, so an excluded section can never leave an edition incomplete.
export function translatableSections(productText) {
    return displaySections(productText)
        .filter(s => !isUntranslatable(s.key, s.text))
        .map(s => ({ key: s.display, text: s.text }))
        .filter(s => !SKIP_KEYS.has(s.key))
        .filter(s => s.text.length >= MIN_SECTION_CHARS && s.text.length <= MAX_SECTION_CHARS)
        .slice(0, MAX_SECTIONS);
}
