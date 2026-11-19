// Section-level translation reuse (PLAINCAST_PRETRANSLATE=1 only).
//
// Forecasters often reissue a discussion with one section rewritten and the
// rest carried over word for word. Before a section costs a model call, the
// translator looks for a stored translation of the same section; only
// sections whose text is new are sent to the model. Measured Nov 18 2026 on
// 40 consecutive issuance pairs (LOX, OKX, LOT, BOU, AFC): 36% of sections
// (59 of 166) reusable under the rule below.
//
// THE RULE (what makes an earlier translation truthful for a later
// issuance). The hash covers, besides office and section name:
//   - the RAW section text, its stamp line included ("17/522 AM.",
//     "Issued at 1228 AM CST Tue Nov 17 2026"). The stamp is what tells a
//     section carried over from one rewritten later in the same words: a
//     Wednesday rewrite of Monday's "tonight... tomorrow" must not reuse
//     Monday's translation, which names Monday's days;
//   - the exact user prompt, annotateZuluTimes(stripHeaderStamp(text)): a
//     carried-over "15Z" that now resolves to another local hour or day is
//     a different section;
//   - for a section WITHOUT a stamp (Key Messages formats, some offices),
//     the issuance's local date: with no writing time in the text, nothing
//     shows that unchanged words still mean the same days.
// The system prompt's issuance TIME is otherwise left out: for a stamped,
// unchanged section the earlier translation read the text against the time
// it was written, which is the reading the forecaster meant. The stored text
// is sanitized again with the NEW issuance time on every reuse.
//
// Entries: `ts:v2:<OFFICE>:<sha256>` → { office, key, hash, text }, untagged,
// one week. They hold a single section's finished, sanitized translation
// (what translate.js's own per-section cache keeps), never a partial edition.
// Bump SECTION_KEY_VERSION with TRANSLATION_KEY_VERSION.
//
// Files prefixed with `_` are not treated as endpoints by Vercel.
import { createHash } from 'node:crypto';
import { annotateZuluTimes, getTranslationCalendarContext, sanitizeTranslation, stripHeaderStamp } from './translate.js';
import { sectionKey, storeRead, storeWrite, TRANSLATION_TTL } from './_shared-cache.js';

export function sectionPrompt(office, issuanceTime, text) {
    return annotateZuluTimes(stripHeaderStamp(text), office, issuanceTime);
}

// A forecaster's writing stamp at the start of a section.
const STAMP_RE = /^\s*(?:\d{1,2}\/\d{3,4}\s*(?:AM|PM|Z)\b|Issued at\b|As of\b|Updated at\b)/i;
export function hasStamp(text) {
    return typeof text === 'string' && STAMP_RE.test(text);
}

export function sectionHash(office, key, issuanceTime, text) {
    const raw = String(text ?? '');
    const day = hasStamp(raw) ? '' : getTranslationCalendarContext(office, issuanceTime).localDateLabel;
    return createHash('sha256')
        .update(`${office}\n${key}\n${day}\n${raw}\n\u0000${sectionPrompt(office, issuanceTime, raw)}`)
        .digest('hex');
}

// The stored translation of this section, re-sanitized for this issuance,
// or null (miss, failure, an entry that does not name itself).
export async function findReusedSection(office, issuanceTime, section, { timeoutMs } = {}) {
    try {
        const hash = sectionHash(office, section.key, issuanceTime, section.text);
        const r = await storeRead(sectionKey(office, hash), timeoutMs ? { timeoutMs } : undefined);
        const e = r.ok ? r.value : null;
        if (!e || typeof e !== 'object' || e.office !== office || e.key !== section.key || e.hash !== hash) return null;
        if (typeof e.text !== 'string' || !e.text.trim()) return null;
        return sanitizeTranslation(e.text, { office, issuanceTime }) || null;
    } catch {
        return null;
    }
}

// `sections` with `reused` set where a stored translation exists.
export async function withReusedSections(office, issuanceTime, sections, opts) {
    const found = await Promise.all(sections.map(s => findReusedSection(office, issuanceTime, s, opts)));
    return sections.map((s, i) => (found[i] ? { ...s, reused: found[i] } : { ...s }));
}

export async function storeReusedSection(office, issuanceTime, section, text) {
    if (typeof text !== 'string' || !text.trim()) return false;
    const hash = sectionHash(office, section.key, issuanceTime, section.text);
    return storeWrite(sectionKey(office, hash), { office, key: section.key, hash, text }, { ttl: TRANSLATION_TTL });
}
