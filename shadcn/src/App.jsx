import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, WifiOff, X } from 'lucide-react';

import { OFFICE_NAMES, OFFICE_TIMEZONES } from '@data/offices.js';
import { computeDiff } from '@data/diff.js';
import { extractTakeaway, hasRealAlerts, parseSections, reorderSections } from '@/lib/afd';
import {
    fetchAFDList, fetchAlerts, fetchChangelog, fetchConditions, fetchProduct, historyItems,
} from '@/lib/nws';
import { fetchEditionSnapshot } from '@/lib/ai';
import { loadLastEdition, saveLastEdition } from '@/lib/offline';
import { currentRoute, officeUrl } from '@/lib/route';
import { formatIssueTime, timeAgo } from '@/lib/format';
import { useTheme } from '@/hooks/useTheme';

import { TooltipProvider } from '@/components/ui/tooltip';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';

import { Header } from '@/components/Header';
import { PageIntro } from '@/components/PageIntro';
import { Explainer } from '@/components/Explainer';
import { SectionNav } from '@/components/SectionNav';
import { ForecastSection } from '@/components/ForecastSection';
import { AlertsSection } from '@/components/AlertsSection';
import { Footer } from '@/components/Footer';
import { KbdDialog } from '@/components/KbdDialog';

const OFFICE_KEY = 'plaincast-office';
const HISTORY_LIMIT = 10;

function initialState() {
    const route = currentRoute();
    if (route.office && OFFICE_NAMES[route.office]) {
        return { office: route.office, editionId: route.edition, fromUrl: true };
    }
    try {
        const saved = localStorage.getItem(OFFICE_KEY);
        if (saved && OFFICE_NAMES[saved]) return { office: saved, editionId: null, fromUrl: false };
    } catch (e) { /* private mode */ }
    return { office: 'LOX', editionId: null, fromUrl: false };
}

