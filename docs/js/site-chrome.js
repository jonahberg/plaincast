// Header behaviour for the server-rendered pages that share the SPA's look
// (/national/, /about, /contact, /privacy, /developers, the 404). Loaded
// with `defer` from an external file: the CSP is script-src 'self', so no
// inline script and no inline on* handlers.
//
// 1. Theme toggle. The button ships `hidden` (it cannot work without JS);
//    this reveals it and flips `.dark` on <html>, persisting the choice under
//    localStorage['plaincast-theme'] — the same key the SPA and
//    /js/theme-init.js use, so the choice follows the reader site-wide.
// 2. Marks the current page's nav link with aria-current="page", so the
//    header markup can stay byte-identical across every shell.
(function () {
    var root = document.documentElement;

    var toggle = document.querySelector('[data-theme-toggle]');
    if (toggle) {
        var sync = function () {
            toggle.setAttribute('aria-pressed', root.classList.contains('dark') ? 'true' : 'false');
        };
        toggle.hidden = false;
        sync();
        toggle.addEventListener('click', function () {
            var dark = root.classList.toggle('dark');
            try { localStorage.setItem('plaincast-theme', dark ? 'dark' : 'light'); } catch (e) { /* not persisted */ }
            sync();
        });
    }

    var path = location.pathname.replace(/\/+$/, '') || '/';
    var links = document.querySelectorAll('.site-nav a');
    for (var i = 0; i < links.length; i++) {
        var href = (links[i].getAttribute('href') || '').replace(/\/+$/, '') || '/';
        if (href === path) links[i].setAttribute('aria-current', 'page');
    }
})();
