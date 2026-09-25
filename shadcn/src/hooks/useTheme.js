import { useCallback, useEffect, useState } from 'react';

import { storedTheme } from '@/lib/theme';

const KEY = 'plaincast-theme';

// Follows the OS until the user explicitly toggles — only a toggle persists
// (the first version persisted on mount, permanently pinning the first-visit
// theme). The pre-paint script in index.html applies the same logic before
// first paint.
export function useTheme() {
    const [theme, setTheme] = useState(() => {
        const stored = storedTheme();
        if (stored) return stored;
        return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    });

    useEffect(() => {
        document.documentElement.classList.toggle('dark', theme === 'dark');
    }, [theme]);

    // Track OS changes while no explicit choice is stored.
    useEffect(() => {
        const mq = matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => {
            if (storedTheme()) return;
            setTheme(mq.matches ? 'dark' : 'light');
        };
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, []);

    const toggle = useCallback(() => {
        setTheme(t => {
            const next = t === 'dark' ? 'light' : 'dark';
            try { localStorage.setItem(KEY, next); } catch (e) { /* private mode */ }
            return next;
        });
    }, []);

    return { theme, toggle };
}
