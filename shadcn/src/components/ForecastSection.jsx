import { memo, useMemo } from 'react';

import { OFFICE_TIMEZONES } from '@data/offices.js';
import { annotateSegments, translateToPlainEnglish } from '@/lib/afd';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// Annotated AFD facsimile: raw text with glossary terms wrapped in shadcn
// Tooltips (the vanilla client's amber-underlined .jargon spans).
function AnnotatedText({ text }) {
    const segments = useMemo(() => annotateSegments(text), [text]);
    return (
        <pre className="whitespace-pre-wrap break-words font-mono text-[0.82rem] leading-[1.65] text-text-secondary">
            {segments.map((seg, i) =>
                seg.type === 'jargon' ? (
                    <Tooltip key={i}>
                        <TooltipTrigger asChild>
                            <span
                                tabIndex={0}
                                className="cursor-help rounded-xs bg-amber/12 border-b border-dashed border-amber text-foreground"
                            >
                                {seg.text}
                            </span>
                        </TooltipTrigger>
                        <TooltipContent>{seg.tip}</TooltipContent>
                    </Tooltip>
                ) : (
                    <span key={i}>{seg.text}</span>
                )
            )}
        </pre>
    );
}

export const ForecastSection = memo(function ForecastSection({ section, office, sectionRef }) {
    const tz = OFFICE_TIMEZONES[office] || 'America/Los_Angeles';
    const plainHTML = useMemo(
        () => translateToPlainEnglish(section.text, tz),
        [section.text, tz]
    );

    return (
        <section ref={sectionRef} id={`section-${section.key.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} className="mb-12 scroll-mt-16">
            <h2 className="mb-4 font-display text-2xl font-normal tracking-[-0.02em]">
                {section.key}
            </h2>
            <div className="grid gap-6 md:grid-cols-2 md:gap-10">
                <div>
                    <div className="mb-2 font-sans text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        In plain English
                    </div>
                    <div
                        className="plain-prose font-serif"
                        dangerouslySetInnerHTML={{ __html: plainHTML }}
                    />
                </div>
                <Card className="gap-3 bg-secondary py-4 shadow-none">
                    <CardHeader className="px-4">
                        <CardTitle className="font-sans text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                            The original — hover the highlights
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="px-4">
                        <AnnotatedText text={section.text} />
                    </CardContent>
                </Card>
            </div>
            <Separator className="mt-12" />
        </section>
    );
});
