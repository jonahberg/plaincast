// ─── One-pass load (Nov 2026) ───────────────────────────────────────
// The client half of the boot data (api/_boot.js on the server): the parser
// that decides whether the served edition can be the first render, the AI
// memo it primes, the alert status line and the alert ordering rule. React
// wiring is pinned by source assertions, the convention of
// tests/shadcn-frontend.test.js and tests/frontend-audit-sep28.test.js.

import { describe, it, expect, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';

import { bootFor, parseBoot, readBoot, resetBootForTests } from '../shadcn/src/lib/boot.js';
import {
    formatTranslationHTML, getIssuanceTranslations, mapTranslation, peekTranslation,
    primeIssuanceTranslations, resetTranslationMemoForTests,
} from '../shadcn/src/lib/ai.js';
import { ALERTS_KEY, alertStatusSummary, withAlertsSection } from '../shadcn/src/lib/alert-status.js';
import { serializeBoot } from '../api/_boot.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const VALID = {
    v: 1,
    office: 'LOX',
    product: { id: '2671521f-fef2-4bbe-826b-c0aed26f2a8a', issuanceTime: '2026-11-12T06:17:00+00:00', productText: '.SYNOPSIS...\nFog.\n\n&&\n' },
    translations: { Synopsis: 'Fog **near the coast**.', 'Short Term': 'Warmer.' },
    translationsComplete: true,
    changelog: { changelog: 'Cooler Thursday.', since: '2026-11-12T04:55:00+00:00', updated: '2026-11-12T06:17:00+00:00' },
};
const json = (o) => JSON.stringify(o);

describe('boot data parser', () => {
    afterEach(() => resetBootForTests());

    it('accepts the server shape, including the HTML-safe serialisation', () => {
        const boot = parseBoot(serializeBoot(VALID));
        expect(boot).toEqual(VALID);
    });

    it('rejects malformed JSON, wrong versions and missing products', () => {
        expect(parseBoot('')).toBe(null);
        expect(parseBoot('{not json')).toBe(null);
        expect(parseBoot(json({ ...VALID, v: 2 }))).toBe(null);
        expect(parseBoot(json([VALID]))).toBe(null);
        expect(parseBoot(json({ ...VALID, product: null }))).toBe(null);
        expect(parseBoot(json({ ...VALID, product: { ...VALID.product, productText: '   ' } }))).toBe(null);
        expect(parseBoot(json({ ...VALID, product: { ...VALID.product, id: '' } }))).toBe(null);
        expect(parseBoot(json({ ...VALID, product: { ...VALID.product, id: 'a/b' } }))).toBe(null);
        expect(parseBoot(json({ ...VALID, product: { ...VALID.product, issuanceTime: 'soon' } }))).toBe(null);
    });

    it('rejects an office that is not a 3-letter code', () => {
        expect(parseBoot(json({ ...VALID, office: 'lox' }))).toBe(null);
        expect(parseBoot(json({ ...VALID, office: '"><x' }))).toBe(null);
        expect(parseBoot(json({ ...VALID, office: undefined }))).toBe(null);
    });

    it('keeps only string translations, and "complete" only with translations', () => {
        const boot = parseBoot(json({ ...VALID, translations: { Synopsis: 'ok', Bad: 3, Empty: '  ' } }));
        expect(boot.translations).toEqual({ Synopsis: 'ok' });
        const none = parseBoot(json({ ...VALID, translations: { Bad: 3 } }));
        expect(none.translations).toBe(null);
        expect(none.translationsComplete).toBe(false);
        expect(parseBoot(json({ ...VALID, translations: ['x'] })).translations).toBe(null);
    });

    it('an absent or malformed changelog means "unknown"; a null sentence means "none"', () => {
        const { changelog, ...rest } = VALID;
        expect('changelog' in parseBoot(json(rest))).toBe(false);
        expect('changelog' in parseBoot(json({ ...rest, changelog: { changelog: 7 } }))).toBe(false);
        expect(parseBoot(json({ ...rest, changelog: { changelog: null, updated: VALID.product.issuanceTime } })).changelog)
            .toEqual({ changelog: null, since: null, updated: VALID.product.issuanceTime });
    });

    it('applies only to the latest edition of the reading view of its own office', () => {
        const boot = parseBoot(json(VALID));
        expect(bootFor(boot, { office: 'LOX', editionId: null, view: null })).toBe(boot);
        expect(bootFor(boot, { office: 'LOT', editionId: null, view: null })).toBe(null);
        expect(bootFor(boot, { office: 'LOX', editionId: 'older-id', view: null })).toBe(null);
        expect(bootFor(boot, { office: 'LOX', editionId: null, view: 'changelog' })).toBe(null);
        expect(bootFor(null, { office: 'LOX' })).toBe(null);
    });

    it('reads #plaincast-boot once', () => {
        let reads = 0;
        const doc = { getElementById: (id) => { reads++; return id === 'plaincast-boot' ? { textContent: json(VALID) } : null; } };
        expect(readBoot(doc).office).toBe('LOX');
        expect(readBoot(doc).office).toBe('LOX');
        expect(reads).toBe(1);
        resetBootForTests();
        expect(readBoot({ getElementById: () => null })).toBe(null);
        resetBootForTests();
        expect(readBoot({ getElementById: () => ({ textContent: '<html>' }) })).toBe(null);
    });
});

