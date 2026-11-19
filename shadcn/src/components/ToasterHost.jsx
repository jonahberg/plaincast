import { useEffect, useSyncExternalStore } from 'react';

import { loadedToasts, subscribeToasts, toasterMounted } from '@/lib/toast';

// Renders sonner's Toaster once lib/toast.js has fetched it (nothing before:
// there are no toasts to show). <Mounted> comes after the Toaster, so its
// effect runs after the Toaster's own, which subscribe it to new toasts.
export function ToasterHost({ theme }) {
    const mod = useSyncExternalStore(subscribeToasts, loadedToasts);
    if (!mod) return null;
    const { Toaster } = mod;
    return (
        <>
            <Toaster theme={theme} position="bottom-right" />
            <Mounted />
        </>
    );
}

function Mounted() {
    useEffect(() => { toasterMounted(); }, []);
    return null;
}
