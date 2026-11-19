import { Toaster as Sonner } from 'sonner';

// Loaded on demand only (src/lib/toast.js): import toast from there, never
// from 'sonner' directly, or sonner lands back in the first-load bundle.
export { toast } from 'sonner';

function Toaster({ theme = 'light', ...props }) {
    return (
        <Sonner
            theme={theme}
            className="toaster group"
            style={{
                '--normal-bg': 'var(--popover)',
                '--normal-text': 'var(--popover-foreground)',
                '--normal-border': 'var(--border)',
            }}
            {...props}
        />
    );
}

export { Toaster };
