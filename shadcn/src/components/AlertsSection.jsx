import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, Eye, Info, Loader2 } from 'lucide-react';

import { OFFICE_TIMEZONES } from '@data/offices.js';
import { alertWindow, classifyAlertKind, groupAlerts } from '@/lib/nws';
import { explainAlert } from '@/lib/ai';
import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const KIND_META = {
    warning: { label: 'Warning', badge: 'destructive', Icon: AlertTriangle },
    watch: { label: 'Watch', badge: 'default', Icon: Eye },
    advisory: { label: 'Advisory', badge: 'secondary', Icon: Info },
    statement: { label: 'Statement', badge: 'outline', Icon: Info },
};

function describe(groups, total, tz) {
    const now = Date.now();
    const upcoming = groups.filter(a => alertWindow(a, tz, now)?.upcoming).length;
    const active = groups.length - upcoming;
    const parts = [];
    if (active) parts.push(`${active} in effect now`);
    if (upcoming) parts.push(`${upcoming} starting later`);
    const head = groups.length === 1 ? '1 alert' : `${groups.length} alerts`;
    const zones = total > groups.length ? ` (${total} zone notices)` : '';
    return `${head} issued by this office${zones} — ${parts.join(', ')}.`;
}

// A lazily-fetched plain-English lead for one expanded alert (soft-fails to
// nothing — the verbatim NWS text below always stands on its own).
function AlertLead({ id }) {
    const [state, setState] = useState({ status: 'loading', html: null });
    useEffect(() => {
        let cancelled = false;
        explainAlert(id).then(html => {
            if (cancelled) return;
            setState(html ? { status: 'done', html } : { status: 'failed', html: null });
        });
        return () => { cancelled = true; };
    }, [id]);
    if (state.status === 'loading') {
        return (
            <p className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" aria-hidden="true" /> Summarizing…
            </p>
        );
    }
    if (state.status !== 'done') return null;
    return (
        <div className="mb-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">
                In plain English · via{' '}
                <a className="underline underline-offset-2" href="https://www.anthropic.com/claude/haiku" target="_blank" rel="noopener noreferrer">Claude</a>
            </p>
            <div className="plain-prose" dangerouslySetInnerHTML={{ __html: state.html }} />
        </div>
    );
}

function AlertBody({ alert, showArea = true }) {
    return (
        <>
            {showArea && alert.areaDesc && (
                <p className="mb-3 break-words text-xs text-muted-foreground">{alert.areaDesc}</p>
            )}
            <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-4 font-mono text-xs leading-6">
                {alert.description || alert.headline}
            </pre>
            {alert.instruction && (
                <p className="mt-3 text-sm">
                    <span className="font-semibold">What to do: </span>
                    {alert.instruction}
                </p>
            )}
        </>
    );
}

// Active alerts as an Accordion inside a Card: one row per distinct alert
// (identical event + end time collapse into one row with a count — see
// groupAlerts), expanding inline to a plain-English lead plus the verbatim
// NWS text and every zone it covers.
export function AlertsSection({ alerts, office, sectionRef }) {
    const [expanded, setExpanded] = useState(null);
    const groups = useMemo(() => groupAlerts(alerts), [alerts]);
    if (!alerts.length) return null;
    const tz = OFFICE_TIMEZONES[office];
    const now = Date.now();

    return (
        <section ref={sectionRef} id="section-active-alerts" className="scroll-mt-20">
            <Card>
                <CardHeader>
                    <CardTitle>Active alerts</CardTitle>
                    <CardDescription>{describe(groups, alerts.length, tz)}</CardDescription>
                </CardHeader>
                <CardContent>
                    <Accordion type="single" collapsible value={expanded} onValueChange={setExpanded}>
                        {groups.map((group) => {
                            const kind = classifyAlertKind(group.event);
                            const meta = KIND_META[kind];
                            const win = alertWindow(group, tz, now);
                            const value = `alert-${group.key}`;
                            return (
                                <AccordionItem key={group.key} value={value}>
                                    <AccordionTrigger className="hover:no-underline">
                                        <span className="flex min-w-0 flex-wrap items-center gap-2 pr-2 text-left">
                                            <meta.Icon className="size-4 shrink-0" aria-hidden="true" />
                                            <span className="font-medium">{group.event}</span>
                                            <Badge variant={meta.badge}>{meta.label}</Badge>
                                            {group.count > 1 && (
                                                <Badge variant="outline" aria-label={`${group.count} alerts`}>
                                                    ×{group.count}
                                                </Badge>
                                            )}
                                            {win?.upcoming && <Badge variant="outline">Upcoming</Badge>}
                                            {win && (
                                                <span className="font-normal text-muted-foreground">{win.label}</span>
                                            )}
                                        </span>
                                    </AccordionTrigger>
                                    <AccordionContent>
                                        {expanded === value && <AlertLead id={group.id} />}
                                        {group.count === 1 ? (
                                            <AlertBody alert={group} />
                                        ) : (
                                            <>
                                                <p className="mb-3 text-xs text-muted-foreground">
                                                    Issued for {group.count} zones — each has its own local details.
                                                </p>
                                                <div className="divide-y rounded-md border">
                                                    {group.members.map((member, i) => (
                                                        <details key={member.id || i} className="group/zone">
                                                            <summary className="cursor-pointer list-none px-3 py-2 text-sm hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
                                                                <span className="flex items-start gap-2">
                                                                    <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open/zone:rotate-90" aria-hidden="true" />
                                                                    <span className="min-w-0 break-words">{member.areaDesc || `Zone ${i + 1}`}</span>
                                                                </span>
                                                            </summary>
                                                            <div className="px-3 pb-3">
                                                                <AlertBody alert={member} showArea={false} />
                                                            </div>
                                                        </details>
                                                    ))}
                                                </div>
                                            </>
                                        )}
                                    </AccordionContent>
                                </AccordionItem>
                            );
                        })}
                    </Accordion>
                </CardContent>
            </Card>
        </section>
    );
}