describe('AI memo priming (src/lib/ai.js)', () => {
    const savedFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = savedFetch;
        resetTranslationMemoForTests();
    });
    function stubFetch(body) {
        const calls = [];
        globalThis.fetch = async (url) => { calls.push(String(url)); return Response.json(body); };
        return calls;
    }

    it('a primed translation is readable synchronously, formatted like the GET path', () => {
        primeIssuanceTranslations('LOX', 'id-1', { Synopsis: 'Fog **near the coast**.\n\nThen sun.' }, true);
        const html = peekTranslation('LOX', 'id-1', 'Synopsis');
        expect(html).toBe(formatTranslationHTML('Fog **near the coast**.\n\nThen sun.'));
        expect(html).toBe('<p>Fog <strong>near the coast</strong>.</p><p>Then sun.</p>');
        expect(peekTranslation('LOX', 'id-1', 'Long Term')).toBe(null);
        expect(peekTranslation('LOX', 'id-2', 'Synopsis')).toBe(null);
        expect(peekTranslation('LOT', 'id-1', 'Synopsis')).toBe(null);
    });

    it('a complete primed set answers the issuance map without a request', async () => {
        const calls = stubFetch({ sections: { Synopsis: 'network' } });
        primeIssuanceTranslations('LOX', 'id-1', { Synopsis: 'primed' }, true);
        expect(await getIssuanceTranslations('LOX', 'id-1')).toEqual({ Synopsis: 'primed' });
        expect(await mapTranslation({ key: 'Synopsis' }, 'LOX', 'id-1')).toBe('<p>primed</p>');
        expect(calls).toEqual([]);
    });

    it('a partial primed set still fetches the map, and merges it', async () => {
        const calls = stubFetch({ sections: { 'Long Term': 'from the GET' } });
        primeIssuanceTranslations('LOX', 'id-1', { Synopsis: 'primed' }, false);
        expect(peekTranslation('LOX', 'id-1', 'Synopsis')).toBe('<p>primed</p>');
        expect(peekTranslation('LOX', 'id-1', 'Long Term')).toBe(null);
        expect(await getIssuanceTranslations('LOX', 'id-1')).toEqual({ Synopsis: 'primed', 'Long Term': 'from the GET' });
        expect(calls).toEqual(['/api/translate-issuance?office=LOX&id=id-1']);
        // Once resolved, the map is peekable too (a remount renders it at once).
        expect(peekTranslation('LOX', 'id-1', 'Long Term')).toBe('<p>from the GET</p>');
    });

    it('without priming, one shared GET serves every section', async () => {
        const calls = stubFetch({ sections: { Synopsis: 'a', 'Short Term': 'b' } });
        const [a, b, c] = await Promise.all([
            mapTranslation({ key: 'Synopsis' }, 'LOT', 'x'),
            mapTranslation({ key: 'Short Term' }, 'LOT', 'x'),
            mapTranslation({ key: 'Aviation' }, 'LOT', 'x'),
        ]);
        expect([a, b, c]).toEqual(['<p>a</p>', '<p>b</p>', null]);
        expect(calls.length).toBe(1);
    });

    it('a failed map soft-fails to null (the regex text stays)', async () => {
        globalThis.fetch = async () => { throw new Error('offline'); };
        expect(await mapTranslation({ key: 'Synopsis' }, 'LOX', 'id-9')).toBe(null);
    });
});

