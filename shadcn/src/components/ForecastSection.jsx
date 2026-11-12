import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { OFFICE_TIMEZONES } from '@data/offices.js';
import { renderDiffHTML } from '@data/diff.js';
import { sectionDomId, translateToPlainEnglish } from '@/lib/afd';
import { mapTranslation, peekTranslation, postTranslation } from '@/lib/ai';
import { track } from '@/lib/track';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { JargonText } from '@/components/JargonText';

// One AFD section: a ruled block with Plain English / Original tabs, plus a
// "What changed" tab when this section differs from the previous edition.
//
// The plain tab's text, in order of preference:
//   1. A translation already in hand (the server embedded the edition's
//      translations — src/lib/boot.js): the FIRST render is the AI text with
//      "via Claude", so nothing swaps while the reader scrolls.
//   2. The edition's translation map (one shared, CDN-cached GET), requested
//      on mount and applied to every section it covers when it resolves.
//   3. Only for a section the map does not cover: the per-section POST (a
//      model call), lazily, when the section nears the viewport.
// Until then, and on any failure, the instant regex translation stands.
// Parent keys this component per edition, so state resets naturally on
// office/edition change.
export const ForecastSection = memo(function ForecastSection({
    section, office, productId, issuanceTime, aiEligible, diff, sectionRef,
}) {
    const tz = OFFICE_TIMEZONES[office] || 'America/Los_Angeles';
    const cardRef = useRef(null);
    // 'idle' until a request actually starts — "Summarizing…" must never
    // show with nothing in flight. 'done' from the first frame when the
    // translation is already in hand.
    const [ai, setAi] = useState(() => {
        const html = aiEligible ? peekTranslation(office, productId, section.key) : null;
        return html ? { status: 'done', html } : { status: aiEligible ? 'idle' : 'off', html: null };
    });
    const aiRef = useRef(ai);
    aiRef.current = ai;

    const plainHTML = useMemo(
        () => translateToPlainEnglish(section.text, tz, issuanceTime),
        [section.text, tz, issuanceTime]
    );

    useEffect(() => {
        if (!aiEligible || aiRef.current.status === 'done') return;
        let cancelled = false;
        let observer = null;

        // The per-section POST, lazily: one model call per section, so only
        // once this section nears the viewport.
        const lazyPost = () => {
            const start = () => {
                setAi({ status: 'pending', html: null });
                postTranslation(section, office, issuanceTime).then(html => {
                    if (cancelled) return;
                    if (!html) track('ai-translate-fail', { office, section: section.key });
                    setAi(html ? { status: 'done', html } : { status: 'failed', html: null });
                });
            };
            const el = cardRef.current;
            if (!el || !('IntersectionObserver' in window)) {
                start();
                return;
            }
            observer = new IntersectionObserver((entries) => {
                if (!entries.some(e => e.isIntersecting)) return;
                observer.disconnect();
                start();
            }, { rootMargin: '200px' });
            observer.observe(el);
        };

        if (!productId) {
            lazyPost();
        } else {
            // The edition's map, now: one shared request for every section.
            setAi({ status: 'pending', html: null });
            mapTranslation(section, office, productId).then(html => {
                if (cancelled) return;
                if (html) {
                    setAi({ status: 'done', html });
                } else {
                    setAi({ status: 'idle', html: null });
                    lazyPost();
                }
            });
        }
        return () => { cancelled = true; observer?.disconnect(); };
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
                    {/* On touch screens a wrapped "via Claude" line sits a full
                        44px target below the tabs (row gap applies only when
                        it wraps). */}
                    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 pointer-coarse:gap-y-5 sm:shrink-0 sm:flex-nowrap">
                        <TabsList className="h-auto min-h-8 max-w-full flex-wrap p-[2px]">
                            <TabsTrigger value="plain" className="tap-target px-2.5 py-1 text-[13px]">Plain English</TabsTrigger>
                            <TabsTrigger value="original" className="tap-target px-2.5 py-1 text-[13px]">Original</TabsTrigger>
                            {changed && <TabsTrigger value="diff" className="tap-target px-2.5 py-1 text-[13px]">What changed</TabsTrigger>}
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
                                            className="tap-target underline underline-offset-2 hover:text-foreground"
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
