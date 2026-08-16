import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mirrors tests/api-changelog-handler.test.js mechanics: mock the `ai` module
// (with a call counter, so "did this cost a model call?" is assertable) and
// mock the WHOLE of _utils.js. Bun module mocks are process-global, so every
// export of _utils.js is stubbed here — omitting one would break an unrelated
// file's link depending on test-file order.
let generateCalls = 0;
let generateArgs = []; // one entry per call: the options object
let mockGenerateText = async () => ({
    text: 'Severe storms are possible from the Ohio Valley to the central High Plains this evening.',
    finishReason: 'stop',
});
mock.module('ai', () => ({
    generateText: (...args) => {
        generateCalls += 1;
        generateArgs.push(args[0]);
        return mockGenerateText(...args);
    },
}));

let mockSpc = null;
let spcThrows = false;
let spcCalls = 0;
let spcDelay = 0; // ms: widens the cold window so concurrent misses overlap
mock.module('../api/_utils.js', () => ({
    fetchSpcDy1: async () => {
        spcCalls += 1;
        if (spcDelay) await new Promise(r => setTimeout(r, spcDelay));
        if (spcThrows) throw new Error('SPC down');
        return mockSpc;
    },
    fetchSevereAlerts: async () => [],
    fetchAlertTotals: async () => null,
    fetchAlertById: async () => null,
    fetchAFDList: async () => [],
    fetchAFDProduct: async () => ({ productText: '', issuanceTime: null }),
    productUrlFromItem: (item) => item?.id || null,
}));

const { default: handler } = await import('../api/national-lede.js');
const { default: swody1 } = await import('./fixtures/national/swody1.json');

function createRes() {
    return {
        statusCode: 200, headers: {}, body: null, ended: false,
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(d) { this.body = d; this.ended = true; return this; },
        send(d) { this.body = d; this.ended = true; return this; },
        end() { this.ended = true; return this; },
    };
}

// Every request gets its own client IP by default: the endpoint's per-IP limit
// is 10/min, so a shared bucket would 429 the eleventh call in this file for
// reasons that have nothing to do with the behavior under test.
let ipCounter = 0;
const createReq = (o = {}) => ({
    method: 'GET',
    query: {},
    headers: { 'x-forwarded-for': `203.0.113.${ipCounter++}` },
    ...o,
});

// Distinct issuance per test: the module cache is keyed on it and lives for the
// whole file, so reusing one would leak cache hits across tests.
let issCounter = 0;
const nextIssuance = () => `2026-08-15T19:${String(issCounter++).padStart(2, '0')}:00+00:00`;
function setSpc(issuanceTime, productText = swody1.productText) {
    mockSpc = { productText, issuanceTime };
    return issuanceTime;
}

const call = async (req = createReq()) => {
    const res = createRes();
    await handler(req, res);
    return res;
};

