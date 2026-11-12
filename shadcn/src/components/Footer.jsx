import { Rss } from 'lucide-react';

import { OFFICE_NAMES } from '@data/offices.js';
import { OFFICE_GROUPS } from '@/lib/offices-groups';
import { officeFeedHref } from '@/lib/seo';
import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from '@/components/ui/accordion';

const LINK = 'underline-offset-4 hover:text-foreground hover:underline';
// On a touch screen a footer link is a 44px row, not a 16px line.
const TOUCH_ROW = 'pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:items-center pointer-coarse:justify-center';

function OfficeLink({ code, office, className = '' }) {
    return (
        <a
            href={`/o/${code}/`}
            className={`${code === office ? 'font-medium text-foreground' : LINK} ${className}`}
            aria-current={code === office ? 'page' : undefined}
        >
            {OFFICE_NAMES[code]} ({code})
        </a>
    );
}

// The React app removes the server-rendered #ssr-root on mount, and with it
// the 68-office index + National Desk link that crawlers and no-JS readers
// get. This footer restores them as real <a href> links (internal linking and
// a way around the site that doesn't depend on the picker).
//
// Phones get the index as a collapsed accordion — one 44px row per region,
// opening to a two-column list of 44px rows — instead of 68 16px-tall links.
// From `sm` up it stays the multi-column grid. (The server-rendered index in
// #ssr-root is separate and unchanged.)
export function Footer({ office, rawUrl }) {
    return (
        <footer className="border-t">
            <div className="mx-auto max-w-reading px-4 py-8 text-sm text-muted-foreground sm:px-6">
                <nav aria-label="All Plaincast forecast offices">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        The forecast, office by office
                    </h2>
                    <p className="mt-2">
                        <a className={`font-medium text-foreground ${LINK} ${TOUCH_ROW}`} href="/national/">
                            The National Desk — where the weather is today →
                        </a>
                    </p>

                    <Accordion type="single" collapsible className="mt-2 border-t sm:hidden">
                        {OFFICE_GROUPS.map(group => (
                            <AccordionItem key={group.label} value={group.label}>
                                <AccordionTrigger className="min-h-11 items-center py-3 text-foreground hover:no-underline">
                                    {group.label}
                                </AccordionTrigger>
                                <AccordionContent className="pb-3">
                                    <ul className="grid grid-cols-2 gap-x-4 text-[13px] leading-5">
                                        {group.codes.map(code => (
                                            <li key={code} className="min-w-0">
                                                <OfficeLink code={code} office={office} className="flex min-h-11 items-center" />
                                            </li>
                                        ))}
                                    </ul>
                                </AccordionContent>
                            </AccordionItem>
                        ))}
                    </Accordion>

                    <div className="mt-4 hidden grid-cols-2 gap-x-6 gap-y-5 sm:grid sm:grid-cols-3">
                        {OFFICE_GROUPS.map(group => (
                            <div key={group.label} className="min-w-0">
                                <h3 className="text-xs font-medium text-foreground">{group.label}</h3>
                                <ul className="mt-1.5 space-y-1 text-[13px] leading-5 pointer-coarse:space-y-0">
                                    {group.codes.map(code => (
                                        <li key={code}>
                                            <OfficeLink code={code} office={office} className={TOUCH_ROW} />
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </div>
                </nav>

                <div className="mt-8 flex flex-col gap-3 border-t pt-6">
                    <p>
                        Data from the{' '}
                        <a
                            className="tap-target font-medium underline underline-offset-4 hover:text-foreground"
                            href="https://www.weather.gov"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            National Weather Service
                        </a>
                        , office {office}.
                    </p>
                    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 pointer-coarse:gap-y-0">
                        {rawUrl && (
                            <a className={`${LINK} ${TOUCH_ROW}`} href={rawUrl} target="_blank" rel="noopener noreferrer">
                                Original discussion
                            </a>
                        )}
                        <a className={`inline-flex items-center gap-1 ${LINK} pointer-coarse:min-h-11 pointer-coarse:min-w-11`} href={officeFeedHref(office)} type="application/rss+xml">
                            <Rss className="size-3.5" aria-hidden="true" />
                            RSS
                        </a>
                        <a className={`${LINK} ${TOUCH_ROW}`} href="/about">About</a>
                        <a className={`${LINK} ${TOUCH_ROW}`} href="/developers">Developers</a>
                        <a className={`${LINK} ${TOUCH_ROW}`} href="/contact">Contact</a>
                        <a className={`${LINK} ${TOUCH_ROW}`} href="/privacy">Privacy</a>
                        <a className={`${LINK} ${TOUCH_ROW}`} href="https://github.com/jonahberg/plaincast" target="_blank" rel="noopener noreferrer">
                            GitHub
                        </a>
                        <a className={`${LINK} ${TOUCH_ROW}`} href="https://ui.shadcn.com" target="_blank" rel="noopener noreferrer">
                            Built with shadcn/ui
                        </a>
                        <a className={`${LINK} ${TOUCH_ROW}`} href="https://jonahberg.com" target="_blank" rel="noopener noreferrer">
                            Jonah Berg
                        </a>
                    </p>
                </div>
            </div>
        </footer>
    );
}
