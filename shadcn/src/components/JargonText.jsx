import { memo, useMemo, useState } from 'react';

import { annotateSegments } from '@/lib/afd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// One glossary term. The tooltip is controlled so a tap toggles it — Radix
// tooltips only open on hover/focus, which leaves touch devices with no way
// in (WCAG 1.4.13's dismiss-on-Escape comes free from Radix).
function JargonTerm({ text, tip }) {
    const [open, setOpen] = useState(false);
    return (
        <Tooltip open={open} onOpenChange={setOpen}>
            <TooltipTrigger asChild>
                <span
                    tabIndex={0}
                    role="button"
                    aria-label={`${text}: ${tip}`}
                    onClick={() => setOpen(o => !o)}
                    className="cursor-help underline decoration-dotted underline-offset-4"
                >
                    {text}
                </span>
            </TooltipTrigger>
            <TooltipContent>{tip}</TooltipContent>
        </Tooltip>
    );
}

// Raw AFD text with every glossary term wrapped in a tooltip.
export const JargonText = memo(function JargonText({ text }) {
    const segments = useMemo(() => annotateSegments(text), [text]);
    return (
        <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-4 font-mono text-xs leading-6">
            {segments.map((seg, i) =>
                seg.type === 'jargon' ? (
                    <JargonTerm key={i} text={seg.text} tip={seg.tip} />
                ) : (
                    <span key={i}>{seg.text}</span>
                )
            )}
        </pre>
    );
});
