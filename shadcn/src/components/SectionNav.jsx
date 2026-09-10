import { Button } from '@/components/ui/button';

export function SectionNav({ sections, activeKey, onJump }) {
    if (!sections.length) return null;
    return (
        <nav aria-label="Sections in this discussion" className="mb-6 overflow-x-auto">
            <div className="flex gap-1">
                {sections.map(s => (
                    <Button
                        key={s.key}
                        variant={activeKey === s.key ? 'secondary' : 'ghost'}
                        size="sm"
                        onClick={() => onJump(s.key)}
                        aria-current={activeKey === s.key ? 'true' : undefined}
                        className="shrink-0"
                    >
                        {s.key}
                    </Button>
                ))}
            </div>
        </nav>
    );
}
