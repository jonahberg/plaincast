import { ArrowLeft } from 'lucide-react';

import { OFFICE_NAMES } from '@data/offices.js';
import { Skeleton } from '@/components/ui/skeleton';

// The changelog view's frame (back link, title, standfirst) and its loading
// state. They live outside ChangelogView, which loads on demand: App.jsx
// renders the frame around it from the first frame, with this skeleton
// inside until the chunk arrives — the same skeleton ChangelogView then
// shows while its data loads, so nothing on screen moves or flashes.
export function ChangelogFrame({ office, onBack, children }) {
    const name = OFFICE_NAMES[office] || office;
    return (
        <section aria-labelledby="changelog-title">
            <div className="mb-8">
                <a
                    href={`/o/${office}/`}
                    onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                        e.preventDefault();
                        onBack();
                    }}
                    className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline pointer-coarse:min-h-11"
                >
                    <ArrowLeft className="size-3.5" aria-hidden="true" />
                    Back to the forecast
                </a>
                <h1 id="changelog-title" className="mt-4 font-serif text-[2rem] leading-[1.1] font-semibold tracking-[-0.02em] text-balance sm:text-[2.5rem]">
                    Forecast changelog{' '}— {name} <span className="font-normal text-muted-foreground">({office})</span>
                </h1>
                <p className="mt-3 max-w-[60ch] text-[15px] leading-6 text-muted-foreground">
                    Every revision to the {name} forecast, newest first — what changed with each update,
                    and whether the forecasters' confidence rose or fell.
                </p>
            </div>
            {children}
        </section>
    );
}

export function ChangelogSkeleton() {
    return (
        <div aria-busy="true" aria-label="Loading the changelog">
            {[0, 1, 2].map(i => (
                <div key={i} className="space-y-3 border-t py-7">
                    <Skeleton className="h-5 w-72 max-w-full" />
                    <Skeleton className="h-4 w-full max-w-[37rem]" />
                    <Skeleton className="h-4 w-2/3" />
                </div>
            ))}
        </div>
    );
}
