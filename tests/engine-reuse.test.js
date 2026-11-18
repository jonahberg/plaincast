// Section reuse on the on-demand path (/api/translate-issuance), gated by
// PLAINCAST_PRETRANSLATE, and the poller's NWS client (api/_nws-feed.js).
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { memoryBackend, recordFetches } from './shared-cache-backend.js';

let modelCalls = [];
mock.module('ai', () => ({
    generateText: async (args) => { modelCalls.push(args); return { text: `fresh ${modelCalls.length}`, finishReason: 'stop' }; },
}));
mock.module('../api/_snapshots.js', () => ({ getSnapshot: async () => null, putSnapshot: async () => true }));

const AFD = `000
FXUS66 KLOX 241825
AFDLOX

.SYNOPSIS...A dry pattern holds through the weekend with highs in the low 80s across the valleys.

&&

.SHORT TERM...Dry conditions continue tonight with patchy fog developing along the coast after midnight.

$$`;
let mockList = [];
mock.module('../api/_utils.js', () => ({
    fetchSevereAlerts: async () => [],
    fetchAlertTotals: async () => null,
    fetchSpcDy1: async () => null,
    fetchSpcOutlook: async () => null,
    fetchAlertById: async () => null,
    fetchAFDList: async () => mockList,
    fetchAFDProduct: async () => ({ productText: AFD, issuanceTime: '2026-03-24T18:25:00+00:00' }),
    productUrlFromItem: (item) => item?.id || null,
}));

const { default: handler, coldBudget } = await import('../api/translate-issuance.js');
const { __setSharedCacheBackendForTests } = await import('../api/_shared-cache.js');
const { sectionHash, findReusedSection } = await import('../api/_section-reuse.js');
const { fetchAFDsSince, fetchAFDWeek, fetchProductById, NWS_USER_AGENT } = await import('../api/_nws-feed.js');

const saved = process.env.PLAINCAST_PRETRANSLATE;
let backend;
let n = 0;
const res = () => ({
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
});
async function translate(id) {
    const r = res();
    n += 1;
    await handler({ method: 'GET', query: { office: 'LOX', id }, headers: { 'x-forwarded-for': `10.77.0.${n}` }, socket: {} }, r);
    return r;
}

