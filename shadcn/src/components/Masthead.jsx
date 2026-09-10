import { OFFICE_NAMES, OFFICE_TIMEZONES } from '@data/offices.js';
import { editionName, localHour } from '@/lib/format';

export function Masthead({ office, issuedAt }) {
    const tz = OFFICE_TIMEZONES[office];
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: tz,
    });
    const edition = issuedAt ? editionName(localHour(issuedAt, tz)) : '';

    return (
        <header className="pt-10 pb-6 text-center">
            <div className="mx-auto max-w-[1100px] px-5 sm:px-8">
                <div className="flex items-baseline justify-center gap-4 font-sans text-[0.7rem] uppercase tracking-[0.08em] text-muted-foreground">
                    <span className="hidden flex-1 border-b sm:block" aria-hidden="true" />
                    <span className="shrink-0">{dateStr}</span>
                    <h1 className="shrink-0 font-display text-5xl font-normal tracking-[-0.02em] text-foreground normal-case sm:text-6xl">
                        Plaincast
                    </h1>
                    <span className="shrink-0">NWS {office}</span>
                    <span className="hidden flex-1 border-b sm:block" aria-hidden="true" />
                </div>
                <p className="mt-2 font-display italic text-lg text-text-secondary">
                    What the forecast actually says
                </p>
                {/* Scotch double-rule */}
                <div className="mx-auto mt-4 border-t-2 border-foreground" role="presentation" />
                <div className="mx-auto mt-[3px] border-t border-foreground" role="presentation" />
                <p className="mt-3 font-sans text-[0.8rem] uppercase tracking-[0.08em] text-muted-foreground">
                    {OFFICE_NAMES[office]}
                    <span aria-hidden="true" className="mx-2">·</span>
                    Area Forecast Discussion
                    {edition && (
                        <>
                            <span aria-hidden="true" className="mx-2">·</span>
                            {edition}
                        </>
                    )}
                </p>
            </div>
        </header>
    );
}
