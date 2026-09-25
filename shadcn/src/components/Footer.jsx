import { Rss } from 'lucide-react';

import { OFFICE_NAMES } from '@data/offices.js';
import { OFFICE_GROUPS } from '@/lib/offices-groups';
import { officeFeedHref } from '@/lib/seo';

const LINK = 'underline-offset-4 hover:text-foreground hover:underline';

// The React app removes the server-rendered #ssr-root on mount, and with it
// the 68-office index + National Desk link that crawlers and no-JS readers
// get. This footer restores them as real <a href> links (internal linking and
// a way around the site that doesn't depend on the picker).
export function Footer({ office, rawUrl }) {
    return (
        <footer className="border-t">
            <div className="mx-auto max-w-5xl px-4 py-8 text-sm text-muted-foreground sm:px-6">
                <nav aria-label="All Plaincast forecast offices">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        The forecast, office by office
                    </h2>
                    <p className="mt-2">
                        <a className={`font-medium text-foreground ${LINK}`} href="/national/">
                            The National Desk — where the weather is today →
                        </a>
                    </p>
                    <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
                        {OFFICE_GROUPS.map(group => (
                            <div key={group.label} className="min-w-0">
                                <h3 className="text-xs font-medium text-foreground">{group.label}</h3>
                                <ul className="mt-1.5 space-y-1 text-[13px] leading-5">
                                    {group.codes.map(code => (
                                        <li key={code}>
                                            <a
                                                href={`/o/${code}/`}
                                                className={code === office ? 'font-medium text-foreground' : LINK}
                                                aria-current={code === office ? 'page' : undefined}
                                            >
                                                {OFFICE_NAMES[code]} ({code})
                                            </a>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </div>
                </nav>

                <div className="mt-8 flex flex-col gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
                    <p>
                        Data from the{' '}
                        <a
                            className="font-medium underline underline-offset-4 hover:text-foreground"
                            href="https://www.weather.gov"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            National Weather Service
                        </a>
                        , office {office}.
                    </p>
                    <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        {rawUrl && (
                            <a className={LINK} href={rawUrl} target="_blank" rel="noopener noreferrer">
                                Original discussion
                            </a>
                        )}
                        <a className={`inline-flex items-center gap-1 ${LINK}`} href={officeFeedHref(office)} type="application/rss+xml">
                            <Rss className="size-3.5" aria-hidden="true" />
                            RSS
                        </a>
                        <a className={LINK} href="/about">About</a>
                        <a className={LINK} href="/developers">Developers</a>
                        <a className={LINK} href="/contact">Contact</a>
                        <a className={LINK} href="/privacy">Privacy</a>
                        <a className={LINK} href="https://github.com/jonahberg/plaincast" target="_blank" rel="noopener noreferrer">
                            GitHub
                        </a>
                        <a className={LINK} href="https://ui.shadcn.com" target="_blank" rel="noopener noreferrer">
                            Built with shadcn/ui
                        </a>
                        <a className={LINK} href="https://jonahberg.com" target="_blank" rel="noopener noreferrer">
                            Jonah Berg
                        </a>
                    </p>
                </div>
            </div>
        </footer>
    );
}
