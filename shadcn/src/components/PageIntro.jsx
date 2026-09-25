import { useMemo } from 'react';
import { History, Lightbulb, ListTree, Moon, Rss, Sunrise, Sunset, Thermometer } from 'lucide-react';

import { OFFICE_COORDS, OFFICE_NAMES, OFFICE_TIMEZONES } from '@data/offices.js';
import { confidenceScore, confidenceWord } from '@data/timeline.js';
import { moonPhase, sunTimes } from '@/lib/almanac';
import { officeFeedHref } from '@/lib/seo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { readingOrNull, timeAgo } from '@/lib/format';

const CONF_BAR = {
    High: 'bg-chart-2',
    Moderate: 'bg-chart-2',
    Mixed: 'bg-chart-5',
    Low: 'bg-destructive',
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
// /api/conditions when the deployed functions are reachable.
function Almanac({ office, conditions }) {
    const tz = OFFICE_TIMEZONES[office];
    const cells = useMemo(() => {
        const out = [];
        // null/undefined mean "no reading" (+null would render as 0°).
        const temp = readingOrNull(conditions?.temp);
        const normal = readingOrNull(conditions?.normal);
        if (temp !== null) {
            out.push({ Icon: Thermometer, label: 'Now', value: `${temp}°` });
        }
        if (normal !== null) {
            out.push({ Icon: Thermometer, label: 'Normal high', value: `${normal}°` });
        }
        const coords = OFFICE_COORDS[office];
        if (coords) {
            const s = sunTimes(coords[0], coords[1], new Date());
            if (s) {
                const fmt = d => d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
                const mins = Math.round((s.sunset - s.sunrise) / 60000);
                out.push({ Icon: Sunrise, label: 'Sunrise', value: fmt(s.sunrise) });
                out.push({ Icon: Sunset, label: 'Sunset', value: fmt(s.sunset) });
                if (mins > 0 && mins < 1440) {
                    out.push({ label: 'Daylight', value: `${Math.floor(mins / 60)}h ${mins % 60}m` });
                }
            }
        }
        const m = moonPhase(new Date());
        out.push({ Icon: Moon, label: 'Moon', value: m.name });
        return out;
    }, [office, conditions, tz]);

    if (!cells.length) return null;
    return (
        <dl className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border px-4 py-2.5 text-sm"
            aria-label="Current conditions and almanac">
            {cells.map(({ Icon, label, value }) => (
                <div key={label} className="flex items-center gap-1.5">
                    {Icon && <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />}
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="font-medium tabular-nums">{value}</dd>
                </div>
            ))}
        </dl>
    );
}

export function PageIntro({
    office, takeawayHTML, forecaster, issueLine, fullText, conditions,
    changelog, editions, currentEditionId, onSelectEdition, viewingHistorical,
    changelogHref, onOpenChangelog,
}) {
    const tz = OFFICE_TIMEZONES[office];
    const score = confidenceScore(fullText);
    const label = confidenceWord(score);

    return (
        <section className="mb-8">
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
                {OFFICE_NAMES[office]} <span className="text-muted-foreground">({office})</span>
                {viewingHistorical && <Badge variant="outline">Archived edition</Badge>}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
                Area Forecast Discussion — the National Weather Service forecast, decoded into plain English.
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
                {issueLine && <span>{issueLine}</span>}
                {forecaster && <span>Forecaster: {forecaster}</span>}
                {label && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span className="inline-flex cursor-default items-center gap-2">
                                <span>Confidence</span>
                                <Progress
                                    value={score}
                                    indicatorClassName={CONF_BAR[label]}
                                    className="w-20"
                                    aria-label={`Forecaster confidence: ${label}`}
                                />
                                <Badge variant={label === 'Low' ? 'destructive' : 'secondary'}>{label}</Badge>
                            </span>
                        </TooltipTrigger>
                        <TooltipContent>
                            Read from the forecaster's own confidence language — score {score}%
                        </TooltipContent>
                    </Tooltip>
                )}
                {editions.length > 1 && (
                    <span className="inline-flex items-center gap-1.5">
                        <History className="size-3.5" aria-hidden="true" />
                        {/* A deep-linked edition older than the NWS retention window
                            isn't in the list — show it as "Archived", never as Latest. */}
                        {/* Always controlled: '' (no matching item) shows the
                            placeholder instead of flipping to uncontrolled. */}
                        <Select
                            value={!currentEditionId || editions.some(e => e.id === currentEditionId)
                                ? (currentEditionId || editions[0].id)
                                : ''}
                            onValueChange={onSelectEdition}
                        >
                            <SelectTrigger size="sm" className="h-7 gap-1 border-none px-1 text-sm shadow-none" aria-label="Forecast edition">
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
                    </span>
                )}
            </div>

            <Almanac office={office} conditions={conditions} />

            {takeawayHTML && (
                <Alert className="mt-5">
                    <Lightbulb />
                    <AlertTitle>Key takeaway</AlertTitle>
                    <AlertDescription>
                        <div dangerouslySetInnerHTML={{ __html: takeawayHTML }} />
                    </AlertDescription>
                </Alert>
            )}

            {changelog && !viewingHistorical && (
                <p className="mt-3 text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">Since {sinceText(changelog.since, tz)}:</span>{' '}
                    {changelog.changelog}
                </p>
            )}

            <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <a
                    href={changelogHref}
                    onClick={onOpenChangelog}
                    className="inline-flex items-center gap-1.5 font-medium underline-offset-4 hover:underline"
                >
                    <ListTree className="size-3.5" aria-hidden="true" />
                    See every revision
                </a>
                <a
                    href={officeFeedHref(office)}
                    className="inline-flex items-center gap-1.5 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    type="application/rss+xml"
                >
                    <Rss className="size-3.5" aria-hidden="true" />
                    RSS feed for {OFFICE_NAMES[office]}
                </a>
            </p>
        </section>
    );
}
