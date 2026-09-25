import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';

import { OFFICE_NAMES, OFFICE_TIMEZONES } from '@data/offices.js';
import { computeDiff, renderDiffHTML } from '@data/diff.js';
import { buildTimelineEntries } from '@data/timeline.js';
import { parseSections } from '@/lib/afd';
import { fetchAFDList, fetchProduct, historyItems } from '@/lib/nws';
import { editionName, localHour } from '@/lib/format';
import { track } from '@/lib/track';
import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from '@/components/ui/accordion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// ─── The edition ledger (?view=changelog) ───────────────────────────
// Reverse-chronological record of every retained issuance: what each
// revision changed, in the forecaster's own confidence language, with the
// full text diff one fold away. Port of the vanilla client's
// showChangelogView (docs/js/app.js); the data layer is shared
// (docs/js/timeline.js + diff.js).

const BATCH = 8;      // pairs per page (BATCH + 1 product fetches)
const LOOKBACK = 40;  // list metadata to page through (~1 week)

// POSITIONAL results — a failed fetch stays null so pagination indices never
// drift (buildTimelineEntries pairs across the gap).
async function fetchProducts(items) {
    return Promise.all(items.map(async (item) => {
        try {
            const prod = await fetchProduct(item.url);
            return typeof prod.productText === 'string'
                ? { id: item.id, time: item.time, text: prod.productText }
                : null;
        } catch (e) { return null; }
    }));
}

function dateline(time, tz) {
    return {
        date: time.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz }),
        clock: time.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }),
        edition: editionName(localHour(time, tz)),
    };
}

function confidenceSentence(conf) {
    if (!conf || !conf.word) return '';
    const w = conf.word.toLowerCase();
    if (conf.direction === 'rising') return `Confidence rising — now ${w}.`;
    if (conf.direction === 'falling') return `Confidence slipping — now ${w}.`;
    if (conf.direction === 'steady') return `Confidence ${w}, holding steady.`;
    return `Confidence ${w}.`;
}

// Per-entry AI summary from /api/changelog?id=, fetched when the entry nears
// the viewport. Soft-fails to nothing — the revised-sections line and the
// diff still describe the entry.
function EntrySummary({ office, id }) {
    const ref = useRef(null);
    const [state, setState] = useState({ status: 'idle', text: '' });

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        let cancelled = false;
        const run = async () => {
            setState({ status: 'loading', text: '' });
            try {
                const res = await fetch(`/api/changelog?office=${encodeURIComponent(office)}&id=${encodeURIComponent(id)}`);
                if (!res.ok) throw new Error('changelog fetch failed');
                const data = await res.json();
                if (cancelled) return;
                if (data && data.changelog) setState({ status: 'done', text: data.changelog });
                else if (data && data.transient) setState({ status: 'failed', text: '' }); // not a "nothing changed" verdict
                else setState({ status: 'quiet', text: 'Minor refinements — timing and wording, no headline change.' });
            } catch (e) {
                if (!cancelled) setState({ status: 'failed', text: '' });
            }
        };
        if (!('IntersectionObserver' in window)) { run(); return () => { cancelled = true; }; }
        const io = new IntersectionObserver((ents) => {
            if (!ents.some(e => e.isIntersecting)) return;
            io.disconnect();
            run();
        }, { rootMargin: '300px' });
        io.observe(el);
        return () => { cancelled = true; io.disconnect(); };
    }, [office, id]);

    return (
        <div ref={ref}>
            {(state.status === 'idle' || state.status === 'loading') && (
                <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" aria-hidden="true" /> Summarizing…
                </p>
            )}
            {state.status === 'done' && <p className="text-sm leading-6">{state.text}</p>}
            {state.status === 'quiet' && <p className="text-sm text-muted-foreground">{state.text}</p>}
        </div>
    );
}

function Entry({ entry, office, tz, isLatest, onOpenEdition }) {
    const dl = dateline(entry.time, tz);
    const href = isLatest ? `/o/${office}/` : `/o/${office}/?edition=${encodeURIComponent(entry.id)}`;
    const conf = confidenceSentence(entry.confidence);
    return (
        <Card className="gap-4">
            <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base">
                    <h2 className="contents">
                        <span>{dl.date}</span>
                        <span className="text-muted-foreground" aria-hidden="true">·</span>
                        <span className="font-normal text-muted-foreground">{dl.clock}</span>
                    </h2>
                    <Badge variant="secondary">{dl.edition} edition</Badge>
                    {isLatest && <Badge variant="outline">Latest</Badge>}
                </CardTitle>
                <CardDescription>
                    {entry.changedKeys.length
                        ? `Revised: ${entry.changedKeys.join(', ')}.`
                        : 'No substantive revisions.'}
                    {conf && <> {conf}</>}
                    {entry.forecaster && <> — {entry.forecaster}</>}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                {entry.changedKeys.length
                    ? <EntrySummary office={office} id={entry.id} />
                    : <p className="text-sm text-muted-foreground">The forecast carried forward unchanged.</p>}
                {entry.changed.length > 0 && (
                    <Accordion type="single" collapsible>
                        <AccordionItem value="diff" className="border-b-0">
                            <AccordionTrigger className="py-2 text-sm">Compare the text</AccordionTrigger>
                            <AccordionContent>
                                <div className="space-y-4">
                                    {entry.changed.map(d => (
                                        <div key={d.key}>
                                            <h3 className="mb-2 text-sm font-semibold">{d.key}</h3>
                                            <div
                                                className="diff-prose font-mono text-xs leading-6"
                                                dangerouslySetInnerHTML={{ __html: renderDiffHTML(d) }}
                                            />
                                        </div>
                                    ))}
                                </div>
                            </AccordionContent>
                        </AccordionItem>
                    </Accordion>
                )}
            </CardContent>
            <CardFooter>
                <a
                    href={href}
                    onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                        e.preventDefault();
                        onOpenEdition(isLatest ? null : entry.id);
                    }}
                    className="text-sm font-medium underline underline-offset-4"
                >
                    Read this edition
                </a>
            </CardFooter>
        </Card>
    );
}

