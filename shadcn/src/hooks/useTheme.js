import { useCallback, useEffect, useState } from 'react';

const KEY = 'plaincast-theme';

export function useTheme() {
    const [theme, setTheme] = useState(() =>
        document.documentElement.classList.contains('dark') ? 'dark' : 'light'
    );

    useEffect(() => {
        document.documentElement.classList.toggle('dark', theme === 'dark');
        try { localStorage.setItem(KEY, theme); } catch (e) { /* private mode */ }
    }, [theme]);

    const toggle = useCallback(() => {
        setTheme(t => (t === 'dark' ? 'light' : 'dark'));
    }, []);

    return { theme, toggle };
}
