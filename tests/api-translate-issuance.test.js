import { describe, it, expect, mock, beforeEach } from 'bun:test';

let mockGenerateText = async () => ({ text: 'translated', finishReason: 'stop' });
mock.module('ai', () => ({ generateText: (...args) => mockGenerateText(...args) }));

const AFD_TEXT = `000
FXUS66 KLOX 241825
AFDLOX

Area Forecast Discussion
National Weather Service Los Angeles/Oxnard CA

.SYNOPSIS...A dry pattern holds through the weekend with highs in the low 80s across the valleys and mountains through Tuesday afternoon.

&&

.SHORT TERM...Dry conditions continue tonight with patchy fog developing along the coast after midnight and clearing by mid morning across the region.

&&

.AVIATION...VFR conditions expected through the period at all terminals with light onshore flow during the afternoon hours each day.

&&

.LOX WATCHES/WARNINGS/ADVISORIES...None.

$$`;

let mockList = [];
let mockListThrows = false;
mock.module('../api/_utils.js', () => ({
    // A module mock replaces the WHOLE module process-wide (Bun mocks are
    // global), so the National Desk fetchers must be stubbed here too —
    // omitting them makes api/national-desk.js fail to link when this file
    // loads first. Stub every export of _utils.js, always.
    fetchSevereAlerts: async () => [],
    fetchAlertTotals: async () => null,
    fetchSpcDy1: async () => null,
    fetchAlertById: async () => null,
    fetchAFDList: async () => { if (mockListThrows) throw new Error('NWS down'); return mockList; },
    fetchAFDProduct: async () => ({ productText: AFD_TEXT, issuanceTime: '2026-03-24T18:25:00+00:00' }),
    productUrlFromItem: (item) => item?.id || null,
}));

// Hermetic: the real _snapshots.js is env-gated Vercel Blob — a provisioned
// environment (BLOB_READ_WRITE_TOKEN) must never make unit tests do live I/O.
let mockSnapshots = {};
mock.module('../api/_snapshots.js', () => ({
    getSnapshot: async (office, id) => mockSnapshots[`${office}|${id}`] || null,
    putSnapshot: async (office, id, payload) => { mockSnapshots[`${office}|${id}`] = payload; return true; },
}));

const { default: handler } = await import('../api/translate-issuance.js');

function createRes() {
    return {
        statusCode: 200, headers: {}, body: null, ended: false,
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(d) { this.body = d; this.ended = true; return this; },
        end() { this.ended = true; return this; },
    };
}

let ipCounter = 0;
function uniqueIp() {
    ipCounter += 1;
    return `10.99.${Math.floor(ipCounter / 255)}.${ipCounter % 255}`;
}

const createReq = (query = {}, ip) => ({
    method: 'GET',
    query,
    headers: { 'x-forwarded-for': ip || uniqueIp() },
    socket: { remoteAddress: '127.0.0.1' },
});

let idCounter = 0;
function freshId() { return `prod-${idCounter++}`; }

