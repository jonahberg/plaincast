import { onDemand } from '@/lib/on-demand';

// toast(), toast.success() and toast.error(), with sonner (about 10 KB) out
// of the first load: its chunk (assets/sonner.js, from components/ui/sonner)
// is fetched on the first toast, or earlier when the pointer or focus
// reaches a control that can raise one (prepareToasts).
//
// Sonner's <Toaster> is the aria-live region that announces a toast, and a
// screen reader only announces changes to a region that already exists. So
// <ToasterHost> mounts the Toaster as soon as the chunk arrives and reports
// back once it is subscribed; only then does the toast fire. If the chunk
// cannot load (offline before it was ever fetched), the toast is dropped:
// the action it confirms (the copy, the office switch) has already happened.

const load = onDemand(() => import('@/components/ui/sonner'));

let loaded = null;
const listeners = new Set();
let markReady;
const ready = new Promise((resolve) => { markReady = resolve; });

export function subscribeToasts(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// The sonner chunk once it has arrived (ToasterHost renders its Toaster).
export function loadedToasts() {
    return loaded;
}

// Called by ToasterHost after the Toaster's own effects have run.
export function toasterMounted() {
    markReady();
}

function prepareToasts() {
    return load().then((mod) => {
        if (!loaded) {
            loaded = mod;
            listeners.forEach(fn => fn());
        }
        return ready;
    });
}

// Intent prefetch (pointer over / focus on a control that may toast).
export function prefetchToasts() {
    prepareToasts().catch(() => { /* retried by the toast itself */ });
}

function show(variant, args) {
    prepareToasts().then(
        () => { (variant ? loaded.toast[variant] : loaded.toast)(...args); },
        () => { /* chunk unavailable: see above */ },
    );
}

export const toast = Object.assign((...args) => show(null, args), {
    success: (...args) => show('success', args),
    error: (...args) => show('error', args),
});
