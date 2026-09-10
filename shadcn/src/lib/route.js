// ─── URL contract ───────────────────────────────────────────────────
// Canonical form is the path (/o/LOT/), matching the vanilla client and the
// deployed site — one URL per office keeps shares and SEO equity in
// agreement. `?edition=<productId>` makes archived editions permalinks;
// `?office=` is accepted on the way in for backward compatibility but never
// minted.

export function currentRoute() {
    const params = new URLSearchParams(window.location.search);
    const pathM = window.location.pathname.match(/\/o\/([A-Za-z]{3})\/?$/);
    return {
        office: params.get('office')?.toUpperCase() || pathM?.[1]?.toUpperCase() || null,
        edition: params.get('edition') || null,
    };
}

export function officeUrl(office, editionId) {
    const url = new URL(window.location.href);
    url.pathname = `/o/${encodeURIComponent(office)}/`;
    url.searchParams.delete('office');
    if (editionId) url.searchParams.set('edition', editionId);
    else url.searchParams.delete('edition');
    url.hash = '';
    return url;
}
