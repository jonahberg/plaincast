import { memo, useMemo } from 'react';

import { OFFICE_TIMEZONES } from '@data/offices.js';
import { annotateSegments, translateToPlainEnglish } from '@/lib/afd';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// Annotated AFD original: raw text with glossary terms underlined and
// wrapped in Tooltips.
function AnnotatedText({ text }) {
    const segments = useMemo(() => annotateSegments(text), [text]);
    return (
        <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-4 font-mono text-xs leading-6">
            {segments.map((seg, i) =>
                seg.type === 'jargon' ? (
                    <Tooltip key={i}>
                        <TooltipTrigger asChild>
                            <span
                                tabIndex={0}
                                className="cursor-help underline decoration-dotted underline-offset-4"
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
        <section
            ref={sectionRef}
            id={`section-${section.key.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
            className="scroll-mt-20"
        >
            <Card>
                <CardHeader>
                    <CardTitle>{section.key}</CardTitle>
                    <CardDescription>
                        Translated automatically — switch tabs for the original NWS text with the jargon explained.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Tabs defaultValue="plain">
                        <TabsList>
                            <TabsTrigger value="plain">Plain English</TabsTrigger>
                            <TabsTrigger value="original">Original</TabsTrigger>
                        </TabsList>
                        <TabsContent value="plain">
                            <div
                                className="plain-prose pt-2"
                                dangerouslySetInnerHTML={{ __html: plainHTML }}
                            />
                        </TabsContent>
                        <TabsContent value="original">
                            <div className="pt-2">
                                <AnnotatedText text={section.text} />
                            </div>
                        </TabsContent>
                    </Tabs>
                </CardContent>
            </Card>
        </section>
    );
});
