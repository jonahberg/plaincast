// Stored explicit theme choice. The React app keeps it under
// `plaincast-theme`; the vanilla client stored `theme`. When the new key is
// unset, the legacy value is adopted once (copied forward) — the pre-paint
// twin of this is public/theme-init.js. Pure (storage injectable) so the Bun
// suite can drive it without a browser.
export const THEME_KEY = 'plaincast-theme';
export const LEGACY_THEME_KEY = 'theme';

export function storedTheme(storageArg) {
    try {
        const storage = storageArg || localStorage; // the accessor itself can throw
        const t = storage.getItem(THEME_KEY);
        if (t === 'dark' || t === 'light') return t;
        const legacy = storage.getItem(LEGACY_THEME_KEY);
        if (legacy === 'dark' || legacy === 'light') {
            storage.setItem(THEME_KEY, legacy);
            return legacy;
        }
    } catch (e) { /* private mode */ }
    return null;
}
