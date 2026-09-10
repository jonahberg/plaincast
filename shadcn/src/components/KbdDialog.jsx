import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

const SHORTCUTS = [
    ['j', 'Next section'],
    ['k', 'Previous section'],
    ['/', 'Search offices'],
    ['?', 'Show this help'],
    ['Esc', 'Close overlay'],
];

export function KbdDialog({ open, onOpenChange }) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Keyboard Shortcuts</DialogTitle>
                    <DialogDescription className="sr-only">
                        Keyboard shortcuts for navigating the forecast
                    </DialogDescription>
                </DialogHeader>
                <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 font-sans text-sm">
                    {SHORTCUTS.map(([key, desc]) => (
                        <div key={key} className="contents">
                            <dt>
                                <kbd className="inline-flex min-w-7 items-center justify-center rounded border bg-secondary px-1.5 py-0.5 font-mono text-xs">
                                    {key}
                                </kbd>
                            </dt>
                            <dd className="text-muted-foreground">{desc}</dd>
                        </div>
                    ))}
                </dl>
            </DialogContent>
        </Dialog>
    );
}
