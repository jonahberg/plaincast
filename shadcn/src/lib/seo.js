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
