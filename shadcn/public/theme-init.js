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
