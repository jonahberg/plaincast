import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { OFFICE_NAMES, OFFICE_TIMEZONES } from '@data/offices.js';
import { extractTakeaway, parseSections } from '@/lib/afd';
import { fetchAlerts, fetchLatestAFD } from '@/lib/nws';
import { formatIssueTime, timeAgo } from '@/lib/format';
import { useTheme } from '@/hooks/useTheme';

import { TooltipProvider } from '@/components/ui/tooltip';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

import { UtilityBar } from '@/components/UtilityBar';
import { Masthead } from '@/components/Masthead';
import { Lede } from '@/components/Lede';
import { Explainer } from '@/components/Explainer';
import { SectionNav } from '@/components/SectionNav';
import { ForecastSection } from '@/components/ForecastSection';
import { AlertsSection } from '@/components/AlertsSection';
import { OfficeIndex } from '@/components/OfficeIndex';
import { Colophon } from '@/components/Colophon';
import { KbdDialog } from '@/components/KbdDialog';

const OFFICE_KEY = 'plaincast-office';

function initialOffice() {
    const urlOffice = new URLSearchParams(location.search).get('office')?.toUpperCase();
    if (urlOffice && OFFICE_NAMES[urlOffice]) return urlOffice;
    try {
        const saved = localStorage.getItem(OFFICE_KEY);
        if (saved && OFFICE_NAMES[saved]) return saved;
    } catch (e) { /* private mode */ }
    return 'LOX';
}

function LoadingSkeleton() {
    return (
        <div aria-busy="true" aria-label="Setting the type…">
            <Skeleton className="mx-auto mb-3 h-6 w-2/3" />
            <Skeleton className="mx-auto mb-10 h-6 w-1/2" />
            {[0, 1].map(i => (
                <div key={i} className="mb-12 grid gap-6 md:grid-cols-2 md:gap-10">
                    <div className="space-y-3">
                        <Skeleton className="h-7 w-40" />
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-5/6" />
                        <Skeleton className="h-4 w-2/3" />
                    </div>
                    <Skeleton className="h-48 w-full" />
                </div>
            ))}
        </div>
    );
}

