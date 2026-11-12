// ─── AI translation client ──────────────────────────────────────────
// Same endpoints the vanilla client uses (api/translate-issuance.js and
// api/translate.js on the deployed site). Everything here soft-fails: when
// the /api functions aren't reachable (standalone dev), callers keep the
// regex translation.

import { stripAIArtifacts } from './afd';

const aiCache = new Map();
const AI_CACHE_MAX = 100;

// Raw model output → display HTML (markdown bold + paragraphs), shared by the
// per-issuance GET path and the per-section POST fallback.
// (Code-identical to app.js — locked by tests/shadcn-parity.test.js.)
export function formatTranslationHTML(raw) {
    const safe = stripAIArtifacts(raw)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return safe
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .split(/\n\s*\n+/)
        .filter(b => b.trim())
        .map(b => `<p>${b.trim().replace(/\n/g, ' ')}</p>`)
        .join('');
}

// One CDN-cached GET covers every section of an issuance; memoized per
// office+product so all section cards share a single request.
let issuanceMapKey = null;
let issuanceMapPromise = null;
let issuanceMapValue = null;   // the resolved map for issuanceMapKey, once known

// Translations the server embedded in the page (src/lib/boot.js). A complete
// set answers getIssuanceTranslations without a request; a partial one still
// renders its sections at once, and the GET fills in the rest.
let primed = { key: null, sections: null, complete: false };
const htmlMemo = new Map();    // `${key}|${section}` → formatted HTML

export function primeIssuanceTranslations(office, productId, sections, complete = false) {
    if (!office || !productId || !sections || typeof sections !== 'object') return;
    primed = { key: `${office}|${productId}`, sections, complete: Boolean(complete) };
}

// Synchronous: the display HTML for one section when its translation is
// already in hand (primed, or a map that has resolved), else null.
export function peekTranslation(office, productId, sectionKey) {
    if (!office || !productId || !sectionKey) return null;
    const key = `${office}|${productId}`;
    let raw = null;
    if (primed.key === key && typeof primed.sections[sectionKey] === 'string') raw = primed.sections[sectionKey];
    else if (issuanceMapKey === key && issuanceMapValue && typeof issuanceMapValue[sectionKey] === 'string') raw = issuanceMapValue[sectionKey];
    if (!raw) return null;
    const memoKey = `${key}|${sectionKey}`;
    if (!htmlMemo.has(memoKey)) {
        if (htmlMemo.size >= AI_CACHE_MAX) htmlMemo.delete(htmlMemo.keys().next().value);
        htmlMemo.set(memoKey, formatTranslationHTML(raw));
    }
    return htmlMemo.get(memoKey);
}

export function getIssuanceTranslations(office, productId) {
    const key = `${office}|${productId}`;
    if (primed.key === key && primed.complete) return Promise.resolve(primed.sections);
    if (issuanceMapKey !== key) {
        issuanceMapKey = key;
        issuanceMapValue = null;
        const base = primed.key === key ? primed.sections : null;
        issuanceMapPromise = fetch(`/api/translate-issuance?office=${encodeURIComponent(office)}&id=${encodeURIComponent(productId)}`)
            .then(r => (r.ok ? r.json() : null))
            .then(d => (d && d.sections && typeof d.sections === 'object' ? d.sections : null))
            .catch(() => null)
            .then(map => {
                const merged = base || map ? { ...(base || {}), ...(map || {}) } : null;
                if (issuanceMapKey === key) issuanceMapValue = merged;
                return merged;
            });
    }
    return issuanceMapPromise;
}

// Test hook: drop the memo, the primed set and the formatted-HTML cache.
export function resetTranslationMemoForTests() {
    issuanceMapKey = null;
    issuanceMapPromise = null;
    issuanceMapValue = null;
    primed = { key: null, sections: null, complete: false };
    htmlMemo.clear();
}

// Durable snapshot of an aged-out edition (old shares never rot) — the same
// endpoint also returns { productText, issuanceTime } when the server has one.
export async function fetchEditionSnapshot(office, editionId) {
    try {
        const d = await fetch(`/api/translate-issuance?office=${encodeURIComponent(office)}&id=${encodeURIComponent(editionId)}`)
            .then(r => (r.ok ? r.json() : null));
        return d && d.productText ? d : null;
    } catch (e) {
        return null;
    }
}

// Per-section POST fallback. Returns display HTML; throws on failure.
export async function fetchAITranslation(text, section, office, issuanceTime) {
    const key = `${office}|${section}|${issuanceTime || ''}|${text}`;
    if (aiCache.has(key)) return aiCache.get(key);

    const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, section, office, issuanceTime }),
    });
    if (!res.ok) throw new Error('Translation failed');
    const data = await res.json();
    const html = formatTranslationHTML(data.translation);
    if (aiCache.size >= AI_CACHE_MAX) {
        aiCache.delete(aiCache.keys().next().value);
    }
    aiCache.set(key, html);
    return html;
}

// The issuance map's translation of one section: HTML, or null when the map
// is unavailable or does not cover the section. One shared, CDN-cached GET,
// so ForecastSection asks for it on mount. Never throws.
export async function mapTranslation(section, office, productId) {
    if (!productId) return null;
    try {
        const map = await getIssuanceTranslations(office, productId);
        const raw = map && map[section.key];
        return typeof raw === 'string' && raw ? formatTranslationHTML(raw) : null;
    } catch (e) {
        return null;
    }
}

// The per-section POST fallback (one model call): HTML or null. Callers
// keep it lazy — only for a section the map does not cover, only once the
// section nears the viewport.
export async function postTranslation(section, office, issuanceTime) {
    try {
        return await fetchAITranslation(section.text, section.key, office, issuanceTime);
    } catch (e) {
        return null;
    }
}

// Preferred path for a section: issuance map first, per-section POST second.
// Returns HTML or null (soft failure — keep the regex translation).
export async function translateSection(section, office, productId, issuanceTime) {
    return (await mapTranslation(section, office, productId))
        || postTranslation(section, office, issuanceTime);
}

// Lazy plain-English lead for one alert via /api/explain-alert (unforgeable
// input: the server fetches by id). Returns HTML or null.
export async function explainAlert(id) {
    if (!id) return null;
    try {
        const d = await fetch(`/api/explain-alert?id=${encodeURIComponent(id)}`)
            .then(r => (r.ok ? r.json() : null));
        return d && d.explanation ? formatTranslationHTML(d.explanation) : null;
    } catch (e) {
        return null;
    }
}