describe('on-demand translation: section reuse only with PLAINCAST_PRETRANSLATE=1', () => {
    beforeEach(() => {
        backend = memoryBackend();
        __setSharedCacheBackendForTests(backend);
        modelCalls = [];
        coldBudget.reset();
    });
    afterEach(() => {
        __setSharedCacheBackendForTests(null);
        if (saved === undefined) delete process.env.PLAINCAST_PRETRANSLATE; else process.env.PLAINCAST_PRETRANSLATE = saved;
    });

    it('off: no section entry is read or written', async () => {
        delete process.env.PLAINCAST_PRETRANSLATE;
        mockList = [{ id: 'reuse-off-1' }];
        const r = await translate('reuse-off-1');
        expect(r.body.complete).toBe(true);
        expect(modelCalls.length).toBe(2);
        expect(backend.reads.some(k => k.startsWith('ts:'))).toBe(false);
        expect(backend.writes.some(w => w.key.startsWith('ts:'))).toBe(false);
    });

    it('on: fresh sections are stored untagged; a reissue with the same text costs no call', async () => {
        process.env.PLAINCAST_PRETRANSLATE = '1';
        mockList = [{ id: 'reuse-on-1' }, { id: 'reuse-on-2' }];
        const first = await translate('reuse-on-1');
        expect(modelCalls.length).toBe(2);
        const ts = backend.writes.filter(w => w.key.startsWith('ts:'));
        expect(ts.length).toBe(2);
        for (const w of ts) expect(w.options.tags).toBeUndefined();

        const second = await translate('reuse-on-2'); // same product text, another id
        expect(modelCalls.length).toBe(2);
        expect(second.body.complete).toBe(true);
        expect(second.body.sections).toEqual(first.body.sections);
    });

    it('a stored entry that does not name itself is not reused', async () => {
        const section = { key: 'Synopsis', text: 'x'.repeat(40) };
        const hash = sectionHash('LOX', section.key, '2026-03-24T18:25:00+00:00', section.text);
        const { sectionKey } = await import('../api/_shared-cache.js');
        backend.seed(sectionKey('LOX', hash), { office: 'OKX', key: 'Synopsis', hash, text: 'wrong office' });
        expect(await findReusedSection('LOX', '2026-03-24T18:25:00+00:00', section)).toBe(null);
        backend.seed(sectionKey('LOX', hash), { office: 'LOX', key: 'Synopsis', hash, text: 'right' });
        expect(await findReusedSection('LOX', '2026-03-24T18:25:00+00:00', section)).toBe('right');
    });

    it('the hash follows the annotated prompt: a Zulu time that resolves differently is a different section', () => {
        const text = 'Showers end by 15Z with clearing skies through the afternoon and evening hours.';
        const a = sectionHash('LOT', 'Aviation', '2026-09-28T11:36:00+00:00', text);
        const sameDayLater = sectionHash('LOT', 'Aviation', '2026-09-28T12:10:00+00:00', text);
        const nextDay = sectionHash('LOT', 'Aviation', '2026-09-29T17:00:00+00:00', text);
        expect(sameDayLater).toBe(a);       // "15Z (10 AM CDT)" both times
        expect(nextDay).not.toBe(a);        // now "15Z (10 AM CDT Wed)"
        expect(sectionHash('LOT', 'Discussion', '2026-09-28T11:36:00+00:00', text)).not.toBe(a);
        expect(sectionHash('LOX', 'Aviation', '2026-09-28T11:36:00+00:00', text)).not.toBe(a);
    });
});

describe('api/_nws-feed.js', () => {
    let saved;
    let calls;
    const stub = (fn) => {
        saved = globalThis.fetch;
        calls = [];
        globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return fn(url, init); };
    };
    afterEach(() => { if (saved) globalThis.fetch = saved; saved = null; });

    it('sends the User-Agent and reads @graph', async () => {
        stub(() => Response.json({ '@graph': [{ id: 'a' }] }));
        expect(await fetchAFDsSince('2026-11-18T10:00:00.000Z')).toEqual([{ id: 'a' }]);
        expect(calls[0].url).toBe('https://api.weather.gov/products?type=AFD&start=2026-11-18T10%3A00%3A00.000Z');
        expect(calls[0].url).not.toContain('limit');
        expect(calls[0].init.headers['User-Agent']).toBe(NWS_USER_AGENT);
        expect(await fetchAFDWeek()).toEqual([{ id: 'a' }]);
        expect(calls[1].url).toBe('https://api.weather.gov/products/types/AFD');
    });

    it('403/429 are throttles (stop for this run); 404 is not retryable; network errors are', async () => {
        for (const [status, throttled, retryable] of [[403, true, true], [429, true, true], [404, false, false], [503, false, true]]) {
            stub(() => new Response('no', { status }));
            const err = await fetchProductById('abc-1').catch(e => e);
            expect(err.name).toBe('NwsError');
            expect(err.status).toBe(status);
            expect(err.throttled).toBe(throttled);
            expect(err.retryable).toBe(retryable);
        }
        stub(() => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); });
        const t = await fetchProductById('abc-1').catch(e => e);
        expect(t.message).toBe('timeout');
        expect(t.retryable).toBe(true);
        stub(() => Response.json({ nothing: true }));
        expect((await fetchAFDsSince('2026-11-18T10:00:00Z').catch(e => e)).name).toBe('NwsError');
    });

    it('refuses an id that is not a product id, without a request', async () => {
        const rec = recordFetches();
        try {
            expect((await fetchProductById('../alerts').catch(e => e)).retryable).toBe(false);
        } finally { rec.restore(); }
        expect(rec.calls).toEqual([]);
    });
});
