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

export function getIssuanceTranslations(office, productId) {
    const key = `${office}|${productId}`;
    if (issuanceMapKey !== key) {
        issuanceMapKey = key;
        issuanceMapPromise = fetch(`/api/translate-issuance?office=${encodeURIComponent(office)}&id=${encodeURIComponent(productId)}`)
            .then(r => (r.ok ? r.json() : null))
            .then(d => (d && d.sections && typeof d.sections === 'object' ? d.sections : null))
            .catch(() => null);
    }
    return issuanceMapPromise;
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

// Preferred path for a section: issuance map first, per-section POST second.
// Returns HTML or null (soft failure — keep the regex translation).
export async function translateSection(section, office, productId, issuanceTime) {
    try {
        if (productId) {
            const map = await getIssuanceTranslations(office, productId);
            if (map && typeof map[section.key] === 'string' && map[section.key]) {
                return formatTranslationHTML(map[section.key]);
            }
        }
        return await fetchAITranslation(section.text, section.key, office, issuanceTime);
    } catch (e) {
        return null;
    }
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
