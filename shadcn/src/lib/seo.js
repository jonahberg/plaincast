// Page-title formats shared by the React app and the SSR/baked pages
// (scripts/build-offices.mjs re-exports officeTitle from here), so the
// client-side document.title can never drift from the server's <title>.
// Pure and dependency-free: Vite bundles it and Bun tests import it directly.

export function officeTitle(city) {
    return `${city} NWS Forecast in Plain English · Plaincast`;
}

export function changelogTitle(city) {
    return `Forecast Changelog · ${city} · Plaincast`;
}

export const SITE_ORIGIN = 'https://plaincast.live';

export function officeCanonical(code) {
    return `${SITE_ORIGIN}/o/${code}/`;
}

export function officeFeedHref(code) {
    return `/api/feed?office=${encodeURIComponent(code)}`;
}

// The homepage's own head values — the literal strings in shadcn/index.html
// (tests/shadcn-frontend.test.js pins them). Restored when the reader goes
// Back to `/` from an office page, which would otherwise keep that office's
// title and canonical.
export const HOME_TITLE = 'Plaincast - What the forecast actually says';
export const HOME_CANONICAL = SITE_ORIGIN;
export const HOME_MARKDOWN_HREF = `${SITE_ORIGIN}/`;

// Head values for the current client-side route: `office` null means the
// homepage URL. Titles also feed og:title / twitter:title (the baked office
// pages carry the office title there).
export function headFor({ office = null, city = '', changelog = false } = {}) {
    if (!office) {
        return { title: HOME_TITLE, canonical: HOME_CANONICAL, markdown: HOME_MARKDOWN_HREF };
    }
    const canonical = officeCanonical(office);
    return {
        title: changelog ? changelogTitle(city) : officeTitle(city),
        canonical,
        markdown: canonical,
    };
}
