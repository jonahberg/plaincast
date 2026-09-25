import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { OFFICE_TIMEZONES } from '@data/offices.js';
import { renderDiffHTML } from '@data/diff.js';
import { sectionDomId, translateToPlainEnglish } from '@/lib/afd';
import { translateSection } from '@/lib/ai';
import { track } from '@/lib/track';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { JargonText } from '@/components/JargonText';

// One AFD section: a Card with Plain English / Original tabs, plus a
// "What changed" tab when this section differs from the previous edition.
// The plain tab shows the instant regex translation, then upgrades to the
// AI translation lazily when the card scrolls into view (same
// IntersectionObserver pattern as the vanilla client). Parent keys this
// component per edition, so state resets naturally on office/edition change.
export const ForecastSection = memo(function ForecastSection({
    section, office, productId, issuanceTime, aiEligible, diff, sectionRef,
}) {
    const tz = OFFICE_TIMEZONES[office] || 'America/Los_Angeles';
    const cardRef = useRef(null);
    const [ai, setAi] = useState({ status: aiEligible ? 'pending' : 'off', html: null });

    const plainHTML = useMemo(
        () => translateToPlainEnglish(section.text, tz),
        [section.text, tz]
    );

    useEffect(() => {
        if (!aiEligible) return;
        const el = cardRef.current;
        if (!el || !('IntersectionObserver' in window)) return;
        let cancelled = false;
        const observer = new IntersectionObserver((entries) => {
            if (!entries.some(e => e.isIntersecting)) return;
            observer.disconnect();
            translateSection(section, office, productId, issuanceTime).then(html => {
                if (cancelled) return;
                if (!html) track('ai-translate-fail', { office, section: section.key });
                setAi(html ? { status: 'done', html } : { status: 'failed', html: null });
            });
        }, { rootMargin: '200px' });
        observer.observe(el);
        return () => { cancelled = true; observer.disconnect(); };
    }, [aiEligible, section, office, productId, issuanceTime]);

    const changed = diff && (diff.status === 'changed' || diff.status === 'added');
    const diffHTML = useMemo(
        () => (changed ? renderDiffHTML(diff) : null),
        [changed, diff]
    );

    return (
        <section
            ref={(el) => { cardRef.current = el; sectionRef(el); }}
            id={sectionDomId(section.key)}
            className="scroll-mt-20"
        >
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        {section.key}
                        {changed && (
                            <Badge variant="secondary">
                                {diff.status === 'added' ? 'New this edition' : 'Updated'}
                            </Badge>
                        )}
                    </CardTitle>
                    <CardAction className="text-xs text-muted-foreground">
                        {ai.status === 'pending' && (
                            <span className="inline-flex items-center gap-1">
                                <Loader2 className="size-3 animate-spin" aria-hidden="true" /> Summarizing…
                            </span>
                        )}
                        {ai.status === 'done' && (
                            <span>
                                via{' '}
                                <a
                                    className="underline underline-offset-2 hover:text-foreground"
                                    href="https://www.anthropic.com/claude/haiku"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    Claude
                                </a>
                            </span>
                        )}
                    </CardAction>
                </CardHeader>
                <CardContent>
                    <Tabs defaultValue="plain">
                        <TabsList className="h-auto max-w-full flex-wrap">
                            <TabsTrigger value="plain">Plain English</TabsTrigger>
                            <TabsTrigger value="original">Original</TabsTrigger>
                            {changed && <TabsTrigger value="diff">What changed</TabsTrigger>}
                        </TabsList>
                        <TabsContent value="plain">
                            <div
                                className="plain-prose pt-2"
                                dangerouslySetInnerHTML={{ __html: ai.html || plainHTML }}
                            />
                        </TabsContent>
                        <TabsContent value="original">
                            <div className="pt-2">
                                <JargonText text={section.text} />
                            </div>
                        </TabsContent>
                        {changed && (
                            <TabsContent value="diff">
                                <div className="pt-2">
                                    <p className="mb-3 text-xs text-muted-foreground">
                                        Compared with the previous edition — <span className="diff-added rounded-sm px-1">added</span>{' '}
                                        and <span className="diff-removed rounded-sm px-1">removed</span> paragraphs.
                                    </p>
                                    <div
                                        className="diff-prose font-mono text-xs leading-6"
                                        dangerouslySetInnerHTML={{ __html: diffHTML }}
                                    />
                                </div>
                            </TabsContent>
                        )}
                    </Tabs>
                </CardContent>
            </Card>
        </section>
    );
});
