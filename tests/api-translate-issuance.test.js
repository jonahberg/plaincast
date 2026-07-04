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
    fetchAFDList: async () => { if (mockListThrows) throw new Error('NWS down'); return mockList; },
    fetchAFDProduct: async () => ({ productText: AFD_TEXT, issuanceTime: '2026-03-24T18:25:00+00:00' }),
    productUrlFromItem: (item) => item?.id || null,
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

    it('rate limits per IP below the single-section endpoint budget', async () => {
        const ip = uniqueIp();
        const id = freshId();
        mockList = [{ id }];
        let last = 0;
        for (let i = 0; i < 21; i++) {
            const res = createRes();
            await handler(createReq({ office: 'LOX', id }, ip), res);
            last = res.statusCode;
        }
        expect(last).toBe(429);
    });
});