export function ChangelogView({ office, onOpenEdition, onBack, announce }) {
    const tz = OFFICE_TIMEZONES[office] || 'America/Los_Angeles';
    const name = OFFICE_NAMES[office] || office;
    const [state, setState] = useState({ status: 'loading' });
    const [attempt, setAttempt] = useState(0);
    // Pagination bookkeeping outside render state (mutated by loadMore).
    const data = useRef({ items: [], products: [] });

    useEffect(() => {
        let cancelled = false;
        setState({ status: 'loading' });
        (async () => {
            try {
                const graph = await fetchAFDList(office);
                const items = historyItems(graph, LOOKBACK);
                const products = await fetchProducts(items.slice(0, BATCH + 1));
                if (cancelled) return;
                data.current = { items, products };
                const entries = buildTimelineEntries(products, { parseSections, computeDiff });
                setState({ status: 'ready', entries, more: items.length > products.length, loadingMore: false });
                announce?.(`Forecast changelog for ${name}`);
            } catch (e) {
                if (cancelled) return;
                console.error('Changelog view failed:', e);
                track('changelog-view-fail', { office });
                setState({ status: 'error', message: e?.message || String(e) });
            }
        })();
        return () => { cancelled = true; };
    }, [office, name, attempt, announce]);

    const loadMore = useCallback(async () => {
        setState(s => ({ ...s, loadingMore: true }));
        const { items, products } = data.current;
        const next = items.slice(products.length, products.length + BATCH);
        if (!next.length) { setState(s => ({ ...s, more: false, loadingMore: false })); return; }
        const fetched = await fetchProducts(next);
        if (data.current.items !== items) return; // office changed mid-fetch
        // The last already-fetched product heads the new pairs.
        const overlapFrom = products.length - 1;
        const all = products.concat(fetched);
        data.current = { items, products: all };
        const added = buildTimelineEntries(all.slice(overlapFrom), { parseSections, computeDiff });
        setState(s => ({
            ...s,
            entries: s.entries.concat(added),
            more: all.length < items.length,
            loadingMore: false,
        }));
    }, []);

    const latestId = data.current.items[0]?.id;

    return (
        <section aria-labelledby="changelog-title">
            <div className="mb-6">
                <a
                    href={`/o/${office}/`}
                    onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                        e.preventDefault();
                        onBack();
                    }}
                    className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                    <ArrowLeft className="size-3.5" aria-hidden="true" />
                    Back to the forecast
                </a>
                <h1 id="changelog-title" className="mt-3 text-2xl font-semibold tracking-tight">
                    Forecast changelog — {name} <span className="text-muted-foreground">({office})</span>
                </h1>
                <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                    Every revision to the {name} forecast, newest first — what changed with each update,
                    and whether the forecasters' confidence rose or fell.
                </p>
            </div>

            {state.status === 'loading' && (
                <div aria-busy="true" aria-label="Loading the changelog" className="space-y-4">
                    {[0, 1, 2].map(i => (
                        <div key={i} className="space-y-3 rounded-lg border p-6">
                            <Skeleton className="h-5 w-72 max-w-full" />
                            <Skeleton className="h-4 w-full" />
                            <Skeleton className="h-4 w-2/3" />
                        </div>
                    ))}
                </div>
            )}

            {state.status === 'error' && (
                <Alert variant="destructive">
                    <AlertTitle>Couldn't load the changelog</AlertTitle>
                    <AlertDescription>
                        <p>{state.message}</p>
                        <Button variant="outline" size="sm" className="mt-2" onClick={() => setAttempt(a => a + 1)}>
                            Try again
                        </Button>
                    </AlertDescription>
                </Alert>
            )}

            {state.status === 'ready' && (
                <div className="space-y-4">
                    {state.entries.length === 0 && (
                        <p className="text-sm text-muted-foreground">
                            The archive is thin right now — check back after the next update.
                        </p>
                    )}
                    {state.entries.map(entry => (
                        <Entry
                            key={entry.id}
                            entry={entry}
                            office={office}
                            tz={tz}
                            isLatest={entry.id === latestId}
                            onOpenEdition={onOpenEdition}
                        />
                    ))}
                    {state.more && (
                        <div className="flex justify-center pt-2">
                            <Button variant="outline" onClick={loadMore} disabled={state.loadingMore}>
                                {state.loadingMore && <Loader2 className="animate-spin" aria-hidden="true" />}
                                Earlier editions
                            </Button>
                        </div>
                    )}
                </div>
            )}
        </section>
    );
}
