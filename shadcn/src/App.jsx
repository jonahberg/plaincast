import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FileWarning, RefreshCw, WifiOff, X } from 'lucide-react';
import { toast } from 'sonner';

import { OFFICE_NAMES, OFFICE_TIMEZONES } from '@data/offices.js';
import { computeDiff } from '@data/diff.js';
import { extractTakeaway, hasRealAlerts, parseSections, reorderSections } from '@/lib/afd';
import {
    fetchAFDList, fetchAlerts, fetchChangelog, fetchConditions, fetchProduct, historyItems,
} from '@/lib/nws';
import { fetchEditionSnapshot, primeIssuanceTranslations } from '@/lib/ai';
import { bootFor, readBoot } from '@/lib/boot';
import { ALERTS_KEY, alertStatusSummary, withAlertsSection } from '@/lib/alert-status';
import { loadLastEdition, saveLastEdition } from '@/lib/offline';
import { currentRoute, officeUrl } from '@/lib/route';
import { headFor, officeFeedHref } from '@/lib/seo';
import { track } from '@/lib/track';
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
import { ChangelogView } from '@/components/ChangelogView';
import { ErrorBoundary } from '@/components/ErrorBoundary';

const OFFICE_KEY = 'plaincast-office';
const HISTORY_LIMIT = 10;
// Conditions that settled without a reading (the endpoint failed or the
// station had none): the almanac shows a dash in the cells it reserved.
const NO_CONDITIONS = Object.freeze({ temp: null, normal: null });

function initialState() {
    const route = currentRoute();
    if (route.office && OFFICE_NAMES[route.office]) {
        return { office: route.office, editionId: route.edition, view: route.view, fromUrl: true };
    }
    try {
        const saved = localStorage.getItem(OFFICE_KEY);
        if (saved && OFFICE_NAMES[saved]) return { office: saved, editionId: null, view: route.view, fromUrl: false };
    } catch (e) { /* private mode */ }
    return { office: 'LOX', editionId: null, view: route.view, fromUrl: false };
}

// Parsed product → render state; an unparseable product gets its own
// 'empty' state (a link to the raw text) instead of a blank page. Shared by
// the network load and the boot path, so both render an edition identically.
function productToState(product, extra) {
    const fullText = product.productText || '';
    const { sections, forecaster } = parseSections(fullText);
    return {
        status: sections.length ? 'ready' : 'empty',
        sections,
        forecaster,
        issuedAt: product.issuanceTime ? new Date(product.issuanceTime) : null,
        fullText,
        productId: product.id || null,
        archived: false,
        offline: false,
        savedAt: null,
        rawUrl: null,
        ...extra,
    };
}

// Same URL historyItems() falls back to for a list item.
function productUrl(id) {
    return `https://api.weather.gov/products/${encodeURIComponent(id)}`;
}

