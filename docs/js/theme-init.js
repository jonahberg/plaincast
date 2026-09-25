// Apply theme + time-of-day phase before paint to prevent flash. Loaded as a
// BLOCKING <script src> in <head> (no defer/module) so it runs pre-paint;
// extracting it from an inline <script> lets the CSP drop script-src
// 'unsafe-inline'.
//
// The theme key is the SPA's: localStorage['plaincast-theme'] ('dark' |
// 'light'), so a choice made on / or /o/<CODE>/ carries to the National Desk
// and the trust pages (and back — /js/site-chrome.js writes the same key).
// The legacy vanilla client stored 'theme'; it is read as a fallback so a
// returning reader keeps their old choice.
(function () {
    var stored = null;
    try {
        stored = localStorage.getItem('plaincast-theme') || localStorage.getItem('theme');
    } catch (e) { /* storage blocked: follow the OS */ }
    var prefersDark = false;
    try { prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { /* old engine */ }
    if (stored === 'dark' || (stored !== 'light' && prefersDark)) {
        document.documentElement.classList.add('dark');
    }
    // Best-effort initial sky phase from the *viewer's* clock (used by the
    // legacy docs/index.html client only; harmless elsewhere).
    var h = new Date().getHours();
    var phase = h < 5 ? 'night' : h < 7 ? 'dawn' : h < 10 ? 'morning'
              : h < 16 ? 'midday' : h < 18 ? 'golden' : h < 20 ? 'dusk' : 'night';
    document.documentElement.setAttribute('data-phase', phase);
})();
