import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { OFFICE_TIMEZONES } from '@data/offices.js';
import { renderDiffHTML } from '@data/diff.js';
import { sectionDomId, translateToPlainEnglish } from '@/lib/afd';
import { translateSection } from '@/lib/ai';
import { track } from '@/lib/track';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { JargonText } from '@/components/JargonText';

// One AFD section: a ruled block with Plain English / Original tabs, plus a
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
    // 'idle' until the request actually starts (the card scrolls near the
    // viewport) — "Summarizing…" must never show with nothing in flight.
    const [ai, setAi] = useState({ status: aiEligible ? 'idle' : 'off', html: null });

    const plainHTML = useMemo(
        () => translateToPlainEnglish(section.text, tz, issuanceTime),
        [section.text, tz, issuanceTime]
    );

    useEffect(() => {
        if (!aiEligible) return;
        const el = cardRef.current;
        if (!el) return;
        let cancelled = false;
        const start = () => {
            setAi({ status: 'pending', html: null });
            translateSection(section, office, productId, issuanceTime).then(html => {
                if (cancelled) return;
                if (!html) track('ai-translate-fail', { office, section: section.key });
                setAi(html ? { status: 'done', html } : { status: 'failed', html: null });
            });
        };
        if (!('IntersectionObserver' in window)) {
            start();
            return () => { cancelled = true; };
        }
        const observer = new IntersectionObserver((entries) => {
            if (!entries.some(e => e.isIntersecting)) return;
            observer.disconnect();
            start();
        }, { rootMargin: '200px' });
        observer.observe(el);
        return () => { cancelled = true; observer.disconnect(); };
    }, [aiEligible, section, office, productId, issuanceTime]);

    const changed = diff && (diff.status === 'changed' || diff.status === 'added');
    const diffHTML = useMemo(
        () => (changed ? renderDiffHTML(diff) : null),
        [changed, diff]
    );

    // An editorial block, not a card: a hairline rule, the serif title, and
    // on the same row (under it on phones) the quiet tab control plus the AI
    // attribution. The Tabs root wraps the title row so the list and the
    // panels stay one Radix tree.
    return (
        <section
            ref={(el) => { cardRef.current = el; sectionRef(el); }}
            id={sectionDomId(section.key)}
            className="scroll-mt-20 border-t py-10"
        >
            <Tabs defaultValue="plain" className="gap-0">
                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                    {/* min-w-0 + wrap: at 320px a long title + "Updated" badge
                        must wrap, never push past the viewport. */}
                    <h2 className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-serif text-2xl leading-tight font-semibold tracking-[-0.015em] break-words">
                        {section.key}
                        {changed && (
                            <Badge variant="secondary" className="font-sans tracking-normal">
                                {diff.status === 'added' ? 'New this edition' : 'Updated'}
                            </Badge>
                        )}
                    </h2>
                    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 sm:shrink-0 sm:flex-nowrap">
                        <TabsList className="h-auto min-h-8 max-w-full flex-wrap p-[2px]">
                            <TabsTrigger value="plain" className="px-2.5 py-1 text-[13px]">Plain English</TabsTrigger>
                            <TabsTrigger value="original" className="px-2.5 py-1 text-[13px]">Original</TabsTrigger>
                            {changed && <TabsTrigger value="diff" className="px-2.5 py-1 text-[13px]">What changed</TabsTrigger>}
                        </TabsList>
                        {/* Beside the Plain English tab it credits (before the
                            tabs at sm+, after them on phones). Fixed width:
                            "Summarizing…" → "via Claude" must not shift the
                            tabs. */}
                        {ai.status !== 'off' && (
                            <span className="w-[5.75rem] whitespace-nowrap text-xs text-muted-foreground sm:order-first sm:text-right">
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
                            </span>
                        )}
                    </div>
                </div>
                <TabsContent value="plain" className="mt-5">
                    <div
                        className="plain-prose"
                        dangerouslySetInnerHTML={{ __html: ai.html || plainHTML }}
                    />
                </TabsContent>
                <TabsContent value="original" className="mt-5">
                    <JargonText text={section.text} />
                </TabsContent>
                {changed && (
                    <TabsContent value="diff" className="mt-5">
                        <p className="mb-3 text-xs text-muted-foreground">
                            Compared with the previous edition — <span className="diff-added rounded-sm px-1">added</span>{' '}
                            and <span className="diff-removed rounded-sm px-1">removed</span> paragraphs.
                        </p>
                        <div
                            className="diff-prose font-mono text-[13px] leading-[1.6]"
                            dangerouslySetInnerHTML={{ __html: diffHTML }}
                        />
                    </TabsContent>
                )}
            </Tabs>
        </section>
    );
});
