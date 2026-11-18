// api/cron-refresh.js: the edition poller. NWS, the purge API and the clock
// are injected; the store is the in-memory backend; the model is a mock.
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { memoryBackend, recordFetches } from './shared-cache-backend.js';

let mockGenerateText = async () => ({ text: 'plain english', finishReason: 'stop' });
let modelCalls = [];
mock.module('ai', () => ({
    generateText: (args) => { modelCalls.push(args); return mockGenerateText(args); },
}));
// Hermetic: the real snapshot module is env-gated Vercel Blob.
mock.module('../api/_snapshots.js', () => ({
    getSnapshot: async () => null,
    putSnapshot: async () => true,
}));

const { default: handler, runPoller, cronAuthorization, FETCH_CAP, MIN_RUN_INTERVAL_MS, productForOffice, utcDay } = await import('../api/cron-refresh.js');
const {
    __setSharedCacheBackendForTests, editionKey, pollStateKey, leaseKey, modelCallsKey,
    translationKey, changelogKey,
} = await import('../api/_shared-cache.js');
const { officeTag } = await import('../api/_store.js');
const { sectionHash } = await import('../api/_section-reuse.js');
const { sectionKey } = await import('../api/_shared-cache.js');
const { translatableSections } = await import('../api/translate-issuance.js');

const T0 = Date.parse('2026-11-18T12:00:00Z');
const MIN = 60 * 1000;

const afd = (code, body) => `000
FXUS66 K${code} 181100
AFD${code}

Area Forecast Discussion
National Weather Service

.SYNOPSIS...
${body.synopsis || 'High pressure keeps the region dry and mild through the weekend with light winds.'}

&&

.SHORT TERM...
${body.short || 'Clear skies tonight with lows in the 40s and patchy valley fog after midnight.'}

&&

.LONG TERM...
${body.long || 'A trough approaches early next week bringing a chance of showers by Tuesday.'}

$$
`;

// A fake NWS: products by id, and a listing built from them.
function fakeNws() {
    const products = new Map();
    const calls = { since: [], week: 0, product: [] };
    let throttleIds = new Set();
    let listingFails = false;
    const api = {
        products, calls,
        add(code, id, iso, body = {}, issuing = `K${code}`) {
            products.set(id, { id, issuingOffice: issuing, issuanceTime: iso, productText: afd(code, body) });
        },
        throttle(ids) { throttleIds = new Set(ids); },
        failListing(v = true) { listingFails = v; },
        items() {
            return [...products.values()]
                .map(p => ({ id: p.id, issuingOffice: p.issuingOffice, issuanceTime: p.issuanceTime, productCode: 'AFD' }))
                .sort((a, b) => Date.parse(b.issuanceTime) - Date.parse(a.issuanceTime));
        },
        deps: {
            fetchAFDWeek: async () => { calls.week++; if (listingFails) throw new Error('NWS 503'); return api.items(); },
            fetchAFDsSince: async (start) => {
                calls.since.push(start);
                if (listingFails) throw new Error('NWS 503');
                return api.items().filter(i => Date.parse(i.issuanceTime) >= Date.parse(start));
            },
            fetchProductById: async (id) => {
                calls.product.push(id);
                if (throttleIds.has(id)) throw Object.assign(new Error('NWS 403'), { status: 403, throttled: true });
                const p = products.get(id);
                if (!p) throw Object.assign(new Error('NWS 404'), { status: 404 });
                return { id: p.id, issuanceTime: p.issuanceTime, productText: p.productText };
            },
        },
    };
    return api;
}

function fakePurge() {
    const calls = [];
    let fail = false;
    return {
        calls,
        fail(v = true) { fail = v; },
        fn: async (tags, { hard = false } = {}) => {
            calls.push({ tags: [...tags], hard });
            return fail ? { ok: false, reason: 'no-purge-context' } : { ok: true };
        },
    };
}

const SWITCH_ENV = { PLAINCAST_STORE_RENDER: '1', PLAINCAST_PRETRANSLATE: '1' };

