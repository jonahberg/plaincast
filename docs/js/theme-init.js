// Apply theme + time-of-day phase before paint to prevent flash. Loaded as a
// BLOCKING <script src> in <head> (no defer/module) so it runs pre-paint;
// extracting it from an inline <script> lets the CSP drop script-src
// 'unsafe-inline'.
(function () {
    var stored = localStorage.getItem('theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (stored === 'dark' || (!stored && prefersDark)) {
        document.documentElement.classList.add('dark');
    }
    // Best-effort initial sky phase from the *viewer's* clock; corrected to the
    // office timezone once the forecast loads. Avoids a flash of the wrong sky.
    var h = new Date().getHours();
    var phase = h < 5 ? 'night' : h < 7 ? 'dawn' : h < 10 ? 'morning'
              : h < 16 ? 'midday' : h < 18 ? 'golden' : h < 20 ? 'dusk' : 'night';
    document.documentElement.setAttribute('data-phase', phase);
})();
