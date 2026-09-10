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

const KIND_META = {
    warning: { label: 'Warning', badge: 'destructive', Icon: AlertTriangle },
    watch: { label: 'Watch', badge: 'warning', Icon: Eye },
    advisory: { label: 'Advisory', badge: 'advisory', Icon: Info },
    statement: { label: 'Statement', badge: 'secondary', Icon: Info },
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

// The hazard ledger, as a shadcn Accordion: one row per active alert,
// expanding inline to the verbatim NWS text (matches the vanilla client's
// inline-expanding .hz-row rows — no modal).
export function AlertsSection({ alerts, office, sectionRef }) {
    if (!alerts.length) return null;
    const tz = OFFICE_TIMEZONES[office];

    return (
        <section ref={sectionRef} id="section-active-alerts" className="mb-12 scroll-mt-16">
            <h2 className="mb-4 font-display text-2xl font-normal tracking-[-0.02em]">
                Active Alerts
            </h2>
            <Accordion type="single" collapsible className="rounded-md border px-4">
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
                                    <p className="mb-3 font-sans text-xs text-muted-foreground">
                                        {alert.areaDesc}
                                    </p>
                                )}
                                <pre className="whitespace-pre-wrap break-words rounded-md bg-secondary p-4 font-mono text-[0.8rem] leading-[1.65] text-text-secondary">
                                    {alert.description || alert.headline}
                                </pre>
                                {alert.instruction && (
                                    <p className="mt-3 font-serif text-sm">
                                        <strong className="font-sans text-xs uppercase tracking-[0.08em] text-amber">
                                            What to do:{' '}
                                        </strong>
                                        {alert.instruction}
                                    </p>
                                )}
                            </AccordionContent>
                        </AccordionItem>
                    );
                })}
            </Accordion>
        </section>
    );
}