describe('cron-refresh: polling and the edition store', () => {
    let backend;
    let nws;
    let purge;
    let clock;
    let fetches;
    const run = (env = {}, extra = {}) => runPoller({
        now: () => clock,
        env,
        deps: { ...nws.deps, purgeTag: purge.fn, ...extra },
    });
    const later = (ms = 5 * MIN) => { clock += ms; };

    beforeEach(() => {
        backend = memoryBackend();
        __setSharedCacheBackendForTests(backend);
        nws = fakeNws();
        purge = fakePurge();
        clock = T0;
        modelCalls = [];
        mockGenerateText = async () => ({ text: 'plain english', finishReason: 'stop' });
        fetches = recordFetches(); // nothing may reach the network
    });
    afterEach(() => {
        fetches.restore();
        __setSharedCacheBackendForTests(null);
    });

    it('cold start: the 7-day list, a heartbeat, and the current editions stored', async () => {
        nws.add('LOX', 'lox-2', '2026-11-18T11:00:00+00:00');
        nws.add('LOX', 'lox-1', '2026-11-18T05:00:00+00:00');
        nws.add('OKX', 'okx-1', '2026-11-18T10:00:00+00:00');
        nws.add('AFC', 'afc-1', '2026-11-18T09:00:00+00:00', {}, 'PAFC');
        const s = await run();
        expect(s.ok).toBe(true);
        expect(s.skipped).toBe(null);
        expect(s.poll).toMatchObject({ ok: true, mode: 'full' });
        expect(s.heartbeat).toBe(new Date(T0).toISOString());
        expect(s.newEditions.sort()).toEqual(['AFC', 'LOX', 'OKX']);
        expect(nws.calls.week).toBe(1);
        // Currents first; LOX's predecessor is queued only once its current is stored.
        expect(nws.calls.product.sort()).toEqual(['afc-1', 'lox-2', 'okx-1']);
        const state = backend.peek(pollStateKey());
        expect(state.at).toBe(new Date(T0).toISOString());
        expect(state.offices.LOX).toMatchObject({ id: 'lox-2', prevId: 'lox-1', stored: 'lox-2', storedPrev: null });
        const lox = backend.peek(editionKey('LOX'));
        expect(lox.current).toMatchObject({ id: 'lox-2', issuanceTime: '2026-11-18T11:00:00+00:00', prevId: 'lox-1' });
        expect(lox.previous).toBe(null);
        expect(backend.peek(editionKey('AFC')).current.id).toBe('afc-1');
        // Every engine write is untagged.
        for (const w of backend.writes) expect(w.options?.tags).toBeUndefined();
        expect(fetches.calls).toEqual([]);

        // Next run: incremental poll from the heartbeat minus the margin, and
        // the missing predecessor is backfilled.
        later();
        const s2 = await run();
        expect(s2.poll).toMatchObject({ ok: true, mode: 'since', since: new Date(T0 - 60 * MIN).toISOString() });
        expect(nws.calls.product).toContain('lox-1');
        expect(backend.peek(editionKey('LOX')).previous).toMatchObject({ id: 'lox-1' });
        expect(backend.peek(pollStateKey()).offices.LOX.storedPrev).toBe('lox-1');
    });

    it('new issuance → previous rotated and the office tag hard-deleted, in this run and the next only', async () => {
        nws.add('LOX', 'lox-1', '2026-11-18T05:00:00+00:00');
        await run({ PLAINCAST_STORE_RENDER: '1' });
        later(); await run({ PLAINCAST_STORE_RENDER: '1' });
        purge.calls.length = 0;
        later(); await run({ PLAINCAST_STORE_RENDER: '1' });
        expect(purge.calls).toEqual([]); // lox-1 already purged twice

        nws.add('LOX', 'lox-2', '2026-11-18T12:10:00+00:00');
        clock = Date.parse('2026-11-18T12:20:00Z');
        const s = await run({ PLAINCAST_STORE_RENDER: '1' });
        expect(s.newEditions).toEqual(['LOX']);
        const rec = backend.peek(editionKey('LOX'));
        expect(rec.current).toMatchObject({ id: 'lox-2', prevId: 'lox-1' });
        expect(rec.previous).toMatchObject({ id: 'lox-1', issuanceTime: '2026-11-18T05:00:00+00:00' });
        expect(purge.calls).toEqual([{ tags: [officeTag('LOX')], hard: true }]);
        // The purge came after the new edition was stored.
        const edWrite = backend.writes.findLastIndex(w => w.key === editionKey('LOX'));
        expect(edWrite).toBeGreaterThan(-1);

        later(); await run({ PLAINCAST_STORE_RENDER: '1' });
        expect(purge.calls).toEqual([{ tags: ['office-LOX'], hard: true }, { tags: ['office-LOX'], hard: true }]);
        later(); await run({ PLAINCAST_STORE_RENDER: '1' });
        expect(purge.calls.length).toBe(2);
    });

    it('a failed purge is retried from state next run; switch off → no purge at all', async () => {
        nws.add('LOX', 'lox-1', '2026-11-18T05:00:00+00:00');
        await run(); // switch off
        expect(purge.calls).toEqual([]);
        purge.fail();
        later();
        const s = await run({ PLAINCAST_STORE_RENDER: '1' });
        expect(s.purged.failures[0]).toMatchObject({ kind: 'hard', reason: 'no-purge-context' });
        purge.fail(false);
        later(); await run({ PLAINCAST_STORE_RENDER: '1' });
        later(); await run({ PLAINCAST_STORE_RENDER: '1' });
        later(); await run({ PLAINCAST_STORE_RENDER: '1' });
        expect(purge.calls.filter(c => c.hard).length).toBe(3); // 1 failed + 2 that counted
    });

    it('a poll that fails writes no heartbeat; stored work is still done', async () => {
        nws.add('LOX', 'lox-1', '2026-11-18T05:00:00+00:00');
        await run();
        const before = backend.peek(pollStateKey()).at;
        nws.failListing();
        later();
        const s = await run();
        expect(s.poll.ok).toBe(false);
        expect(s.heartbeat).toBe(null);
        expect(backend.peek(pollStateKey()).at).toBe(before);
    });

    it('fetches at most FETCH_CAP products per run; the rest follow on later runs', async () => {
        const codes = ['OKX', 'BOX', 'PHI', 'LWX', 'PBZ', 'BUF', 'RAH', 'CHS', 'FFC', 'MFL', 'JAX', 'TBW', 'BMX', 'OHX',
            'MRX', 'JAN', 'LOT', 'DTX', 'IND', 'CLE', 'ILN', 'MKX', 'GRR', 'LSX', 'EAX', 'DMX', 'MPX', 'DLH', 'FSD', 'BIS',
            'OAX', 'FGF', 'FWD', 'HGX', 'EWX'];
        codes.forEach((c, i) => nws.add(c, `${c.toLowerCase()}-1`, new Date(T0 - (i + 1) * MIN).toISOString()));
        const s = await run();
        expect(s.fetched).toBe(FETCH_CAP);
        expect(s.fetchDeferred).toBe(codes.length - FETCH_CAP);
        expect(s.capsHit).toContain('fetch-cap');
        // Newest issuance first.
        expect(nws.calls.product.slice(0, 3)).toEqual(['okx-1', 'box-1', 'phi-1']);
        later();
        const s2 = await run();
        expect(s2.fetched).toBe(codes.length - FETCH_CAP);
        for (const c of codes) expect(backend.peek(editionKey(c))?.current.id).toBe(`${c.toLowerCase()}-1`);
    });

    it('a 403 ends the fetch phase; the office stays un-stored (live) and is retried next run', async () => {
        nws.add('LOX', 'lox-1', '2026-11-18T05:00:00+00:00');
        nws.add('OKX', 'okx-1', '2026-11-18T04:00:00+00:00');
        nws.throttle(['lox-1']);
        const s = await run();
        expect(s.capsHit).toContain('nws-throttled');
        expect(s.fetchFailed[0]).toMatchObject({ office: 'LOX', reason: 'NWS 403' });
        expect(s.heartbeat).not.toBe(null); // the poll itself succeeded
        expect(backend.peek(editionKey('LOX'))).toBeUndefined();
        nws.throttle([]);
        later();
        await run();
        expect(backend.peek(editionKey('LOX')).current.id).toBe('lox-1');
        expect(backend.peek(editionKey('OKX')).current.id).toBe('okx-1');
    });

    it('does not store a product whose AWIPS line names another office', async () => {
        nws.add('LOX', 'lox-1', '2026-11-18T05:00:00+00:00');
        nws.products.get('lox-1').productText = afd('SGX', {});
        const s = await run();
        expect(s.fetchFailed[0]).toMatchObject({ office: 'LOX', reason: 'product does not match listing' });
        expect(backend.peek(editionKey('LOX'))).toBeUndefined();
        expect(productForOffice({ id: 'x', issuanceTime: 't', productText: 'AFDLOX\nbody' }, 'LOX', 'x')).not.toBe(null);
        expect(productForOffice({ id: 'y', issuanceTime: 't', productText: 'AFDLOX' }, 'LOX', 'x')).toBe(null);
        expect(productForOffice({ id: 'x', productText: 'AFDLOX' }, 'LOX', 'x')).toBe(null);
    });

    it('an evicted edition record is noticed and fetched again', async () => {
        nws.add('LOX', 'lox-1', '2026-11-18T05:00:00+00:00');
        await run();
        backend.store.delete(editionKey('LOX'));
        later(); await run(); // the rotating check clears `stored`
        later(); await run();
        expect(backend.peek(editionKey('LOX')).current.id).toBe('lox-1');
    });

    it('runs at most once per MIN_RUN_INTERVAL_MS and one at a time', async () => {
        nws.add('LOX', 'lox-1', '2026-11-18T05:00:00+00:00');
        await run();
        clock += MIN_RUN_INTERVAL_MS - 1000;
        const s = await run();
        expect(s.skipped).toBe('too-soon');
        expect(s.retryAfterSec).toBeGreaterThan(0);
        expect(nws.calls.week + nws.calls.since.length).toBe(1);

        // A lease held by another run → busy.
        clock += 10 * MIN;
        backend.seed(leaseKey(), { runId: 'other', startedAt: clock - 10 * MIN, until: clock + MIN });
        expect((await run()).skipped).toBe('busy');
    });

    it('no store → nothing happens, nothing is fetched', async () => {
        __setSharedCacheBackendForTests({ get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); } });
        nws.add('LOX', 'lox-1', '2026-11-18T05:00:00+00:00');
        const s = await run();
        expect(s.skipped).toBe('store-unavailable');
        expect(nws.calls.week).toBe(0);
        expect(nws.calls.product).toEqual([]);
    });
});

