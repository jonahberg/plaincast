// Lightweight failure telemetry via Vercel Web Analytics (the deferred
// /_vercel/insights/script.js in index.html defines window.va). A no-op when
// the script isn't loaded (dev, blockers), and it can never break the page.
// Same contract as the vanilla client's track() (docs/js/app.js), so the
// dashboard's event names carry over: afd-fetch-fail, afd-parse-empty,
// ai-translate-fail, changelog-view-fail.
export function track(name, data) {
    try {
        if (typeof window !== 'undefined' && typeof window.va === 'function') {
            window.va('event', { name, data: data || {} });
        }
    } catch (e) { /* never break the page */ }
}
