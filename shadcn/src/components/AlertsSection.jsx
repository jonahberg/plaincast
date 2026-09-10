import { useEffect, useState } from 'react';
import { AlertTriangle, Eye, Info, Loader2 } from 'lucide-react';

import { OFFICE_TIMEZONES } from '@data/offices.js';
import { alertWindow, classifyAlertKind } from '@/lib/nws';
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

function describe(alerts, tz) {
    const now = Date.now();
    const upcoming = alerts.filter(a => alertWindow(a, tz, now)?.upcoming).length;
    const active = alerts.length - upcoming;
    const parts = [];
    if (active) parts.push(`${active} in effect now`);
    if (upcoming) parts.push(`${upcoming} starting later`);
    return `${alerts.length === 1 ? '1 alert' : `${alerts.length} alerts`} issued by this office — ${parts.join(', ')}.`;
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

// Active alerts as an Accordion inside a Card: one row per alert, expanding
// inline to a plain-English lead plus the verbatim NWS text.
export function AlertsSection({ alerts, office, sectionRef }) {
    const [expanded, setExpanded] = useState(null);
    if (!alerts.length) return null;
    const tz = OFFICE_TIMEZONES[office];
    const now = Date.now();

    return (
        <section ref={sectionRef} id="section-active-alerts" className="scroll-mt-20">
            <Card>
                <CardHeader>
                    <CardTitle>Active alerts</CardTitle>
                    <CardDescription>{describe(alerts, tz)}</CardDescription>
                </CardHeader>
                <CardContent>
                    <Accordion type="single" collapsible value={expanded} onValueChange={setExpanded}>
                        {alerts.map((alert, i) => {
                            const kind = classifyAlertKind(alert.event);
                            const meta = KIND_META[kind];
                            const win = alertWindow(alert, tz, now);
                            const value = `alert-${i}`;
                            return (
                                <AccordionItem key={alert.id || i} value={value}>
                                    <AccordionTrigger className="hover:no-underline">
                                        <span className="flex flex-wrap items-center gap-2 pr-2 text-left">
                                            <meta.Icon className="size-4 shrink-0" aria-hidden="true" />
                                            <span className="font-medium">{alert.event}</span>
                                            <Badge variant={meta.badge}>{meta.label}</Badge>
                                            {win?.upcoming && <Badge variant="outline">Upcoming</Badge>}
                                            {win && (
                                                <span className="font-normal text-muted-foreground">{win.label}</span>
                                            )}
                                        </span>
                                    </AccordionTrigger>
                                    <AccordionContent>
                                        {alert.areaDesc && (
                                            <p className="mb-3 text-xs text-muted-foreground">
                                                {alert.areaDesc}
                                            </p>
                                        )}
                                        {expanded === value && <AlertLead id={alert.id} />}
                                        <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-4 font-mono text-xs leading-6">
                                            {alert.description || alert.headline}
                                        </pre>
                                        {alert.instruction && (
                                            <p className="mt-3 text-sm">
                                                <span className="font-semibold">What to do: </span>
                                                {alert.instruction}
                                            </p>
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
