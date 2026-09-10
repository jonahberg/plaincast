// Pre-paint theme: follow a stored explicit choice, else the OS. Loaded as a
// blocking external script (no defer/module) so it runs before first paint;
// a file rather than inline so the CSP needs no script-src 'unsafe-inline'.
(function () {
    try {
        var t = localStorage.getItem('plaincast-theme');
        if (t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches)) {
            document.documentElement.classList.add('dark');
        }
    } catch (e) { /* first paint stays light */ }
})();
