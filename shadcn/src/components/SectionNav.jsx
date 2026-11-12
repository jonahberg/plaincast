import { cn } from '@/lib/utils';

// The contents line: quiet sans text links, the active one underlined in
// brand. Scrolls sideways on phones (no visible scrollbar) rather than
// wrapping into a ragged block.
export function SectionNav({ sections, activeKey, onJump }) {
    if (!sections.length) return null;
    return (
        <nav
            aria-label="Sections in this discussion"
            className="-mx-4 mt-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden"
        >
            <div className="flex gap-x-5">
                {sections.map(s => {
                    const active = activeKey === s.key;
                    return (
                        <button
                            key={s.key}
                            type="button"
                            onClick={() => onJump(s.key)}
                            aria-current={active ? 'true' : undefined}
                            className={cn(
                                'shrink-0 border-b-2 py-2 text-sm whitespace-nowrap transition-colors outline-none focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50',
                                active
                                    // No weight change: the scrollspy flips this
                                    // as you read, and the row must not jitter.
                                    ? 'border-brand text-foreground'
                                    : 'border-transparent text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {s.key}
                        </button>
                    );
                })}
            </div>
        </nav>
    );
}
