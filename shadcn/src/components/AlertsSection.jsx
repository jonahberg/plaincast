import { AlertTriangle, Eye, Info } from 'lucide-react';

import { OFFICE_TIMEZONES } from '@data/offices.js';
import { classifyAlertKind } from '@/lib/nws';
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

function untilLabel(alert, tz) {
    const end = alert.ends || alert.expires;
    if (!end) return null;
    try {
        const d = new Date(end);
        return 'until ' + d.toLocaleString('en-US', {
            weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz,
        });
    } catch (e) {
        return null;
    }
}

// Active alerts as an Accordion inside a Card: one row per alert,
// expanding inline to the verbatim NWS text.
export function AlertsSection({ alerts, office, sectionRef }) {
    if (!alerts.length) return null;
    const tz = OFFICE_TIMEZONES[office];

    return (
        <section ref={sectionRef} id="section-active-alerts" className="scroll-mt-20">
            <Card>
                <CardHeader>
                    <CardTitle>Active alerts</CardTitle>
                    <CardDescription>
                        {alerts.length === 1 ? '1 alert' : `${alerts.length} alerts`} in effect from this office right now.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Accordion type="single" collapsible>
                        {alerts.map((alert, i) => {
                            const kind = classifyAlertKind(alert.event);
                            const meta = KIND_META[kind];
                            const until = untilLabel(alert, tz);
                            return (
                                <AccordionItem key={alert.id || i} value={`alert-${i}`}>
                                    <AccordionTrigger className="hover:no-underline">
                                        <span className="flex flex-wrap items-center gap-2 pr-2 text-left">
                                            <meta.Icon className="size-4 shrink-0" aria-hidden="true" />
                                            <span className="font-medium">{alert.event}</span>
                                            <Badge variant={meta.badge}>{meta.label}</Badge>
                                            {until && (
                                                <span className="font-normal text-muted-foreground">{until}</span>
                                            )}
                                        </span>
                                    </AccordionTrigger>
                                    <AccordionContent>
                                        {alert.areaDesc && (
                                            <p className="mb-3 text-xs text-muted-foreground">
                                                {alert.areaDesc}
                                            </p>
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