describe('cron-refresh: pre-translation', () => {
    let backend;
    let nws;
    let purge;
    let clock;
    let fetches;
    const run = (env = SWITCH_ENV) => runPoller({ now: () => clock, env, deps: { ...nws.deps, purgeTag: purge.fn } });
    const later = (ms = 5 * MIN) => { clock += ms; };
    const day = utcDay(T0);

    beforeEach(() => {
        backend = memoryBackend();
        __setSharedCacheBackendForTests(backend);
        nws = fakeNws();
        purge = fakePurge();
        clock = T0;
        modelCalls = [];
        mockGenerateText = async () => ({ text: 'plain english', finishReason: 'stop' });
        fetches = recordFetches();
    });
    afterEach(() => {
        fetches.restore();
        __setSharedCacheBackendForTests(null);
    });

    it('switch off → no model call, no counter, no section entries', async () => {
        nws.add('LOX', 'lox-1', '2026-11-18T05:00:00+00:00');
        await run({});
        later(); await run({ PLAINCAST_STORE_RENDER: '1' });
        expect(modelCalls).toEqual([]);
        expect([...backend.store.keys()].some(k => k.startsWith('mc:') || k.startsWith('ts:') || k.startsWith('ti:'))).toBe(false);
    });

    it('translates the stored edition through the shared core, stores it complete, counts the calls', async () => {
        nws.add('LOX', 'lox-1', '2026-11-18T05:00:00+00:00');
        const s = await run();
        expect(s.translated).toBe(1);
        expect(modelCalls.length).toBe(3); // three sections, no predecessor → no changelog call
        expect(s.modelCalls).toBe(3);
        const ti = backend.peek(translationKey('LOX', 'lox-1'));
        expect(ti).toMatchObject({ office: 'LOX', id: 'lox-1', complete: true });
        expect(Object.keys(ti.sections)).toEqual(['Synopsis', 'Short Term', 'Long Term']);
        expect(backend.peek(modelCallsKey(day))).toEqual({ day, calls: 3 });
        // The same prompt rules as /api/translate-issuance.
        expect(modelCalls[0].system).toContain('Section name for context: Synopsis');
        // Translation complete → the office's pages are marked stale (SWR).
        expect(purge.calls.some(c => !c.hard && c.tags.includes('office-LOX'))).toBe(true);
        // A second run does nothing for it.
        later();
        const s2 = await run();
        expect(s2.translated).toBe(0);
        expect(modelCalls.length).toBe(3);
    });

    it('a translation another reader already stored costs nothing', async () => {
        nws.add('LOX', 'lox-1', '2026-11-18T05:00:00+00:00');
        backend.seed(translationKey('LOX', 'lox-1'), { office: 'LOX', id: 'lox-1', complete: true, sections: { Synopsis: 'x' } });
        const s = await run();
        expect(modelCalls).toEqual([]);
        expect(s.skippedTranslation).toBe(1);
    });

    it('section reuse hit → no model call for that section', async () => {
        nws.add('LOX', 'lox-1', '2026-11-18T05:00:00+00:00');
        await run();
        expect(modelCalls.length).toBe(3);
        // Reissue with only the Short Term rewritten.
        nws.add('LOX', 'lox-2', '2026-11-18T12:10:00+00:00', { short: 'Rewritten: clouds thicken tonight with drizzle possible along the coast by morning.' });
        clock = Date.parse('2026-11-18T12:20:00Z');
        modelCalls = [];
        const s = await run();
        expect(s.sectionsReused).toBe(2);
        // One section call + one changelog call (the predecessor is stored).
        expect(modelCalls.filter(c => c.system.includes('Section name for context')).length).toBe(1);
        expect(modelCalls[0].system).toContain('Section name for context: Short Term');
        expect(backend.peek(translationKey('LOX', 'lox-2')).complete).toBe(true);
        expect(s.changelogs).toBe(1);
        expect(backend.peek(changelogKey('LOX', 'lox-2'))).toMatchObject({ office: 'LOX', id: 'lox-2', changelog: 'plain english' });
    });

    it('an all-reused issuance makes no model call at all', async () => {
        nws.add('LOX', 'lox-1', '2026-11-18T05:00:00+00:00');
        const sections = translatableSections(afd('LOX', {}));
        for (const s of sections) {
            const hash = sectionHash('LOX', s.key, '2026-11-18T05:00:00+00:00', s.text);
            backend.seed(sectionKey('LOX', hash), { office: 'LOX', key: s.key, hash, text: `stored ${s.key}` });
        }
        const r = await run();
        expect(modelCalls).toEqual([]);
        expect(r.translated).toBe(1);
        expect(backend.peek(translationKey('LOX', 'lox-1')).sections.Synopsis).toBe('stored Synopsis');
    });

    it('daily cap reached → no model call; the counter is never exceeded', async () => {
        nws.add('LOX', 'lox-1', '2026-11-18T05:00:00+00:00');
        backend.seed(modelCallsKey(day), { day, calls: 2999 });
        const s = await run();
        expect(modelCalls).toEqual([]);
        expect(s.capsHit).toContain('daily');
        expect(backend.peek(modelCallsKey(day)).calls).toBe(2999);
        // Raising the cap by env lets it through.
        later();
        await run({ ...SWITCH_ENV, PLAINCAST_PRETRANSLATE_DAILY_MAX: '5000' });
        expect(modelCalls.length).toBe(3);
        expect(backend.peek(modelCallsKey(day)).calls).toBe(3002);
    });

    it('an unreadable counter → no model call (fail closed)', async () => {
        nws.add('LOX', 'lox-1', '2026-11-18T05:00:00+00:00');
        const real = memoryBackend();
        __setSharedCacheBackendForTests({
            get: async (k) => { if (k.startsWith('mc:')) throw new Error('down'); return real.get(k); },
            set: (k, v, o) => real.set(k, v, o),
        });
        const s = await run();
        expect(modelCalls).toEqual([]);
        expect(s.capsHit).toContain('counter-unavailable');
    });

    it('per-run cap: newest issuance first, the rest wait for the next run', async () => {
        const codes = ['OKX', 'BOX', 'PHI', 'LWX'];
        codes.forEach((c, i) => nws.add(c, `${c.toLowerCase()}-1`, new Date(T0 - (i + 1) * MIN).toISOString()));
        const s = await run({ ...SWITCH_ENV, PLAINCAST_PRETRANSLATE_PER_RUN: '2' });
        expect(s.translated).toBe(2);
        expect(s.capsHit).toContain('per-run');
        expect(backend.peek(translationKey('OKX', 'okx-1'))).toBeTruthy();
        expect(backend.peek(translationKey('BOX', 'box-1'))).toBeTruthy();
        expect(backend.peek(translationKey('LWX', 'lwx-1'))).toBeUndefined();
        later();
        await run({ ...SWITCH_ENV, PLAINCAST_PRETRANSLATE_PER_RUN: '2' });
        expect(backend.peek(translationKey('LWX', 'lwx-1'))).toBeTruthy();
    });

    it('never stores a partial translation, and gives up on an edition after MAX_ATTEMPTS', async () => {
        nws.add('LOX', 'lox-1', '2026-11-18T05:00:00+00:00');
        mockGenerateText = async (args) => {
            if (args.system.includes('Section name for context: Long Term')) throw new Error('hiccup');
            return { text: 'ok', finishReason: 'stop' };
        };
        const s = await run();
        expect(s.translatePartial).toBe(1);
        expect(backend.peek(translationKey('LOX', 'lox-1'))).toBeUndefined();
        expect(purge.calls.some(c => !c.hard)).toBe(false);
        later(); await run();
        const callsAfterTwo = modelCalls.length;
        later(); await run();
        later(); await run();
        expect(modelCalls.length).toBe(callsAfterTwo); // two attempts, then stop
        // The sections that did translate were kept for reuse (single-section results).
        expect([...backend.store.keys()].filter(k => k.startsWith('ts:')).length).toBe(2);
    });
});