describe('ForecastSection: the first frame is the final text', () => {
    const src = read('shadcn/src/components/ForecastSection.jsx');

    it('initial state comes from the primed memo ("via Claude" from frame one)', () => {
        expect(src).toContain("const html = aiEligible ? peekTranslation(office, productId, section.key) : null;");
        expect(src).toContain("return html ? { status: 'done', html } :");
    });

    it('asks for the map on mount, not on intersection; only the POST waits for the viewport', () => {
        const effect = src.slice(src.indexOf('useEffect(() => {'));
        const mapCall = effect.indexOf('mapTranslation(section, office, productId)');
        const lazy = effect.indexOf('const lazyPost = () => {');
        const observer = effect.indexOf('new IntersectionObserver');
        const post = effect.indexOf('postTranslation(section, office, issuanceTime)');
        expect(mapCall).toBeGreaterThan(-1);
        expect(lazy).toBeGreaterThan(-1);
        // The observer and the POST both live inside lazyPost…
        expect(observer).toBeGreaterThan(lazy);
        expect(post).toBeGreaterThan(lazy);
        // …and the map call is not behind the observer.
        expect(effect.slice(effect.indexOf('if (!productId) {'))).toContain('mapTranslation(');
        expect(src).not.toContain('translateSection(');
    });

    it('skips all fetching once the translation is in hand', () => {
        expect(src).toContain("if (!aiEligible || aiRef.current.status === 'done') return;");
    });
});

describe('alert status line', () => {
    const a = (event, extra = {}) => ({ id: `${event}-${Math.random()}`, event, ends: '2026-11-13T00:00:00Z', severity: 'Moderate', ...extra });

    it('counts distinct alerts, names the most severe first, then "+N"', () => {
        const s = alertStatusSummary([
            a('High Surf Advisory'), a('Beach Hazards Statement'), a('Coastal Flood Watch'),
            a('Wind Advisory'), a('Rip Current Statement'),
        ]);
        expect(s.count).toBe(5);
        expect(s.text).toBe('5 active alerts: Coastal Flood Watch, High Surf Advisory +3');
        expect(s.label).toBe('5 active alerts: Coastal Flood Watch, High Surf Advisory, Wind Advisory, Beach Hazards Statement, Rip Current Statement. Jump to the alerts.');
    });

    it('ranks warnings first, and Extreme/Severe before lesser ones of the same kind', () => {
        const s = alertStatusSummary([
            a('Wind Advisory'), a('Flood Warning', { severity: 'Moderate' }), a('Tornado Warning', { severity: 'Extreme' }),
        ]);
        expect(s.shown).toEqual(['Tornado Warning', 'Flood Warning']);
        expect(s.text).toBe('3 active alerts: Tornado Warning, Flood Warning +1');
    });

    it('groups zone duplicates like the Active Alerts card, and says "1 active alert"', () => {
        const s = alertStatusSummary([a('Frost Advisory', { areaDesc: 'Kona' }), a('Frost Advisory', { areaDesc: 'Kohala' })]);
        expect(s.count).toBe(1);
        expect(s.text).toBe('1 active alert: Frost Advisory');
    });

    it('two groups of the same event are covered by one name', () => {
        const s = alertStatusSummary([a('Wind Advisory'), a('Wind Advisory', { ends: '2026-11-14T00:00:00Z' }), a('Freeze Watch'), a('Frost Advisory')]);
        expect(s.text).toBe('4 active alerts: Freeze Watch, Wind Advisory +1');
    });

    it('is null with no alerts', () => {
        expect(alertStatusSummary([])).toBe(null);
    });
});