export default function App() {
    const { theme, toggle } = useTheme();
    const [office, setOffice] = useState(initialOffice);
    const [state, setState] = useState({ status: 'loading' });
    const [alerts, setAlerts] = useState([]);
    const [kbdOpen, setKbdOpen] = useState(false);
    const [activeKey, setActiveKey] = useState(null);

    const sectionRefs = useRef(new Map());
    const selectRef = useRef(null);

    const load = useCallback(async (code) => {
        setState({ status: 'loading' });
        setAlerts([]);
        try {
            const [{ product, rawUrl }, liveAlerts] = await Promise.all([
                fetchLatestAFD(code),
                fetchAlerts(code),
            ]);
            const { sections, forecaster } = parseSections(product.productText || '');
            setState({
                status: 'ready',
                sections,
                forecaster,
                rawUrl,
                issuedAt: product.issuanceTime ? new Date(product.issuanceTime) : null,
                fullText: product.productText || '',
            });
            setAlerts(liveAlerts);
        } catch (e) {
            setState({ status: 'error', message: e.message || String(e) });
        }
    }, []);

    useEffect(() => { load(office); }, [office, load]);

    const changeOffice = useCallback((code) => {
        setOffice(code);
        try { localStorage.setItem(OFFICE_KEY, code); } catch (e) { /* private mode */ }
        const url = new URL(location.href);
        url.searchParams.set('office', code);
        history.replaceState(null, '', url);
        window.scrollTo({ top: 0 });
    }, []);

    const tz = OFFICE_TIMEZONES[office];
    const ready = state.status === 'ready';

    // Live alerts replace the raw W/W/A section (which is just the coded list)
    const displaySections = useMemo(() => {
        if (!ready) return [];
        return alerts.length
            ? state.sections.filter(s => s.key !== 'Active Alerts')
            : state.sections;
    }, [ready, state.sections, alerts.length]);

    const navSections = useMemo(() => {
        const list = displaySections.map(s => ({ key: s.key }));
        return alerts.length ? [{ key: 'Active Alerts' }, ...list] : list;
    }, [displaySections, alerts.length]);

    const takeawayHTML = useMemo(
        () => (ready ? extractTakeaway(state.sections, tz) : ''),
        [ready, state.sections, tz]
    );

    const issueLine = ready && state.issuedAt
        ? `Issued ${formatIssueTime(state.issuedAt, tz)} (${timeAgo(state.issuedAt)})`
        : '';

    const jumpTo = useCallback((key) => {
        setActiveKey(key);
        sectionRefs.current.get(key)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, []);

    // Scrollspy for the section nav pills
    useEffect(() => {
        if (!ready) return;
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        setActiveKey(entry.target.dataset.sectionKey);
                        break;
                    }
                }
            },
            { rootMargin: '-10% 0px -70% 0px' }
        );
        for (const el of sectionRefs.current.values()) {
            if (el) observer.observe(el);
        }
        return () => observer.disconnect();
    }, [ready, navSections]);

    // Keyboard shortcuts: j/k section hop, / office search, ? help
    useEffect(() => {
        const onKey = (e) => {
            if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === '?') {
                e.preventDefault();
                setKbdOpen(o => !o);
            } else if (e.key === '/') {
                e.preventDefault();
                selectRef.current?.focus();
            } else if (e.key === 'j' || e.key === 'k') {
                const keys = navSections.map(s => s.key);
                if (!keys.length) return;
                e.preventDefault();
                const idx = keys.indexOf(activeKey);
                const next = e.key === 'j'
                    ? keys[Math.min(idx + 1, keys.length - 1)]
                    : keys[Math.max(idx - 1, 0)];
                jumpTo(next);
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [navSections, activeKey, jumpTo]);

    const setSectionRef = (key) => (el) => {
        if (el) {
            el.dataset.sectionKey = key;
            sectionRefs.current.set(key, el);
        } else {
            sectionRefs.current.delete(key);
        }
    };

    return (
        <TooltipProvider delayDuration={200}>
            <a
                href="#sections"
                className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-card focus:p-3 focus:font-sans focus:text-sm"
            >
                Skip to forecast
            </a>
            <UtilityBar
                office={office}
                onOfficeChange={changeOffice}
                onShowKbd={() => setKbdOpen(true)}
                theme={theme}
                onToggleTheme={toggle}
                selectRef={selectRef}
            />
            <Masthead office={office} issuedAt={ready ? state.issuedAt : null} />

            <main id="sections" className="mx-auto max-w-[1100px] px-5 sm:px-8">
                {state.status === 'loading' && <LoadingSkeleton />}

                {state.status === 'error' && (
                    <Alert variant="destructive" className="mx-auto max-w-xl">
                        <AlertTitle>Couldn't fetch the forecast</AlertTitle>
                        <AlertDescription>
                            <p>{state.message}</p>
                            <Button variant="outline" size="sm" className="mt-2" onClick={() => load(office)}>
                                Try again
                            </Button>
                        </AlertDescription>
                    </Alert>
                )}

                {ready && (
                    <>
                        <Lede
                            takeawayHTML={takeawayHTML}
                            forecaster={state.forecaster}
                            issueLine={issueLine}
                            fullText={state.fullText}
                        />
                        <Explainer />
                        <SectionNav sections={navSections} activeKey={activeKey} onJump={jumpTo} />
                        <AlertsSection
                            alerts={alerts}
                            office={office}
                            sectionRef={setSectionRef('Active Alerts')}
                        />
                        {displaySections.map(section => (
                            <ForecastSection
                                key={section.key}
                                section={section}
                                office={office}
                                sectionRef={setSectionRef(section.key)}
                            />
                        ))}
                    </>
                )}

                <OfficeIndex office={office} onOfficeChange={changeOffice} />
            </main>

            <Colophon office={office} rawUrl={ready ? state.rawUrl : null} />
            <KbdDialog open={kbdOpen} onOpenChange={setKbdOpen} />
        </TooltipProvider>
    );
}