function sameInstant(a, b) {
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

// The served page's boot data, when it applies to the route the app opens on
// (src/lib/boot.js): the first render is then the finished edition — no
// skeleton — and its translations are primed so sections render AI text
// from their first frame.
function initialApp() {
    const loc = initialState();
    const boot = bootFor(readBoot(), loc);
    if (!boot) return { loc, boot: null, state: { status: 'loading' } };
    const state = productToState(boot.product, {
        rawUrl: productUrl(boot.product.id),
        productId: boot.product.id,
    });
    if (state.status !== 'ready') return { loc, boot: null, state: { status: 'loading' } };
    if (boot.translations) {
        primeIssuanceTranslations(loc.office, boot.product.id, boot.translations, boot.translationsComplete);
    }
    return { loc, boot, state };
}

function LoadingSkeleton() {
    return (
        <div aria-hidden="true">
            <Skeleton className="h-3 w-72 max-w-full" />
            <Skeleton className="mt-4 h-10 w-64 max-w-full" />
            <Skeleton className="mt-7 h-3 w-24" />
            <Skeleton className="mt-3 h-6 w-full" />
            <Skeleton className="mt-2 h-6 w-3/4" />
            <Skeleton className="mt-7 h-4 w-96 max-w-full" />
            <Skeleton className="mt-8 h-14 w-full" />
            <div className="mt-6 flex gap-5">
                {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-5 w-20" />)}
            </div>
            {[0, 1].map(i => (
                <div key={i} className="mt-4 space-y-3 border-t py-10">
                    <Skeleton className="h-7 w-40" />
                    <Skeleton className="mt-5 h-4 w-full max-w-[37rem]" />
                    <Skeleton className="h-4 w-full max-w-[37rem]" />
                    <Skeleton className="h-4 w-2/3" />
                </div>
            ))}
        </div>
    );
}

export default function App() {
    const { theme, toggle } = useTheme();
    // Computed once: the route, plus the boot edition when the served page
    // carries one for it.
    const [initial] = useState(initialApp);
    // fromUrl: the address bar names an office (/o/CODE/). False at `/`, where
    // the head keeps the homepage's title and canonical.
    const [{ office, editionId, view, fromUrl }, setLocation] = useState(initial.loc);
    const inChangelog = view === 'changelog';
    const [pickerOpen, setPickerOpen] = useState(false);
    const [state, setState] = useState(initial.state);
    const [alerts, setAlerts] = useState([]);
    // 'pending' until this load's alerts fetch settles: 'ok' | 'failed'.
    const [alertsStatus, setAlertsStatus] = useState('pending');
    const [severe, setSevere] = useState(false);
    // The boot edition stands in for the list until the revalidation brings
    // it, so the edition picker is in place from the first frame.
    const [editions, setEditions] = useState(() => (initial.boot
        ? [{ id: initial.boot.product.id, url: productUrl(initial.boot.product.id), time: new Date(initial.boot.product.issuanceTime || Date.now()) }]
        : []));
    const [diffs, setDiffs] = useState(null);          // Map(sectionKey → diff result)
    const [conditions, setConditions] = useState(null);
    // A changelog the server already resolved for this issuance renders
    // with the page instead of arriving above it later.
    const [changelog, setChangelog] = useState(() => (initial.boot?.changelog?.changelog ? initial.boot.changelog : null));
    // True while the sentence for the edition on screen is still being
    // fetched: the intro holds its place (src/components/PageIntro.jsx) so
    // the arrival fills in rather than pushing everything below it down.
    const [changelogPending, setChangelogPending] = useState(() => Boolean(initial.boot) && initial.boot.changelog === undefined);
    const [newerEdition, setNewerEdition] = useState(null); // product id of an unseen issuance
    const [offlineNow, setOfflineNow] = useState(!navigator.onLine);
    const [kbdOpen, setKbdOpen] = useState(false);
    const [activeKey, setActiveKey] = useState(null);
    const [announcement, setAnnouncement] = useState('');

    // Stale responses must never clobber a newer render (the vanilla client's
    // fetchGeneration): every async continuation checks it took the latest turn.
    const generation = useRef(0);
    // The boot edition, until the route moves off it (then every load is a
    // normal network load).
    const bootRef = useRef(initial.boot);
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

    // Alerts load in parallel and merge in when they arrive — they never hold
    // the forecast back (a slow alerts API used to blank the page). Where
    // they render (status row + the LAST section) keeps that arrival from
    // moving painted content.
    const loadAlerts = useCallback((code, gen) => {
        fetchAlerts(code).then(({ alerts: liveAlerts, severe: severeNow, ok }) => {
            if (gen !== generation.current) return;
            setAlerts(liveAlerts);
            setSevere(severeNow);
            setAlertsStatus(ok === false ? 'failed' : 'ok');
            if (liveAlerts.length) {
                const summary = alertStatusSummary(liveAlerts);
                if (summary) announce(`${summary.count} ${summary.count === 1 ? 'active alert' : 'active alerts'} for ${OFFICE_NAMES[code]}`);
            }
        });
    }, [announce]);

    // Post-load extras for a latest edition, each soft-failing independently:
    // the offline snapshot, live conditions, the "since the last update"
    // sentence, and the per-section diff vs the previous edition (the "What
    // changed" tabs — diff.js, the changelog data layer).
    const loadExtras = useCallback((code, gen, { product, rawUrl, sections, prevItem, fetchChangelogToo, saveSnapshot = true }) => {
        if (saveSnapshot) saveLastEdition(code, { product, rawUrl });
        fetchConditions(code).then(d => {
            // Settled with no reading still settles: the almanac keeps its
            // reserved cells and shows a dash rather than reflowing.
            if (gen === generation.current) setConditions(d || NO_CONDITIONS);
        });
        if (fetchChangelogToo) {
            setChangelogPending(true);
            fetchChangelog(code).then(async (d) => {
                // On the boot path a newer issuance may already exist; the
                // latest sentence then describes that edition, not the one on
                // screen, so ask for this edition's own (?id=).
                if (d && fetchChangelogToo === 'this-edition' && d.updated && product.issuanceTime
                    && !sameInstant(d.updated, product.issuanceTime)) {
                    const pinned = await fetchChangelog(code, product.id);
                    d = pinned && (!pinned.updated || sameInstant(pinned.updated, product.issuanceTime)) ? pinned : null;
                }
                if (gen !== generation.current) return;
                setChangelogPending(false);
                if (d) setChangelog(d);
            });
        }
        if (prevItem) {
            fetchProduct(prevItem.url).then(prev => {
                if (gen !== generation.current) return;
                const prevSections = parseSections(prev.productText || '').sections;
                const results = computeDiff(prevSections, sections);
                setDiffs(new Map(results.map(r => [r.key, r])));
            }).catch(() => { /* the tabs simply don't appear */ });
        }
    }, []);

    const load = useCallback(async (code, targetEditionId = null) => {
        // Any network load supersedes the served (boot) edition.
        bootRef.current = null;
        const gen = ++generation.current;
        setState({ status: 'loading' });
        setAlerts([]);
        setAlertsStatus('pending');
        setDiffs(null);
        setConditions(null);
        setChangelog(null);
        setChangelogPending(false);
        setNewerEdition(null);
        setActiveKey(null);
        // Per-office state: an offline fallback must never show the previous
        // office's edition list or keep its severe posture.
        setEditions([]);
        setSevere(false);

        loadAlerts(code, gen);

        try {
            const graph = await fetchAFDList(code);
            if (gen !== generation.current) return;
            const items = historyItems(graph, HISTORY_LIMIT);
            setEditions(items);
            if (!items.length) throw new Error('No forecast discussions found for this office.');

            let product = null;
            let rawUrl = null;
            let archived = false;
            const target = targetEditionId ? items.find(i => i.id === targetEditionId) : items[0];
            if (target) {
                product = await fetchProduct(target.url);
                rawUrl = target.url;
                archived = target.id !== items[0].id;
            } else {
                // Aged out of NWS retention — a durable server snapshot (if any)
                // keeps old shares from rotting.
                const snap = await fetchEditionSnapshot(code, targetEditionId);
                if (gen !== generation.current) return;
                if (snap) {
                    product = { id: targetEditionId, productText: snap.productText, issuanceTime: snap.issuanceTime };
                    archived = true;
                } else {
                    // Gone for good: show the latest and drop the dead
                    // ?edition= from the address bar (replace, not push — the
                    // stale URL shouldn't sit in history as a second entry).
                    product = await fetchProduct(items[0].url);
                    rawUrl = items[0].url;
                    if (gen !== generation.current) return;
                    history.replaceState(history.state, '', officeUrl(code, null));
                    renderedRoute.current = currentRoute();
                    toast('That edition is no longer available', { description: 'Showing the latest forecast instead.' });
                }
            }
            if (gen !== generation.current) return;
            if (!product) throw new Error('No forecast discussions found for this office.');

            const next = productToState(product, {
                rawUrl,
                productId: product.id || target?.id || null,
                archived,
            });
            setState(next);
            if (next.status === 'empty') {
                track('afd-parse-empty', { office: code });
                announce(`The ${OFFICE_NAMES[code]} forecast couldn't be read`);
                return;
            }
            announce(`Forecast for ${OFFICE_NAMES[code]} loaded`);

            if (!archived) {
                loadExtras(code, gen, {
                    product: { id: next.productId, productText: next.fullText, issuanceTime: product.issuanceTime },
                    rawUrl,
                    sections: next.sections,
                    prevItem: items[1] || null,
                    fetchChangelogToo: true,
                });
            }
        } catch (e) {
            if (gen !== generation.current) return;
            track('afd-fetch-fail', { office: code });
            // Offline / NWS outage: fall back to the last edition this browser
            // read for this office.
            const cached = loadLastEdition(code);
            if (cached?.product?.productText) {
                setState(productToState(cached.product, {
                    rawUrl: cached.rawUrl || null,
                    offline: true,
                    savedAt: cached.savedAt || null,
                }));
                announce('Offline — showing the last edition you read');
            } else {
                setState({ status: 'error', message: e.message || String(e) });
                announce("Couldn't fetch the forecast");
            }
        }
    }, [announce, loadAlerts, loadExtras]);

    // The boot path's load. The served edition is already on screen, so this
    // never resets state, shows the skeleton, clears alerts or diffs, or
    // re-renders the edition differently. It brings what the server did not
    // embed — the edition list (picker, "What changed" diffs), live alerts
    // and conditions, the offline snapshot — and when a newer issuance exists
    // it offers it through the newer-edition banner instead of swapping the
    // page under the reader.
    const revalidate = useCallback(async (code, boot, bootState) => {
        const gen = ++generation.current;
        loadAlerts(code, gen);
        const bootProduct = boot.product;
        const bootTime = Date.parse(bootProduct.issuanceTime);
        const snapshot = { id: bootProduct.id, productText: bootProduct.productText, issuanceTime: bootProduct.issuanceTime };
        const fetchChangelogToo = boot.changelog === undefined ? 'this-edition' : false;
        try {
            const graph = await fetchAFDList(code);
            if (gen !== generation.current) return;
            const items = historyItems(graph, HISTORY_LIMIT);
            if (!items.length) throw new Error('No forecast discussions found for this office.');
            // The picker lists the edition on screen as the latest it knows,
            // then everything older; a newer one goes to the banner.
            const idx = items.findIndex(i => i.id === bootProduct.id);
            const list = idx >= 0
                ? items.slice(idx)
                : [{ id: bootProduct.id, url: productUrl(bootProduct.id), time: new Date(bootTime) },
                    ...items.filter(i => Number.isFinite(bootTime) && i.time.getTime() < bootTime)];
            setEditions(list);
            if (idx > 0 || (idx < 0 && Number.isFinite(bootTime) && items[0].time.getTime() > bootTime)) {
                setNewerEdition(items[0].id);
            }
            announce(`Forecast for ${OFFICE_NAMES[code]} loaded`);
            loadExtras(code, gen, {
                product: snapshot,
                rawUrl: idx >= 0 ? items[idx].url : productUrl(bootProduct.id),
                sections: bootState.sections,
                prevItem: list[1] || null,
                fetchChangelogToo,
            });
        } catch (e) {
            if (gen !== generation.current) return;
            track('afd-fetch-fail', { office: code });
            // The served edition stays on screen. A newer edition this
            // browser saved earlier is offered through the banner ("Read it"
            // runs the normal load, whose offline fallback shows it).
            const cached = loadLastEdition(code);
            const cachedTime = Date.parse(cached?.product?.issuanceTime);
            const cachedIsNewer = Boolean(cached?.product?.id) && cached.product.id !== bootProduct.id
                && Number.isFinite(cachedTime) && Number.isFinite(bootTime) && cachedTime > bootTime;
            if (cachedIsNewer) setNewerEdition(cached.product.id);
            // Everything that does not need the NWS list still runs.
            loadExtras(code, gen, {
                product: snapshot,
                rawUrl: productUrl(bootProduct.id),
                sections: bootState.sections,
                prevItem: null,
                fetchChangelogToo,
                saveSnapshot: !cachedIsNewer,
            });
        }
    }, [announce, loadAlerts, loadExtras]);

    useEffect(() => {
        if (inChangelog) {
            bootRef.current = null;
            generation.current++; // strand any in-flight forecast load
            return;
        }
        const boot = bootRef.current;
        if (boot && boot.office === office && !editionId) {
            revalidate(office, boot, initial.state);
            return;
        }
        load(office, editionId);
    }, [office, editionId, inChangelog, load, revalidate, initial]);

    // Title + head links, in the SSR formats (lib/seo.js is shared with
    // scripts/build-offices.mjs). On an office URL they name the office; at
    // `/` (first load, or Back from an office page) they are the homepage's.
    useEffect(() => {
        const head = headFor({ office: fromUrl ? office : null, city: OFFICE_NAMES[office], changelog: inChangelog });
        document.title = head.title;
        const setAttr = (selector, attr, value) => {
            document.head.querySelector(selector)?.setAttribute(attr, value);
        };
        setAttr('meta[property="og:title"]', 'content', head.title);
        setAttr('meta[name="twitter:title"]', 'content', head.title);
        setAttr('link[rel="canonical"]', 'href', head.canonical);
        setAttr('meta[property="og:url"]', 'content', head.canonical);
        setAttr('link[rel="alternate"][type="text/markdown"]', 'href', head.markdown);
        setAttr('link[rel="alternate"][type="application/rss+xml"]', 'href', officeFeedHref(office));
    }, [office, inChangelog, fromUrl]);

    // ─── Navigation (canonical /o/CODE/ URLs, ?edition= permalinks) ──
    const navigate = useCallback((code, targetEditionId = null, { push = true, view: nextView = null, atHome = false } = {}) => {
        setLocation({ office: code, editionId: nextView ? null : targetEditionId, view: nextView, fromUrl: push || !atHome });
        try { localStorage.setItem(OFFICE_KEY, code); } catch (e) { /* private mode */ }
        if (push) {
            history.pushState({}, '', officeUrl(code, targetEditionId, nextView));
            renderedRoute.current = currentRoute();
        }
        if (!targetEditionId) window.scrollTo({ top: 0 });
    }, []);

    // Switching office keeps the current view (the ledger stays the ledger).
    const changeOffice = useCallback((code) => navigate(code, null, { view }), [navigate, view]);
    const openChangelog = useCallback((e) => {
        if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)) return;
        e?.preventDefault();
        navigate(office, null, { view: 'changelog' });
    }, [navigate, office]);
    const leaveChangelog = useCallback((targetEditionId = null) => {
        navigate(office, targetEditionId);
    }, [navigate, office]);
    const selectEdition = useCallback((id) => {
        navigate(office, id && id !== editions[0]?.id ? id : null);
    }, [navigate, office, editions]);

    useEffect(() => {
        const onPop = () => {
            const route = currentRoute();
            // Fragment-only navigation (contents links) also fires popstate.
            if (route.office === renderedRoute.current.office
                && route.edition === renderedRoute.current.edition
                && route.view === renderedRoute.current.view) return;
            renderedRoute.current = route;
            const code = route.office && OFFICE_NAMES[route.office] ? route.office : office;
            navigate(code, route.edition, { push: false, view: route.view, atHome: !route.office });
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
        if (!productId || viewingHistorical || inChangelog) return;
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
    }, [office, productId, severe, viewingHistorical, inChangelog]);

    // Online/offline transitions
    useEffect(() => {
        const onOnline = () => { setOfflineNow(false); if (state.offline && !inChangelog) load(office, editionId); };
        const onOffline = () => setOfflineNow(true);
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        return () => {
            window.removeEventListener('online', onOnline);
            window.removeEventListener('offline', onOffline);
        };
    }, [office, editionId, state.offline, inChangelog, load]);

    const tz = OFFICE_TIMEZONES[office];
    const ready = state.status === 'ready';

    // The parsed W/W/A section is only the coded list: live alerts replace it,
    // and a bare "None." section is dropped entirely (quiet offices otherwise
    // get a meaningless card). Section order comes from reorderSections, so
    // the nav is deterministic regardless of fetch timing.
    const displaySections = useMemo(() => {
        if (!ready) return [];
        const filtered = state.sections.filter(s => {
            if (s.key !== ALERTS_KEY) return true;
            if (alerts.length) return false;          // live card replaces it
            return hasRealAlerts(s.text);              // drop the bare "None."
        });
        return reorderSections(filtered, office, alerts.length > 0);
    }, [ready, state.sections, alerts.length, office]);

    // Live alerts arrive after the page has painted, so their section goes
    // LAST (an arrival appends below what is on screen) — except while a
    // Severe/Extreme Warning is live, when safety outranks layout stability
    // and it is pinned FIRST. The nav follows the page.
    const alertsFirst = alerts.length > 0 && severe;
    const navSections = useMemo(
        () => withAlertsSection(displaySections.map(s => s.key), { liveAlerts: alerts.length > 0, severe })
            .map(key => ({ key })),
        [displaySections, alerts.length, severe]
    );

    // The intro's alert status line (PageIntro's second meta row).
    const parsedAlertsListed = ready && state.sections.some(s => s.key === ALERTS_KEY && hasRealAlerts(s.text));
    const alertRow = useMemo(() => {
        if (alerts.length) return { kind: 'live', summary: alertStatusSummary(alerts), severe };
        if (alertsStatus === 'pending') return { kind: 'pending' };
        // The forecaster's coded watch/warning list, with no live match.
        if (parsedAlertsListed) return { kind: 'listed' };
        if (alertsStatus === 'failed') return { kind: 'unavailable' };
        return { kind: 'none' };
    }, [alerts, alertsStatus, parsedAlertsListed, severe]);

    const takeawayHTML = useMemo(
        () => (ready ? extractTakeaway(state.sections, tz) : ''),
        [ready, state.sections, tz]
    );
    const takeawayFromMessages = ready && state.sections.some(s => s.key === 'Messages');

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

    // Keyboard shortcuts: j/k section hop, / office search, ? help. Skipped
    // while focus is in a form control, including a Radix Select trigger
    // (role=combobox) — there the keys belong to the control.
    useEffect(() => {
        const onKey = (e) => {
            if (e.defaultPrevented) return;
            if (e.target.closest?.('input, textarea, select, [contenteditable], [role="combobox"], [role="listbox"], [data-slot="select-trigger"]')) return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === '?') {
                e.preventDefault();
                setKbdOpen(o => !o);
            } else if (e.key === '/') {
                e.preventDefault();
                selectRef.current?.focus();
                setPickerOpen(true);
            } else if ((e.key === 'j' || e.key === 'k') && !inChangelog) {
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
    }, [navSections, activeKey, jumpTo, inChangelog]);

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

    const shareUrl = officeUrl(office, viewingHistorical ? state.productId : null, view).toString();
    const changelogHref = officeUrl(office, null, 'changelog').toString();

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
                    pickerOpen={pickerOpen}
                    onPickerOpenChange={setPickerOpen}
                />

                <main id="sections" className="mx-auto w-full max-w-reading flex-1 px-4 pt-8 pb-4 sm:px-6 sm:pt-10">
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
                        // Floats over the bottom of the viewport instead of
                        // entering the page flow above the forecast: it can
                        // arrive at any moment (the poll, or the boot path's
                        // revalidation finding a newer issuance than the
                        // served page), and must not push the text the
                        // reader is on.
                        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40">
                            <div className="mx-auto max-w-reading px-4 pb-4 sm:px-6">
                                <Alert className="pointer-events-auto bg-background shadow-lg">
                                    <RefreshCw />
                                    <AlertTitle>A newer edition has been issued</AlertTitle>
                                    <AlertDescription className="w-full">
                                        <div className="flex w-full items-center justify-between gap-2">
                                            <Button size="sm" className="tap-target" onClick={() => { setNewerEdition(null); load(office, null); }}>
                                                Read it
                                            </Button>
                                            <Button
                                                variant="ghost" size="icon" className="tap-target size-7"
                                                aria-label="Dismiss"
                                                onClick={() => setNewerEdition(null)}
                                            >
                                                <X />
                                            </Button>
                                        </div>
                                    </AlertDescription>
                                </Alert>
                            </div>
                        </div>
                    )}

                    {inChangelog && (
                        <ErrorBoundary scoped resetKey={`changelog|${office}`}>
                            <ChangelogView
                                office={office}
                                announce={announce}
                                onBack={() => leaveChangelog(null)}
                                onOpenEdition={(id) => leaveChangelog(id)}
                            />
                        </ErrorBoundary>
                    )}

                    {!inChangelog && state.status === 'loading' && (
                        <div aria-busy="true" aria-label="Loading the forecast">
                            <LoadingSkeleton />
                        </div>
                    )}

                    {!inChangelog && state.status === 'error' && (
                        <Alert variant="destructive">
                            <AlertTitle>Couldn't fetch the forecast</AlertTitle>
                            <AlertDescription>
                                <p>{state.message}</p>
                                <Button variant="outline" size="sm" className="tap-target mt-2" onClick={() => load(office, editionId)}>
                                    Try again
                                </Button>
                            </AlertDescription>
                        </Alert>
                    )}

                    {!inChangelog && state.status === 'empty' && (
                        <Alert>
                            <FileWarning />
                            <AlertTitle>This forecast couldn't be decoded</AlertTitle>
                            <AlertDescription>
                                <p>
                                    The {OFFICE_NAMES[office]} office issued a discussion Plaincast couldn't split
                                    into sections — its format may be unusual this time.
                                </p>
                                <p className="mt-2 flex flex-wrap gap-2">
                                    {state.rawUrl && (
                                        <Button asChild size="sm" className="tap-target">
                                            <a href={state.rawUrl} target="_blank" rel="noopener noreferrer">
                                                Read the original NWS text
                                            </a>
                                        </Button>
                                    )}
                                    <Button variant="outline" size="sm" className="tap-target" onClick={() => load(office, editionId)}>
                                        Try again
                                    </Button>
                                </p>
                                {!state.rawUrl && state.fullText && (
                                    <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-4 font-mono text-xs leading-6">
                                        {state.fullText}
                                    </pre>
                                )}
                            </AlertDescription>
                        </Alert>
                    )}

                    {!inChangelog && ready && (
                        <ErrorBoundary scoped resetKey={`forecast|${office}|${state.productId}`}>
                            <PageIntro
                                office={office}
                                takeawayHTML={takeawayHTML}
                                takeawayFromMessages={takeawayFromMessages}
                                forecaster={state.forecaster}
                                issueLine={issueLine}
                                fullText={state.fullText}
                                conditions={conditions}
                                conditionsExpected={!state.archived && !state.offline}
                                changelog={changelog}
                                changelogPending={changelogPending && !viewingHistorical}
                                editions={editions}
                                currentEditionId={viewingHistorical ? state.productId : null}
                                onSelectEdition={selectEdition}
                                viewingHistorical={viewingHistorical}
                                changelogHref={changelogHref}
                                onOpenChangelog={openChangelog}
                                alertRow={alertRow}
                                onJumpToAlerts={() => jumpTo(ALERTS_KEY)}
                            />
                            <Explainer />
                            <SectionNav sections={navSections} activeKey={activeKey} onJump={jumpTo} />
                            <div className="mt-2">
                                {alertsFirst && (
                                    <AlertsSection
                                        alerts={alerts}
                                        office={office}
                                        sectionRef={setSectionRef(ALERTS_KEY)}
                                    />
                                )}
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
                                {!alertsFirst && (
                                    <AlertsSection
                                        alerts={alerts}
                                        office={office}
                                        sectionRef={setSectionRef(ALERTS_KEY)}
                                    />
                                )}
                            </div>
                        </ErrorBoundary>
                    )}
                </main>

                <Footer office={office} rawUrl={!inChangelog && ready ? state.rawUrl : null} />
            </div>
            <KbdDialog open={kbdOpen} onOpenChange={setKbdOpen} />
            <Toaster theme={theme} position="bottom-right" />
        </TooltipProvider>
    );
}