describe('GET /api/translate-issuance', () => {
    beforeEach(() => {
        mockListThrows = false;
        mockGenerateText = async () => ({ text: 'plain english here', finishReason: 'stop' });
    });

    it('rejects non-GET, bad office, and malformed ids', async () => {
        let res = createRes();
        await handler({ ...createReq({ office: 'LOX', id: 'x' }), method: 'POST' }, res);
        expect(res.statusCode).toBe(405);

        res = createRes();
        await handler(createReq({ office: 'XXX', id: 'abc' }), res);
        expect(res.statusCode).toBe(400);

        res = createRes();
        await handler(createReq({ office: 'LOX' }), res);
        expect(res.statusCode).toBe(400);

        res = createRes();
        await handler(createReq({ office: 'LOX', id: '<bad>' }), res);
        expect(res.statusCode).toBe(400);
    });

    it('404s for an id that is not a retained issuance (unforgeable input)', async () => {
        mockList = [{ id: freshId() }];
        const res = createRes();
        await handler(createReq({ office: 'LOX', id: 'not-in-list' }), res);
        expect(res.statusCode).toBe(404);
    });

    it('translates every narrative section once, keyed like the client parser', async () => {
        const id = freshId();
        mockList = [{ id }];
        const res = createRes();
        await handler(createReq({ office: 'LOX', id }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.issuanceTime).toBe('2026-03-24T18:25:00+00:00');
        expect(Object.keys(res.body.sections)).toContain('Synopsis');
        expect(Object.keys(res.body.sections)).toContain('Short Term');
        expect(Object.keys(res.body.sections)).toContain('Aviation');
        // Alerts are never AI-translated (live alerts API owns that surface)
        expect(Object.keys(res.body.sections)).not.toContain('Active Alerts');
        expect(res.body.cached).toBe(false);
        expect(res.headers['cache-control']).toContain('s-maxage=86400');
    });

    it('serves the second request from cache without touching the model', async () => {
        const id = freshId();
        mockList = [{ id }];
        const first = createRes();
        await handler(createReq({ office: 'LOX', id }), first);
        expect(first.body.cached).toBe(false);

        mockGenerateText = async () => { throw new Error('re-billed: cache miss'); };
        const second = createRes();
        await handler(createReq({ office: 'LOX', id }), second);
        expect(second.statusCode).toBe(200);
        expect(second.body.cached).toBe(true);
        expect(second.body.sections.Synopsis).toBeTruthy();
    });

    it('tolerates individual section failures (missing key, others intact)', async () => {
        const id = freshId();
        mockList = [{ id }];
        mockGenerateText = async (args) => {
            if (args.system.includes('Section name for context: Aviation')) {
                throw new Error('model hiccup');
            }
            return { text: 'ok', finishReason: 'stop' };
        };
        const res = createRes();
        await handler(createReq({ office: 'LOX', id }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.sections.Synopsis).toBeTruthy();
        expect(res.body.sections.Aviation).toBeUndefined();
    });

    it('returns 502 when every section fails so the client falls back to POST', async () => {
        const id = freshId();
        mockList = [{ id }];
        mockGenerateText = async () => { throw new Error('gateway down'); };
        const res = createRes();
        await handler(createReq({ office: 'LOX', id }), res);
        expect(res.statusCode).toBe(502);
    });

    it('does not freeze partial translations: short cache, no snapshot, retry heals', async () => {
        const id = freshId();
        mockList = [{ id }];
        mockSnapshots = {};
        let call = 0;
        mockGenerateText = async (args) => {
            call++;
            if (args.system.includes('Section name for context: Aviation')) throw new Error('hiccup');
            return { text: 'ok', finishReason: 'stop' };
        };
        const first = createRes();
        await handler(createReq({ office: 'LOX', id }), first);
        expect(first.statusCode).toBe(200);
        expect(first.body.complete).toBe(false);
        expect(first.headers['cache-control']).toContain('s-maxage=300');
        expect(Object.keys(mockSnapshots).length).toBe(0); // partial never snapshotted

        // Retry with the model healthy again: full result, long cache, snapshot
        mockGenerateText = async () => ({ text: 'ok', finishReason: 'stop' });
        const second = createRes();
        await handler(createReq({ office: 'LOX', id }), second);
        expect(second.body.cached).toBe(false); // partial was NOT cached
        expect(second.body.complete).toBe(true);
        expect(second.headers['cache-control']).toContain('s-maxage=86400');
        expect(Object.keys(mockSnapshots).length).toBe(1);
    });

    it('deduplicates concurrent cold requests into one model fan-out', async () => {
        const id = freshId();
        mockList = [{ id }];
        let modelCalls = 0;
        mockGenerateText = async () => {
            modelCalls++;
            await new Promise(r => setTimeout(r, 20));
            return { text: 'ok', finishReason: 'stop' };
        };
        const resA = createRes();
        const resB = createRes();
        await Promise.all([
            handler(createReq({ office: 'LOX', id }), resA),
            handler(createReq({ office: 'LOX', id }), resB),
        ]);
        expect(resA.statusCode).toBe(200);
        expect(resB.statusCode).toBe(200);
        // one fan-out (sections in the fixture), not two
        expect(modelCalls).toBeLessThanOrEqual(4);
        expect([resA.body.cached, resB.body.cached]).toContain(true);
    });

    it('rate limits per IP below the single-section endpoint budget', async () => {
        const ip = uniqueIp();
        const id = freshId();
        mockList = [{ id }];
        let last = 0;
        for (let i = 0; i < 7; i++) {
            const res = createRes();
            await handler(createReq({ office: 'LOX', id }, ip), res);
            last = res.statusCode;
        }
        expect(last).toBe(429);
    });
});