describe('alert section order', () => {
    const keys = ['Synopsis', 'Short Term', 'Long Term'];

    it('goes LAST, so a late arrival appends below painted content', () => {
        expect(withAlertsSection(keys, { liveAlerts: true, severe: false })).toEqual([...keys, ALERTS_KEY]);
    });

    it('is pinned FIRST while a Severe/Extreme warning is live', () => {
        expect(withAlertsSection(keys, { liveAlerts: true, severe: true })).toEqual([ALERTS_KEY, ...keys]);
    });

    it('is absent without live alerts', () => {
        expect(withAlertsSection(keys, { liveAlerts: false, severe: false })).toEqual(keys);
    });

    it('App renders the section and the nav by the same rule', () => {
        const app = read('shadcn/src/App.jsx');
        expect(app).toContain('const alertsFirst = alerts.length > 0 && severe;');
        expect(app).toContain('withAlertsSection(displaySections.map(s => s.key), { liveAlerts: alerts.length > 0, severe })');
        const list = app.slice(app.indexOf('<div className="mt-2">'), app.indexOf('</ErrorBoundary>', app.indexOf('<div className="mt-2">')));
        const first = list.indexOf('{alertsFirst && (');
        const sections = list.indexOf('{displaySections.map(');
        const last = list.indexOf('{!alertsFirst && (');
        expect(first).toBeGreaterThan(-1);
        expect(first).toBeLessThan(sections);
        expect(last).toBeGreaterThan(sections);
    });
});

describe('App boot path', () => {
    const app = read('shadcn/src/App.jsx');

    it('initialises state synchronously from the boot edition (no skeleton frame)', () => {
        expect(app).toContain('const [initial] = useState(initialApp);');
        expect(app).toContain('const [state, setState] = useState(initial.state);');
        expect(app).toContain('primeIssuanceTranslations(loc.office, boot.product.id, boot.translations, boot.translationsComplete);');
    });

    it('the boot path revalidates without resetting the page', () => {
        const reval = app.slice(app.indexOf('const revalidate = useCallback'), app.indexOf('useEffect(() => {', app.indexOf('const revalidate = useCallback')));
        expect(reval).not.toContain("setState({ status: 'loading' })");
        expect(reval).not.toContain('setAlerts([])');
        expect(reval).not.toContain('setDiffs(null)');
        expect(reval).toContain('setNewerEdition(items[0].id)');
        expect(reval).toContain('if (gen !== generation.current) return;');
    });

    it('the newer-edition banner floats instead of pushing the page', () => {
        expect(app).toContain('pointer-events-none fixed inset-x-0 bottom-0 z-40');
    });

    it('the status row is a fixed-height line in the intro', () => {
        const intro = read('shadcn/src/components/PageIntro.jsx');
        expect(intro).toContain('data-slot="status-row"');
        expect(intro).toMatch(/data-slot="status-row"\s+className=\{cn\('flex h-7 /);
        expect(intro).toContain('href="#section-active-alerts"');
        expect(intro).toContain('aria-label={label}');
    });
});

describe('"Since the … update" holds its place while it loads', () => {
    it('the intro reserves the callout (skeleton lines) while the sentence is pending', () => {
        const intro = read('shadcn/src/components/PageIntro.jsx');
        expect(intro).toContain('const sinceHeld = !since && changelogPending && !viewingHistorical;');
        expect(intro).toContain(') : sinceHeld ? (');
        // The links sit where they will sit once the sentence arrives.
        expect(intro).toContain("since || sinceHeld ? 'mt-2'");
    });

    it('App marks it pending only when the server did not resolve it, and settles on every outcome', () => {
        const app = read('shadcn/src/App.jsx');
        expect(app).toContain('useState(() => Boolean(initial.boot) && initial.boot.changelog === undefined)');
        const extras = app.slice(app.indexOf('const loadExtras = useCallback'), app.indexOf('const load = useCallback'));
        expect(extras).toContain('setChangelogPending(true);');
        expect(extras).toContain('setChangelogPending(false);');
        // A newer issuance's sentence is never shown for the edition on screen.
        expect(extras).toContain('fetchChangelog(code, product.id)');
    });

    it('fetchChangelog pins to an issuance with ?id=', async () => {
        const { fetchChangelog } = await import('../shadcn/src/lib/nws.js');
        const saved = globalThis.fetch;
        const calls = [];
        globalThis.fetch = async (url) => { calls.push(String(url)); return Response.json({ changelog: 'x' }); };
        try {
            await fetchChangelog('LOX');
            await fetchChangelog('LOX', 'a1:b.c');
        } finally {
            globalThis.fetch = saved;
        }
        expect(calls).toEqual(['/api/changelog?office=LOX', '/api/changelog?office=LOX&id=a1%3Ab.c']);
    });
});
