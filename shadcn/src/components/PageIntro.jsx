import { useMemo } from 'react';
import { Rss } from 'lucide-react';

import { OFFICE_COORDS, OFFICE_NAMES, OFFICE_TIMEZONES } from '@data/offices.js';
import { confidenceScore, confidenceWord } from '@data/timeline.js';
import { moonPhase, sunTimes } from '@/lib/almanac';
import { officeFeedHref } from '@/lib/seo';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { readingOrNull, timeAgo } from '@/lib/format';

// Confidence is a word, with a small neutral dot whose fill steps through
// foreground opacities — never a meter, never the destructive red (a low
// score is the forecaster being candid, not an error).
const CONF_DOT = {
    High: 'bg-foreground',
    Moderate: 'bg-foreground/60',
    Mixed: 'bg-foreground/30',
    Low: 'bg-transparent',
};

function sinceText(iso, tz) {
    if (!iso) return 'the last update';
    try {
        const t = new Date(iso).toLocaleString('en-US', { hour: 'numeric', timeZone: tz });
        return `the ${t} update`;
    } catch (e) {
        return 'the last update';
    }
}

// The almanac strip: sun + moon computed client-side, live conditions from
// /api/conditions when the deployed functions are reachable. A typeset
// ledger: one hairline-ruled row on desktop, a 3-column grid on phones.
function Almanac({ office, conditions }) {
    const tz = OFFICE_TIMEZONES[office];
    const cells = useMemo(() => {
        const out = [];
        // null/undefined mean "no reading" (+null would render as 0°).
        const temp = readingOrNull(conditions?.temp);
        const normal = readingOrNull(conditions?.normal);
        if (temp !== null) {
            out.push({ label: 'Now', value: `${temp}°` });
        }
        if (normal !== null) {
            out.push({ label: 'Normal high', value: `${normal}°` });
        }
        const coords = OFFICE_COORDS[office];
        if (coords) {
            const s = sunTimes(coords[0], coords[1], new Date());
            if (s) {
                const fmt = d => d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
                const mins = Math.round((s.sunset - s.sunrise) / 60000);
                out.push({ label: 'Sunrise', value: fmt(s.sunrise) });
                out.push({ label: 'Sunset', value: fmt(s.sunset) });
                if (mins > 0 && mins < 1440) {
                    out.push({ label: 'Daylight', value: `${Math.floor(mins / 60)}h ${mins % 60}m` });
                }
            }
        }
        const m = moonPhase(new Date());
        out.push({ label: 'Moon', value: m.name });
        return out;
    }, [office, conditions, tz]);

    if (!cells.length) return null;
    return (
        <dl
            className={cn(
                'mt-8 grid grid-cols-3 border-y text-[13px] leading-5 [&>div]:py-2.5 [&>div]:pr-3',
                // Phones: a 3-column grid, hairlines between columns and rows.
                '[&>div:not(:nth-child(3n+1))]:border-l [&>div:not(:nth-child(3n+1))]:pl-3 [&>div:nth-child(n+4)]:border-t',
                // sm+: one row of equal cells, hairlines between them.
                'sm:auto-cols-auto sm:grid-flow-col sm:grid-cols-none sm:[&>div]:pr-4 sm:[&>div:last-child]:pr-0',
                'sm:[&>div:not(:first-child)]:border-l sm:[&>div:not(:first-child)]:pl-4 sm:[&>div:nth-child(n+4)]:border-t-0'
            )}
            aria-label="Current conditions and almanac"
        >
            {cells.map(({ label, value }) => (
                <div key={label} className="min-w-0">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="font-medium tabular-nums sm:whitespace-nowrap">{value}</dd>
                </div>
            ))}
        </dl>
    );
}