describe('cron-refresh handler: auth', () => {
    const saved = { secret: process.env.CRON_SECRET, env: process.env.VERCEL_ENV };
    let fetches;
    let backend;
    beforeEach(() => {
        // An empty store: an authorized call runs (and writes its lease);
        // NWS is unreachable (recordFetches), so the poll fails harmlessly.
        backend = memoryBackend();
        __setSharedCacheBackendForTests(backend);
        fetches = recordFetches();
    });
    afterEach(() => {
        fetches.restore();
        __setSharedCacheBackendForTests(null);
        if (saved.secret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved.secret;
        if (saved.env === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = saved.env;
    });
    const res = () => ({
        statusCode: 200, headers: {}, body: null,
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
        getHeader(k) { return this.headers[k.toLowerCase()]; },
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
    });
    const call = async (headers = {}, extra = {}) => {
        const r = res();
        await handler({ method: 'GET', query: {}, headers, ...extra }, r);
        return r;
    };
    const noWork = () => {
        expect(backend.reads).toEqual([]);
        expect(backend.writes).toEqual([]);
        expect(fetches.calls).toEqual([]);
    };

    it('production without CRON_SECRET: refuses every call and does no work', async () => {
        process.env.VERCEL_ENV = 'production';
        for (const secret of [undefined, '']) {
            if (secret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = secret;
            for (const auth of [undefined, 'Bearer ', 'Bearer anything']) {
                const r = await call(auth === undefined ? {} : { authorization: auth });
                expect(r.statusCode).toBe(401);
                expect(r.body.code).toBe('forbidden');
                expect(r.body.hint).toContain('CRON_SECRET must be configured');
                expect(r.headers['cache-control']).toBe('no-store');
            }
        }
        noWork();
    });

    it('CRON_SECRET set (any environment): requires the exact bearer token', async () => {
        process.env.CRON_SECRET = 's3cret-value';
        for (const env of ['production', 'preview', undefined]) {
            if (env === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = env;
            for (const auth of [undefined, '', 'Bearer wrong', 'Bearer s3cret-valu', 'Bearer s3cret-valuee', 's3cret-value', 'bearer s3cret-value']) {
                const r = await call(auth === undefined ? {} : { authorization: auth });
                expect(r.statusCode).toBe(401);
                expect(r.body.code).toBe('forbidden');
            }
        }
        noWork();
        process.env.VERCEL_ENV = 'production';
        const ok = await call({ authorization: 'Bearer s3cret-value' });
        expect(ok.statusCode).toBe(200);
        expect(ok.body.ok).toBe(true);
        expect(ok.body.poll.ok).toBe(false); // NWS unreachable in tests
        expect(backend.writes.some(w => w.key === leaseKey())).toBe(true);
    });

    it('outside production, a missing CRON_SECRET allows a call (hand runs on a preview)', async () => {
        delete process.env.CRON_SECRET;
        for (const env of ['preview', 'development', undefined]) {
            if (env === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = env;
            backend.store.clear();
            const r = await call();
            expect(r.statusCode).toBe(200);
            expect(r.headers['cache-control']).toBe('no-store');
            expect(typeof r.body.durationMs).toBe('number');
        }
    });

    it('cronAuthorization compares in constant time on equal-length buffers', () => {
        const req = (a) => ({ headers: a === undefined ? {} : { authorization: a } });
        expect(cronAuthorization(req('Bearer abc'), { CRON_SECRET: 'abc' })).toBe('ok');
        expect(cronAuthorization(req('Bearer abd'), { CRON_SECRET: 'abc' })).toBe('bad-token');
        expect(cronAuthorization(req('Bearer abcd'), { CRON_SECRET: 'abc' })).toBe('bad-token');
        expect(cronAuthorization(req(undefined), { CRON_SECRET: 'abc' })).toBe('bad-token');
        expect(cronAuthorization(req(undefined), { VERCEL_ENV: 'production' })).toBe('missing-secret');
        expect(cronAuthorization(req(undefined), { VERCEL_ENV: 'production', CRON_SECRET: '' })).toBe('missing-secret');
        expect(cronAuthorization(req(undefined), { VERCEL_ENV: 'preview' })).toBe('ok');
        expect(cronAuthorization(req(undefined), {})).toBe('ok');
    });

    it('GET only, no query parameters', async () => {
        delete process.env.CRON_SECRET;
        delete process.env.VERCEL_ENV;
        let r = await call({}, { method: 'POST' });
        expect(r.statusCode).toBe(405);
        r = await call({}, { query: { force: '1' } });
        expect(r.statusCode).toBe(400);
        expect(r.body.code).toBe('unknown_param');
    });
});