describe('GET /api/national-lede', () => {
    beforeEach(() => {
        spcThrows = false;
        spcDelay = 0;
        spcCalls = 0;
        generateCalls = 0;
        generateArgs = [];
        mockGenerateText = async () => ({
            text: 'Severe storms are possible from the Ohio Valley to the central High Plains this evening.',
            finishReason: 'stop',
        });
        mockSpc = null;
    });

    it('returns 405 for non-GET', async () => {
        const res = await call(createReq({ method: 'POST' }));
        expect(res.statusCode).toBe(405);
        expect(generateCalls).toBe(0);
    });

    it('summarizes the latest SPC outlook, then serves the second call from cache', async () => {
        const issued = setSpc(nextIssuance());

        const first = await call();
        expect(first.statusCode).toBe(200);
        expect(first.body).toEqual({
            deck: 'Severe storms are possible from the Ohio Valley to the central High Plains this evening.',
            issued,
            cached: false,
        });
        expect(first.headers['cache-control']).toBe('public, s-maxage=900, stale-while-revalidate=3600');
        expect(generateCalls).toBe(1);

        // The model call itself: pinned model string, both headline and summary
        // fed to it, and nothing else.
        const args = generateArgs[0];
        expect(args.model).toBe('anthropic/claude-haiku-4.5');
        expect(args.maxOutputTokens).toBe(120);
        expect(args.system).toMatch(/Storm Prediction Center/);
        expect(args.prompt).toContain('THERE IS A SLIGHT RISK OF SEVERE THUNDERSTORMS');
        expect(args.prompt).toContain('Thunderstorms with severe wind gusts');

        // Second call, same issuance: cached, no second model call.
        mockGenerateText = async () => { throw new Error('should not be called'); };
        const second = await call();
        expect(second.statusCode).toBe(200);
        expect(second.body).toEqual({
            deck: 'Severe storms are possible from the Ohio Valley to the central High Plains this evening.',
            issued,
            cached: true,
        });
        expect(generateCalls).toBe(1); // still one
    });

    it('treats empty model output as transient and never caches it', async () => {
        const issued = setSpc(nextIssuance());
        mockGenerateText = async () => ({ text: '   ', finishReason: 'stop' });

        const first = await call();
        expect(first.statusCode).toBe(200);
        expect(first.body).toEqual({ deck: null, transient: true });
        expect(first.headers['cache-control']).toBe('public, s-maxage=60');
        expect(generateCalls).toBe(1);

        // Same issuance again: a transient failure must NOT have been cached,
        // so the model runs again and a real deck can still arrive.
        mockGenerateText = async () => ({ text: 'A quiet day nationwide.', finishReason: 'stop' });
        const second = await call();
        expect(generateCalls).toBe(2);
        expect(second.body).toEqual({ deck: 'A quiet day nationwide.', issued, cached: false });
    });

    it('treats a content-filtered response as transient, not a verdict', async () => {
        setSpc(nextIssuance());
        mockGenerateText = async () => ({ text: '', finishReason: 'content-filter' });
        const res = await call();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ deck: null, transient: true });
        expect(res.headers['cache-control']).toBe('public, s-maxage=60');
    });

    it('soft-fails to 200 transient when the SPC fetch throws', async () => {
        spcThrows = true;
        const res = await call();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ deck: null, transient: true });
        expect(res.headers['cache-control']).toBe('public, s-maxage=60');
        expect(generateCalls).toBe(0);
    });

    it('soft-fails to 200 transient when there is no SPC product at all', async () => {
        mockSpc = null;
        const res = await call();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ deck: null, transient: true });
        expect(generateCalls).toBe(0);
    });

    it('never calls the model when the outlook has no parseable summary', async () => {
        setSpc(nextIssuance(), 'no structure here at all');
        const res = await call();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ deck: null, transient: true });
        expect(res.headers['cache-control']).toBe('public, s-maxage=60');
        expect(generateCalls).toBe(0);
    });

    it('ignores every client-supplied parameter — none reaches the prompt, the response, or the cache key', async () => {
        // 1. paramless call on its own issuance
        const issuedA = setSpc(nextIssuance());
        const paramless = await call();
        expect(paramless.body.cached).toBe(false);
        const promptA = generateArgs[0].prompt;

        // 2. hostile params on a DIFFERENT issuance (same product text): the
        //    model must see a byte-identical prompt and the response must match
        //    the paramless one everywhere except the issuance it reported.
        const issuedB = setSpc(nextIssuance());
        const withParams = await call(createReq({ query: { office: 'LOT', evil: 'x', id: '../../etc/passwd' } }));
        expect(generateCalls).toBe(2);
        const promptB = generateArgs[1].prompt;

        expect(promptB).toBe(promptA);
        expect(promptB).not.toContain('LOT');
        expect(promptB).not.toContain('evil');
        expect(promptB).not.toContain('passwd');
        expect(generateArgs[1].system).toBe(generateArgs[0].system);
        expect(generateArgs[1].model).toBe(generateArgs[0].model);

        expect(withParams.statusCode).toBe(paramless.statusCode);
        expect(withParams.headers['cache-control']).toBe(paramless.headers['cache-control']);
        expect({ ...withParams.body, issued: null }).toEqual({ ...paramless.body, issued: null });
        expect(withParams.body.issued).toBe(issuedB); // the SPC issuance, never a param
        expect(paramless.body.issued).toBe(issuedA);

        // 3. params are not part of the cache key: a param-laden call on an
        //    already-summarized issuance is a cache hit, not a fresh model call.
        setSpc(issuedA);
        const cachedWithParams = await call(createReq({ query: { office: 'LOT', evil: 'x' } }));
        expect(generateCalls).toBe(2); // unchanged
        expect(cachedWithParams.body).toEqual({ deck: paramless.body.deck, issued: issuedA, cached: true });
    });

    it('dedups concurrent cold misses — one SPC fetch, one model call', async () => {
        setSpc(nextIssuance());
        spcDelay = 20; // widen the cold window so all five overlap
        const results = await Promise.all(Array.from({ length: 5 }, () => call()));
        expect(spcCalls).toBe(1);
        expect(generateCalls).toBe(1);
        for (const res of results) {
            expect(res.statusCode).toBe(200);
            expect(res.body.deck).toMatch(/Severe storms/);
        }
        expect(results.filter(r => r.body.cached === false).length).toBe(1);
    });

    it('rate limits a single client to 10 calls a minute', async () => {
        // Warm the issuance from another IP so the burst costs no model calls.
        const issued = setSpc(nextIssuance());
        await call();
        expect(generateCalls).toBe(1);

        const headers = { 'x-forwarded-for': '198.51.100.7' };
        for (let i = 0; i < 10; i++) {
            const res = await call(createReq({ headers }));
            expect(res.statusCode).toBe(200);
            expect(res.body.issued).toBe(issued);
        }
        const limited = await call(createReq({ headers }));
        expect(limited.statusCode).toBe(429);
        expect(generateCalls).toBe(1); // the burst was all cache hits
    });
});
