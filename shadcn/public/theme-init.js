// Pre-paint theme: follow a stored explicit choice, else the OS. Loaded as a
// blocking external script (no defer/module) so it runs before first paint;
// a file rather than inline so the CSP needs no script-src 'unsafe-inline'.
// One-time migration: the vanilla client stored its choice under `theme`;
// when `plaincast-theme` is unset, adopt that legacy value (and persist it
// under the new key so the React toggle and the OS listener see it).
(function () {
    try {
        var t = localStorage.getItem('plaincast-theme');
        if (!t) {
            var legacy = localStorage.getItem('theme');
            if (legacy === 'dark' || legacy === 'light') {
                t = legacy;
                localStorage.setItem('plaincast-theme', legacy);
            }
        }
        if (t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches)) {
            document.documentElement.classList.add('dark');
        }
    } catch (e) { /* first paint stays light */ }
})();

// Self-heal for a page whose own assets are gone. The app's script and
// stylesheet have content-hashed names that exist only in the deployment that
// rendered the page (and, before Nov 2026, stable names that no longer exist
// at all). A document from another deployment (a stale copy, a tab restored
// after a release) asks for files that now 404 and would sit unstyled and
// unmounted. This file keeps one stable name and is revalidated on every
// load, so both old and new documents run it: when one of the page's own
// /assets/ tags fails, reload once to pick up the current document. Guarded
// so a genuine outage cannot loop.
(function () {
    try {
        var KEY = 'plaincast-asset-reload';
        addEventListener('error', function (e) {
            var el = e && e.target;
            if (!el || el === window || !el.tagName) return;
            var url = el.tagName === 'SCRIPT' ? el.src : (el.tagName === 'LINK' && el.rel === 'stylesheet' ? el.href : '');
            if (!url || url.indexOf(location.origin + '/assets/') !== 0) return;
            var last = Number(sessionStorage.getItem(KEY)) || 0;
            if (Date.now() - last < 60000) return; // already tried just now
            sessionStorage.setItem(KEY, String(Date.now()));
            location.reload();
        }, true);
    } catch (e) { /* no storage or no listener: the page stays as it is */ }
})();
