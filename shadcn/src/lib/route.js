// ─── URL contract ───────────────────────────────────────────────────
// Canonical form is the path (/o/LOT/), matching the vanilla client and the
// deployed site — one URL per office keeps shares and SEO equity in
// agreement. `?edition=<productId>` makes archived editions permalinks;
// `?view=changelog` is the edition ledger (linked from the SSR digest, the
// Markdown twin, llms.txt and the JSON-LD significantLink); `?office=` is
// accepted on the way in for backward compatibility but never minted.
//
// parseRoute/buildOfficeUrl are pure (URL in, value out) so the Bun suite can
// drive them without a window; currentRoute/officeUrl are thin wrappers.

const VIEWS = new Set(['changelog']);

export function parseRoute(href) {
    const url = new URL(href);
    const params = url.searchParams;
    const pathM = url.pathname.match(/\/o\/([A-Za-z]{3})\/?$/);
    const view = params.get('view');
    return {
        office: params.get('office')?.toUpperCase() || pathM?.[1]?.toUpperCase() || null,
        edition: params.get('edition') || null,
        view: view && VIEWS.has(view) ? view : null,
    };
}

// Builds the canonical URL for an office from `base` (any URL on this
// origin). Only the parameters this call names survive: `view` and
// `edition` are always rewritten, so a ledger URL never leaks
// `?view=changelog` into a share link or the next office's URL.
export function buildOfficeUrl(base, office, { edition = null, view = null } = {}) {
    const url = new URL(base);
    url.pathname = `/o/${encodeURIComponent(office)}/`;
    url.searchParams.delete('office');
    if (edition && !view) url.searchParams.set('edition', edition);
    else url.searchParams.delete('edition');
    if (view && VIEWS.has(view)) url.searchParams.set('view', view);
    else url.searchParams.delete('view');
    url.hash = '';
    return url;
}

export function currentRoute() {
    return parseRoute(window.location.href);
}

export function officeUrl(office, editionId, view = null) {
    return buildOfficeUrl(window.location.href, office, { edition: editionId, view });
}