function LoadingSkeleton() {
    return (
        <div aria-hidden="true" className="space-y-6">
            <div className="space-y-2">
                <Skeleton className="h-8 w-64" />
                <Skeleton className="h-4 w-96 max-w-full" />
                <Skeleton className="h-4 w-72" />
                <Skeleton className="mt-4 h-12 w-full rounded-lg" />
                <Skeleton className="mt-4 h-20 w-full rounded-lg" />
            </div>
            <div className="flex gap-1">
                {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-8 w-24" />)}
            </div>
            {[0, 1].map(i => (
                <div key={i} className="space-y-4 rounded-lg border p-6">
                    <Skeleton className="h-6 w-40" />
                    <Skeleton className="h-9 w-56 rounded-lg" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-2/3" />
                </div>
            ))}
        </div>
    );
}

export default function App() {
    const { theme, toggle } = useTheme();
    const [{ office, editionId }, setLocation] = useState(initialState);
    const [state, setState] = useState({ status: 'loading' });
    const [alerts, setAlerts] = useState([]);
    const [severe, setSevere] = useState(false);
    const [editions, setEditions] = useState([]);
    const [diffs, setDiffs] = useState(null);          // Map(sectionKey → diff result)
    const [conditions, setConditions] = useState(null);
    const [changelog, setChangelog] = useState(null);
    const [newerEdition, setNewerEdition] = useState(null); // product id of an unseen issuance
    const [offlineNow, setOfflineNow] = useState(!navigator.onLine);
    const [kbdOpen, setKbdOpen] = useState(false);
    const [activeKey, setActiveKey] = useState(null);
    const [announcement, setAnnouncement] = useState('');

    // Stale responses must never clobber a newer render (the vanilla client's
    // fetchGeneration): every async continuation checks it took the latest turn.
    const generation = useRef(0);
    const selectRef = useRef(null);
    const sectionEls = useRef(new Map());
    const refCallbacks = useRef(new Map());
    const renderedRoute = useRef(currentRoute());

    const announce = useCallback((msg) => setAnnouncement(msg), []);

    // The served page carries a server-rendered digest (#ssr-root in
    // index.html) for crawlers and no-JS readers; the app supersedes it.
    // Layout effect: gone before the first painted frame with both.
    useLayoutEffect(() => {
        document.getElementById('ssr-root')?.remove();
    }, []);

    const load = useCallback(async (code, targetEditionId = null) => {
        const gen = ++generation.current;
        setState({ status: 'loading' });
        setAlerts([]);
        setDiffs(null);
        setConditions(null);
        setChangelog(null);
        setNewerEdition(null);
        setActiveKey(null);

        const alertsPromise = fetchAlerts(code);
        try {
            const graph = await fetchAFDList(code);
            if (gen !== generation.current) return;
            const items = historyItems(graph, HISTORY_LIMIT);
            setEditions(items);

            let product = null;
            let rawUrl = null;
            let archived = false;
            const target = targetEditionId ? items.find(i => i.id === targetEditionId) : items[0];
            if (target) {
                product = await fetchProduct(target.url);
                rawUrl = target.url;
                archived = target.id !== items[0]?.id;
            } else if (targetEditionId) {
                // Aged out of NWS retention — a durable server snapshot (if any)
                // keeps old shares from rotting.
                const snap = await fetchEditionSnapshot(code, targetEditionId);
                if (gen !== generation.current) return;
                if (snap) {
                    product = { id: targetEditionId, productText: snap.productText, issuanceTime: snap.issuanceTime };
                    archived = true;
                } else {
                    product = await fetchProduct(items[0].url);
                    rawUrl = items[0].url;
                }
            }
            if (gen !== generation.current) return;
            if (!product) throw new Error('No forecast discussions found for this office.');

            const { alerts: liveAlerts, severe: severeNow } = await alertsPromise;
            if (gen !== generation.current) return;

            const { sections, forecaster } = parseSections(product.productText || '');
            const next = {
                status: 'ready',
                sections,
                forecaster,
                rawUrl,
                issuedAt: product.issuanceTime ? new Date(product.issuanceTime) : null,
                fullText: product.productText || '',
                productId: product.id || target?.id || null,
                archived,
                offline: false,
                savedAt: null,
            };
            setState(next);
            setAlerts(liveAlerts);
            setSevere(severeNow);
            announce(`Forecast for ${OFFICE_NAMES[code]} loaded`);

            if (!archived) {
                saveLastEdition(code, {
                    product: { id: next.productId, productText: next.fullText, issuanceTime: product.issuanceTime },
                    rawUrl,
                });
                // Post-load extras, each soft-failing independently.
                fetchConditions(code).then(d => {
                    if (gen === generation.current && d) setConditions(d);
                });
                fetchChangelog(code).then(d => {
                    if (gen === generation.current && d) setChangelog(d);
                });
                // Per-section diff vs the previous edition, for the "What
                // changed" tabs (diff.js — the changelog data layer).
                if (items[1]) {
                    fetchProduct(items[1].url).then(prev => {
                        if (gen !== generation.current) return;
                        const prevSections = parseSections(prev.productText || '').sections;
                        const results = computeDiff(prevSections, sections);
                        setDiffs(new Map(results.map(r => [r.key, r])));
                    }).catch(() => { /* the tabs simply don't appear */ });
                }
            }
        } catch (e) {
            if (gen !== generation.current) return;
            // Offline / NWS outage: fall back to the last edition this browser
            // read for this office.
            const cached = loadLastEdition(code);
            if (cached?.product?.productText) {
                const { sections, forecaster } = parseSections(cached.product.productText);
                setState({
                    status: 'ready',
                    sections,
                    forecaster,
                    rawUrl: cached.rawUrl || null,
                    issuedAt: cached.product.issuanceTime ? new Date(cached.product.issuanceTime) : null,
                    fullText: cached.product.productText,
                    productId: cached.product.id || null,
                    archived: false,
                    offline: true,
                    savedAt: cached.savedAt || null,
                });
                announce('Offline — showing the last edition you read');
            } else {
                setState({ status: 'error', message: e.message || String(e) });
                announce("Couldn't fetch the forecast");
            }
        }
    }, [announce]);

    useEffect(() => { load(office, editionId); }, [office, editionId, load]);

    useEffect(() => {
        document.title = `Plaincast — ${OFFICE_NAMES[office]} (${office})`;
    }, [office]);

    // ─── Navigation (canonical /o/CODE/ URLs, ?edition= permalinks) ──
    const navigate = useCallback((code, targetEditionId = null, { push = true } = {}) => {
        setLocation({ office: code, editionId: targetEditionId });
        try { localStorage.setItem(OFFICE_KEY, code); } catch (e) { /* private mode */ }
        if (push) {
            history.pushState({}, '', officeUrl(code, targetEditionId));
            renderedRoute.current = currentRoute();
        }
        if (!targetEditionId) window.scrollTo({ top: 0 });
    }, []);

    const changeOffice = useCallback((code) => navigate(code, null), [navigate]);
    const selectEdition = useCallback((id) => {
        navigate(office, id && id !== editions[0]?.id ? id : null);
    }, [navigate, office, editions]);

    useEffect(() => {
        const onPop = () => {
            const route = currentRoute();
            // Fragment-only navigation (contents links) also fires popstate.
            if (route.office === renderedRoute.current.office
                && route.edition === renderedRoute.current.edition) return;
            renderedRoute.current = route;
            const code = route.office && OFFICE_NAMES[route.office] ? route.office : office;
            navigate(code, route.edition, { push: false });
        };
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, [navigate, office]);

    // ─── Auto-refresh: a newer edition banner ────────────────────────
    // 10-minute checks, tightened to 2 while a Severe/Extreme Warning is live
    // (forecasters re-issue rapidly in exactly those hours).
    const productId = state.status === 'ready' ? state.productId : null;
    const viewingHistorical = state.status === 'ready' && state.archived;
    useEffect(() => {
        if (!productId || viewingHistorical) return;
        const interval = severe ? 2 * 60 * 1000 : 10 * 60 * 1000;
        const timer = setInterval(async () => {
            if (document.hidden) return;
            try {
                const graph = await fetchAFDList(office, { force: true });
                const latest = graph[0];
                if (latest && latest.id !== productId) setNewerEdition(latest.id);
                // Severe posture must also stand down on its own.
                if (severe) {
                    const { severe: stillSevere } = await fetchAlerts(office);
                    setSevere(stillSevere);
                }
            } catch (e) { /* silent retry next cycle */ }
        }, interval);
        return () => clearInterval(timer);
    }, [office, productId, severe, viewingHistorical]);

    // Online/offline transitions
    useEffect(() => {
        const onOnline = () => { setOfflineNow(false); if (state.offline) load(office, editionId); };
        const onOffline = () => setOfflineNow(true);
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        return () => {
            window.removeEventListener('online', onOnline);
            window.removeEventListener('offline', onOffline);
        };
    }, [office, editionId, state.offline, load]);

    const tz = OFFICE_TIMEZONES[office];
    const ready = state.status === 'ready';

    // The parsed W/W/A section is only the coded list: live alerts replace it,
    // and a bare "None." section is dropped entirely (quiet offices otherwise
    // get a meaningless card). Section order comes from reorderSections, so
    // the nav is deterministic regardless of fetch timing.
    const displaySections = useMemo(() => {
        if (!ready) return [];
        const filtered = state.sections.filter(s => {
            if (s.key !== 'Active Alerts') return true;
            if (alerts.length) return false;          // live card replaces it
            return hasRealAlerts(s.text);              // drop the bare "None."
        });
        return reorderSections(filtered, office, alerts.length > 0);
    }, [ready, state.sections, alerts.length, office]);

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
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        sectionEls.current.get(key)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    }, []);

    // Scrollspy: the topmost intersecting section wins.
    useEffect(() => {
        if (!ready || !('IntersectionObserver' in window)) return;
        const observer = new IntersectionObserver((entries) => {
            const visible = entries
                .filter(e => e.isIntersecting)
                .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
            if (visible.length) setActiveKey(visible[0].target.dataset.sectionKey);
        }, { rootMargin: '-10% 0px -70% 0px' });
        for (const el of sectionEls.current.values()) {
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
                const idx = keys.indexOf(activeKey); // -1 lands on the first section
                const next = e.key === 'j'
                    ? keys[Math.min(idx + 1, keys.length - 1)]
                    : keys[Math.max(idx - 1, 0)];
                jumpTo(next);
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [navSections, activeKey, jumpTo]);

    // Stable ref callbacks so memo(ForecastSection) isn't defeated by a fresh
    // closure every render.
    const setSectionRef = useCallback((key) => {
        if (!refCallbacks.current.has(key)) {
            refCallbacks.current.set(key, (el) => {
                if (el) {
                    el.dataset.sectionKey = key;
                    sectionEls.current.set(key, el);
                } else {
                    sectionEls.current.delete(key);
                }
            });
        }
        return refCallbacks.current.get(key);
    }, []);

    const shareUrl = officeUrl(office, viewingHistorical ? state.productId : null).toString();

    return (
        <TooltipProvider delayDuration={200}>
            <div className="flex min-h-svh flex-col">
                <a
                    href="#sections"
                    className="sr-only focus:not-sr-only focus:absolute focus:z-[60] focus:bg-background focus:p-3 focus:text-sm"
                >
                    Skip to forecast
                </a>
                <div className="sr-only" role="status" aria-live="polite">{announcement}</div>

                <Header
                    office={office}
                    shareUrl={shareUrl}
                    onOfficeChange={changeOffice}
                    onShowKbd={() => setKbdOpen(true)}
                    theme={theme}
                    onToggleTheme={toggle}
                    selectRef={selectRef}
                />

                <main id="sections" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
                    {(offlineNow || (ready && state.offline)) && (
                        <Alert className="mb-6">
                            <WifiOff />
                            <AlertTitle>Offline</AlertTitle>
                            <AlertDescription>
                                {ready && state.offline
                                    ? `Showing the last edition you read${state.savedAt ? ` (saved ${timeAgo(new Date(state.savedAt))})` : ''}.`
                                    : 'Your connection dropped — the forecast may be stale.'}
                            </AlertDescription>
                        </Alert>
                    )}

                    {newerEdition && (
                        <Alert className="mb-6">
                            <RefreshCw />
                            <AlertTitle>A newer edition has been issued</AlertTitle>
                            <AlertDescription className="w-full">
                                <div className="flex w-full items-center justify-between gap-2">
                                    <Button size="sm" onClick={() => { setNewerEdition(null); load(office, null); }}>
                                        Read it
                                    </Button>
                                    <Button
                                        variant="ghost" size="icon" className="size-7"
                                        aria-label="Dismiss"
                                        onClick={() => setNewerEdition(null)}
                                    >
                                        <X />
                                    </Button>
                                </div>
                            </AlertDescription>
                        </Alert>
                    )}

                    {state.status === 'loading' && (
                        <div aria-busy="true" aria-label="Loading the forecast">
                            <LoadingSkeleton />
                        </div>
                    )}

                    {state.status === 'error' && (
                        <Alert variant="destructive">
                            <AlertTitle>Couldn't fetch the forecast</AlertTitle>
                            <AlertDescription>
                                <p>{state.message}</p>
                                <Button variant="outline" size="sm" className="mt-2" onClick={() => load(office, editionId)}>
                                    Try again
                                </Button>
                            </AlertDescription>
                        </Alert>
                    )}

                    {ready && (
                        <>
                            <PageIntro
                                office={office}
                                takeawayHTML={takeawayHTML}
                                forecaster={state.forecaster}
                                issueLine={issueLine}
                                fullText={state.fullText}
                                conditions={conditions}
                                changelog={changelog}
                                editions={editions}
                                currentEditionId={viewingHistorical ? state.productId : null}
                                onSelectEdition={selectEdition}
                                viewingHistorical={viewingHistorical}
                            />
                            <Explainer />
                            <SectionNav sections={navSections} activeKey={activeKey} onJump={jumpTo} />
                            <div className="space-y-6">
                                <AlertsSection
                                    alerts={alerts}
                                    office={office}
                                    sectionRef={setSectionRef('Active Alerts')}
                                />
                                {displaySections.map(section => (
                                    <ForecastSection
                                        key={`${office}-${state.productId}-${section.key}`}
                                        section={section}
                                        office={office}
                                        productId={state.productId}
                                        issuanceTime={state.issuedAt?.toISOString()}
                                        aiEligible={section.key !== 'Active Alerts' && !state.offline}
                                        diff={diffs?.get(section.key) || null}
                                        sectionRef={setSectionRef(section.key)}
                                    />
                                ))}
                            </div>
                        </>
                    )}
                </main>

                <Footer office={office} rawUrl={ready ? state.rawUrl : null} />
            </div>
            <KbdDialog open={kbdOpen} onOpenChange={setKbdOpen} />
            <Toaster theme={theme} position="bottom-right" />
        </TooltipProvider>
    );
}
