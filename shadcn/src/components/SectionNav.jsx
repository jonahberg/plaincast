import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export function SectionNav({ sections, activeKey, onJump }) {
    if (!sections.length) return null;
    return (
        <nav
            aria-label="Sections in this discussion"
            className="sticky top-0 z-40 -mx-5 mb-8 overflow-x-auto border-y bg-background px-5 py-2 sm:mx-0 sm:px-0"
        >
            <div className="flex gap-2">
                {sections.map(s => (
                    <Button
                        key={s.key}
                        variant="outline"
                        size="pill"
                        onClick={() => onJump(s.key)}
                        aria-current={activeKey === s.key ? 'true' : undefined}
                        className={cn(
                            'shrink-0 font-normal text-muted-foreground',
                            activeKey === s.key && 'border-primary bg-teal-muted text-primary hover:text-primary'
                        )}
                    >
                        {s.key}
                    </Button>
                ))}
            </div>
        </nav>
    );
}