export function PageIntro({
    office, takeawayHTML, takeawayFromMessages, forecaster, issueLine, fullText, conditions,
    changelog, editions, currentEditionId, onSelectEdition, viewingHistorical,
    changelogHref, onOpenChangelog,
}) {
    const tz = OFFICE_TIMEZONES[office];
    const score = confidenceScore(fullText);
    const label = confidenceWord(score);
    const takeawayIsList = takeawayHTML.includes('class="takeaway-list"');
    const since = changelog && !viewingHistorical ? changelog : null;

    // The meta line: one wrapping row of sans facts, `·`-separated.
    const meta = [];
    if (issueLine) meta.push(<span key="issued">{issueLine}</span>);
    if (forecaster) meta.push(<span key="forecaster">Forecaster: {forecaster}</span>);
    if (label) {
        meta.push(
            <Tooltip key="confidence">
                <TooltipTrigger asChild>
                    <span
                        role="img"
                        tabIndex={0}
                        aria-label={`Forecaster confidence: ${label}`}
                        className="inline-flex cursor-default items-center gap-1.5 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                        <span
                            aria-hidden="true"
                            className={cn('size-2 shrink-0 rounded-full border border-foreground/70', CONF_DOT[label])}
                        />
                        Confidence: {label.toLowerCase()}
                    </span>
                </TooltipTrigger>
                <TooltipContent>
                    Read from the forecaster's own confidence language — score {score}%
                </TooltipContent>
            </Tooltip>
        );
    }
    if (editions.length > 1) {
        meta.push(
            // A deep-linked edition older than the NWS retention window isn't
            // in the list — show it as "Archived", never as Latest. Always
            // controlled: '' (no matching item) shows the placeholder instead
            // of flipping to uncontrolled.
            <Select
                key="edition"
                value={!currentEditionId || editions.some(e => e.id === currentEditionId)
                    ? (currentEditionId || editions[0].id)
                    : ''}
                onValueChange={onSelectEdition}
            >
                <SelectTrigger
                    size="sm"
                    className="h-auto gap-1 rounded-sm border-none bg-transparent p-0 text-[13px] text-muted-foreground shadow-none hover:text-foreground dark:bg-transparent dark:hover:bg-transparent"
                    aria-label="Forecast edition"
                >
                    <SelectValue placeholder="Archived edition" />
                </SelectTrigger>
                <SelectContent>
                    {editions.map((item, i) => (
                        <SelectItem key={item.id} value={item.id}>
                            {i === 0
                                ? 'Latest edition'
                                : `${item.time.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz })} (${timeAgo(item.time)})`}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        );
    }

    const links = (
        <p className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] leading-5', since ? 'mt-2' : 'mt-4')}>
            <a
                href={changelogHref}
                onClick={onOpenChangelog}
                className="font-medium text-brand underline decoration-brand/40 underline-offset-4 hover:decoration-brand"
            >
                See every revision
            </a>
            <a
                href={officeFeedHref(office)}
                className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                type="application/rss+xml"
            >
                <Rss className="size-3" aria-hidden="true" />
                RSS feed for {OFFICE_NAMES[office]}
            </a>
        </p>
    );

    return (
        <section className="pb-2">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                <span className="text-balance">Area Forecast Discussion · NWS {OFFICE_NAMES[office]} ({office})</span>
                {viewingHistorical && (
                    <Badge variant="outline" className="normal-case tracking-normal">Archived edition</Badge>
                )}
            </p>
            <h1 className="mt-3 font-serif text-[2rem] leading-[1.1] font-semibold tracking-[-0.02em] text-balance sm:text-[2.5rem]">
                {OFFICE_NAMES[office]} <span className="font-normal text-muted-foreground">({office})</span>
            </h1>

            {takeawayHTML && (
                <div className="mt-6">
                    <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                        {takeawayFromMessages ? 'Key messages' : 'Key takeaway'}
                    </p>
                    <div
                        className={cn('takeaway-lede mt-2', takeawayIsList && 'is-list')}
                        dangerouslySetInnerHTML={{ __html: takeawayHTML }}
                    />
                </div>
            )}

            {meta.length > 0 && (
                // Every item carries its `·` in the 1rem gap to its left; the
                // row is pulled 1rem left inside an overflow-hidden frame, so
                // whichever item starts a line has its separator clipped — no
                // stray dot at a line start, at any width. (The frame's 4px
                // inset keeps focus rings visible.)
                <div className="-mx-1 mt-5 overflow-hidden px-1 py-1">
                    <div className="-ml-4 flex flex-wrap items-center gap-y-1 text-[13px] leading-5 text-muted-foreground">
                        {meta.map(item => (
                            <div key={item.key} className="relative flex items-center pl-4">
                                <span aria-hidden="true" className="absolute left-1.5">·</span>
                                {item}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {since ? (
                <div className="mt-6 border-l-2 border-brand pl-4">
                    <p className="max-w-[68ch] font-serif text-[1.0625rem] leading-[1.6] text-pretty">
                        <span className="font-semibold">Since {sinceText(since.since, tz)}:</span>{' '}
                        {since.changelog}
                    </p>
                    {links}
                </div>
            ) : links}

            <Almanac office={office} conditions={conditions} />
        </section>
    );
}
