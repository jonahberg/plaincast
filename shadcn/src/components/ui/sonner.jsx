import { Toaster as Sonner } from 'sonner';

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
