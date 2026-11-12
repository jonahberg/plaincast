// ─── Boot data ──────────────────────────────────────────────────────
// The server-rendered page (api/home.js, api/office-page.js via
// api/_boot.js) embeds the latest edition it already fetched:
//
//   <script type="application/json" id="plaincast-boot">{…}</script>
//
// so the app's first render can be the finished page instead of a skeleton.
// Everything here is defensive: anything malformed reads as "no boot data"
// and the app loads the way it always has.

export const BOOT_ELEMENT_ID = 'plaincast-boot';
const ID_RE = /^[\w.:-]{1,64}$/;
const OFFICE_RE = /^[A-Z]{3}$/;

function plainObject(v) {
    return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

// Raw JSON text → validated boot data, or null.
export function parseBoot(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    let d;
    try { d = JSON.parse(text); } catch (e) { return null; }
    if (!plainObject(d) || d.v !== 1) return null;
    if (typeof d.office !== 'string' || !OFFICE_RE.test(d.office)) return null;

    const p = d.product;
    if (!plainObject(p)) return null;
    if (typeof p.id !== 'string' || !ID_RE.test(p.id)) return null;
    if (typeof p.productText !== 'string' || !p.productText.trim()) return null;
    if (p.issuanceTime != null && (typeof p.issuanceTime !== 'string' || Number.isNaN(Date.parse(p.issuanceTime)))) return null;

    let translations = null;
    if (plainObject(d.translations)) {
        const out = {};
        for (const [key, value] of Object.entries(d.translations)) {
            if (typeof value === 'string' && value.trim()) out[key] = value;
        }
        if (Object.keys(out).length) translations = out;
    }

    const boot = {
        v: 1,
        office: d.office,
        product: { id: p.id, issuanceTime: p.issuanceTime || null, productText: p.productText },
        translations,
        translationsComplete: Boolean(translations) && d.translationsComplete === true,
    };

    // `changelog` absent = unknown (the app fetches it); present = the
    // server's definitive answer for this issuance (null sentence = none).
    if (plainObject(d.changelog)
        && (d.changelog.changelog === null || typeof d.changelog.changelog === 'string')) {
        boot.changelog = {
            changelog: d.changelog.changelog || null,
            since: typeof d.changelog.since === 'string' ? d.changelog.since : null,
            updated: typeof d.changelog.updated === 'string' ? d.changelog.updated : null,
        };
    }
    return boot;
}

// Read once per page load (the element lives in the served HTML only).
let memo;
export function readBoot(doc = typeof document !== 'undefined' ? document : null) {
    if (memo !== undefined) return memo;
    const el = doc?.getElementById?.(BOOT_ELEMENT_ID);
    memo = el ? parseBoot(el.textContent) : null;
    return memo;
}

// Test hook: forget the memoized read.
export function resetBootForTests() {
    memo = undefined;
}

// Boot data applies only to the latest edition of the reading view of the
// office the page was rendered for. A permalink (?edition=), the changelog
// ledger, or a different office (e.g. `/` reopening a saved office) loads
// its own data.
export function bootFor(boot, { office, editionId, view }) {
    if (!boot || boot.office !== office) return null;
    if (editionId) return null;
    if (view === 'changelog') return null;
    return boot;
}
