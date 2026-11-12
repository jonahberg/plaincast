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
    fetchSpcOutlook: async () => null,
    fetchSevereAlerts: async () => [],
    fetchAlertTotals: async () => null,
    fetchAlertById: async () => null,
    fetchAFDList: async () => [],
    fetchAFDProduct: async () => ({ productText: '', issuanceTime: null }),
    productUrlFromItem: (item) => item?.id || null,
}));

const { default: handler, coldBudget, COPY_MAX_TOKENS, splitCopy } = await import('../api/national-lede.js');
const { default: swody1 } = await import('./fixtures/national/swody1.json');
// Fresh issuance with three post-summary discussion paragraphs: the copy path.
const { default: swody1Fresh } = await import('./fixtures/national/swody1-fresh.json');
// Live Nov 12 05:23Z product: its discussion says "by 12Z Friday".
const { default: swody1Nov12 } = await import('./fixtures/national/swody1-nov12.json');
const { parseSpcOutlook, parseDiscussionBody } = await import('../api/_national.js');

// The two model calls are told apart by their system prompt.
const isCopyCall = (args) => /forecasters' discussion/.test(args?.system || '');
const DECK_TEXT = 'Severe storms are possible from the Ohio Valley to the central High Plains this evening.';
const COPY_TEXT = 'Several pockets of spinning air in the jet stream will help set off storms later today.\n\nThe storms will move east into the Mid-Atlantic by early evening, bringing damaging gusts.';
// Route each call to its own stub; each defaults to a good answer.
function stubModel({ deck = async () => ({ text: DECK_TEXT, finishReason: 'stop' }),
    copy = async () => ({ text: COPY_TEXT, finishReason: 'stop' }) } = {}) {
    mockGenerateText = async (args) => (isCopyCall(args) ? copy(args) : deck(args));
}
const copyCalls = () => generateArgs.filter(isCopyCall).length;
const deckCalls = () => generateArgs.filter(a => !isCopyCall(a)).length;

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
        coldBudget.reset();
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
        // swody1 is a reissue with no discussion of its own: no copy to
        // write (a verdict, so the long header), and only the deck call.
        expect(first.body).toEqual({
            deck: 'Severe storms are possible from the Ohio Valley to the central High Plains this evening.',
            copy: null,
            issued,
            cached: false,
        });
        expect(first.headers['cache-control']).toBe('public, s-maxage=900, stale-while-revalidate=3600');
        expect(generateCalls).toBe(1);

        // The model call itself: pinned model (direct Claude API) with thinking
        // off, both headline and summary fed to it, and nothing else.
        const args = generateArgs[0];
        expect(args.model.provider).toBe('anthropic.messages');
        expect(args.model.modelId).toBe('claude-haiku-5-5');
        expect(args.providerOptions).toEqual({ anthropic: { thinking: { type: 'disabled' } } });
        expect(args.maxOutputTokens).toBe(240);
        expect(args.system).toMatch(/Storm Prediction Center/);
        expect(args.prompt).toContain('THERE IS A SLIGHT RISK OF SEVERE THUNDERSTORMS');
        expect(args.prompt).toContain('Thunderstorms with severe wind gusts');

        // Second call, same issuance: cached, no second model call.
        mockGenerateText = async () => { throw new Error('should not be called'); };
        const second = await call();
        expect(second.statusCode).toBe(200);
        expect(second.body).toEqual({
            deck: 'Severe storms are possible from the Ohio Valley to the central High Plains this evening.',
            copy: null,
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
        expect(first.body).toEqual({ deck: null, copy: null, transient: true });
        expect(first.headers['cache-control']).toBe('public, s-maxage=60');
        expect(generateCalls).toBe(1);

        // Same issuance again: a transient failure must NOT have been cached,
        // so the model runs again and a real deck can still arrive.
        mockGenerateText = async () => ({ text: 'A quiet day nationwide.', finishReason: 'stop' });
        const second = await call();
        expect(generateCalls).toBe(2);
        expect(second.body).toEqual({ deck: 'A quiet day nationwide.', copy: null, issued, cached: false });
    });

    it('treats a content-filtered response as transient, not a verdict', async () => {
        setSpc(nextIssuance());
        mockGenerateText = async () => ({ text: '', finishReason: 'content-filter' });
        const res = await call();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ deck: null, copy: null, transient: true });
        expect(res.headers['cache-control']).toBe('public, s-maxage=60');
    });

    it('soft-fails to 200 transient when the SPC fetch throws', async () => {
        spcThrows = true;
        const res = await call();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ deck: null, copy: null, transient: true });
        expect(res.headers['cache-control']).toBe('public, s-maxage=60');
        expect(generateCalls).toBe(0);
    });

    it('soft-fails to 200 transient when there is no SPC product at all', async () => {
        mockSpc = null;
        const res = await call();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ deck: null, copy: null, transient: true });
        expect(generateCalls).toBe(0);
    });

    it('never calls the model when the outlook has no parseable summary', async () => {
        setSpc(nextIssuance(), 'no structure here at all');
        const res = await call();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ deck: null, copy: null, transient: true });
        expect(res.headers['cache-control']).toBe('public, s-maxage=60');
        expect(generateCalls).toBe(0);
    });

    it('rejects every client-supplied parameter (400 unknown_param) — none reaches the model or the CDN', async () => {
        // The endpoint reads no input, so a param can only ever be a CDN
        // cache-bust (Sep 28 2026 audit): it used to be ignored and served,
        // making every distinct junk URL an edge miss that reached the function.
        setSpc(nextIssuance());
        const withParams = await call(createReq({ query: { office: 'LOT', evil: 'x', id: '../../etc/passwd' } }));
        expect(withParams.statusCode).toBe(400);
        expect(withParams.body.code).toBe('unknown_param');
        expect(withParams.headers['cache-control']).toBe('no-store');
        expect(generateCalls).toBe(0);
        expect(spcCalls).toBe(0);
        expect(JSON.stringify(withParams.body)).not.toContain('passwd');
    });

    it('503s (over_capacity, no-store) once the instance-wide cold budget is spent', async () => {
        coldBudget.reset();
        for (let i = 0; i < 10; i++) {
            setSpc(nextIssuance());
            expect((await call()).statusCode).toBe(200);
        }
        setSpc(nextIssuance());
        const over = await call();
        expect(generateCalls).toBe(10);
        expect(over.statusCode).toBe(503);
        expect(over.body.code).toBe('over_capacity');
        expect(over.headers['cache-control']).toBe('no-store');
        coldBudget.reset();
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

    // ── The plain-English running copy (Nov 2026) ─────────────────────
    it('returns the discussion as plain-English paragraphs alongside the deck, from two parallel calls', async () => {
        const issued = setSpc(nextIssuance(), swody1Fresh.productText);
        stubModel();
        const res = await call();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            deck: DECK_TEXT,
            copy: [
                'Several pockets of spinning air in the jet stream will help set off storms later today.',
                'The storms will move east into the Mid-Atlantic by early evening, bringing damaging gusts.',
            ],
            issued,
            cached: false,
        });
        expect(res.headers['cache-control']).toBe('public, s-maxage=900, stale-while-revalidate=3600');
        expect(deckCalls()).toBe(1);
        expect(copyCalls()).toBe(1);

        const copyArgs = generateArgs.find(isCopyCall);
        // thinking off via _model.js, a sized output budget
        expect(copyArgs.providerOptions).toEqual({ anthropic: { thinking: { type: 'disabled' } } });
        expect(copyArgs.maxOutputTokens).toBe(COPY_MAX_TOKENS);
        expect(COPY_MAX_TOKENS).toBe(2048);
        // the prompt is exactly the post-summary discussion — never the summary
        const body = parseDiscussionBody(swody1Fresh.productText);
        const { summary } = parseSpcOutlook(swody1Fresh.productText);
        expect(copyArgs.prompt).toBe(body.join('\n\n'));
        expect(copyArgs.prompt).not.toContain(summary);
        // voice rules shared with the section translator
        expect(copyArgs.system).toContain('Never attach a calendar date (month and day number) to a day of the week unless the source text itself gives that date');
        expect(copyArgs.system).toContain('never comment on the source text');
        expect(copyArgs.system).toContain('never convert a Zulu time yourself');
        expect(copyArgs.system).toMatch(/Outlook issuance time, US Eastern: .*EDT/);
    });

    it('annotates Zulu times in Eastern before the model sees them, weekday included', async () => {
        setSpc(swody1Nov12.issuanceTime, swody1Nov12.productText);
        stubModel();
        await call();
        const copyArgs = generateArgs.find(isCopyCall);
        // Live text: "...through the Atlantic Seaboard by 12Z Friday." The
        // product went out 12:23 AM EST Thursday; 12Z Friday is 7 AM Friday.
        expect(copyArgs.prompt).toContain('by 12Z Friday (7 AM EST Fri)');
        expect(copyArgs.system).toContain('Outlook issuance time, US Eastern: Thursday, November 12, 2026 at 12:23 AM EST');
    });

    it('caches the copy per issuance: the second read costs no model call', async () => {
        const issued = setSpc(nextIssuance(), swody1Fresh.productText);
        stubModel();
        await call();
        expect(generateCalls).toBe(2);
        mockGenerateText = async () => { throw new Error('should not be called'); };
        const second = await call();
        expect(generateCalls).toBe(2);
        expect(second.body.cached).toBe(true);
        expect(second.body.issued).toBe(issued);
        expect(second.body.copy.length).toBe(2);
        expect(second.body.deck).toBe(DECK_TEXT);
    });

    for (const [label, failure] of [
        ['throws', async () => { throw new Error('upstream 529'); }],
        ['is content-filtered', async () => ({ text: '', finishReason: 'content-filter' })],
        ['comes back empty', async () => ({ text: '  \n ', finishReason: 'stop' })],
        ['is cut off at the token limit', async () => ({ text: 'The storms will', finishReason: 'length' })],
    ]) {
        it(`copy: null with the deck intact when the copy call ${label} — and only the copy is retried`, async () => {
            const issued = setSpc(nextIssuance(), swody1Fresh.productText);
            stubModel({ copy: failure });
            const res = await call();
            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ deck: DECK_TEXT, copy: null, issued, cached: false });
            // short window: the edge asks again soon, so the copy can arrive
            expect(res.headers['cache-control']).toBe('public, s-maxage=60');

            // The failure was not cached; the deck was. The retry is one call.
            stubModel({ deck: async () => { throw new Error('deck must come from cache'); } });
            const again = await call();
            expect(deckCalls()).toBe(1);
            expect(copyCalls()).toBe(2);
            expect(again.body.deck).toBe(DECK_TEXT);
            expect(again.body.copy.length).toBe(2);
            expect(again.headers['cache-control']).toBe('public, s-maxage=900, stale-while-revalidate=3600');
        });
    }

    it('a deck failure never costs the copy: the copy is returned (transient) and cached', async () => {
        const issued = setSpc(nextIssuance(), swody1Fresh.productText);
        stubModel({ deck: async () => ({ text: '', finishReason: 'content-filter' }) });
        const res = await call();
        expect(res.body.deck).toBeNull();
        expect(res.body.transient).toBe(true);
        expect(res.body.issued).toBe(issued);
        expect(res.body.copy.length).toBe(2);
        expect(res.headers['cache-control']).toBe('public, s-maxage=60');

        stubModel({ copy: async () => { throw new Error('copy must come from cache'); } });
        const again = await call();
        expect(copyCalls()).toBe(1);
        expect(again.body.deck).toBe(DECK_TEXT);
        expect(again.body.copy.length).toBe(2);
    });

    it('never builds copy from the summary: no discussion → copy null, no copy call, long header', async () => {
        // A summary and nothing after it.
        setSpc(nextIssuance(), '...THERE IS A SLIGHT RISK OF SEVERE THUNDERSTORMS ACROSS THE PLAINS...\n\n...SUMMARY...\nSevere wind gusts are possible this evening across the central High Plains.\n\n$$\n');
        stubModel();
        const res = await call();
        expect(res.body.copy).toBeNull();
        expect(res.body.deck).toBe(DECK_TEXT);
        expect(copyCalls()).toBe(0);
        expect(res.headers['cache-control']).toBe('public, s-maxage=900, stale-while-revalidate=3600');
        // the real 20Z reissue fixture: same verdict
        setSpc(nextIssuance(), swody1.productText);
        const reissue = await call();
        expect(reissue.body.copy).toBeNull();
        expect(copyCalls()).toBe(0);
    });

    it('runs the copy through the trust guard: asides and impossible weekday dates are gone', async () => {
        setSpc(nextIssuance(), swody1Fresh.productText); // Aug 15 2026 issuance
        stubModel({
            copy: async () => ({
                text: 'Storms will build over the Ohio Valley this afternoon. Note that the source text uses abbreviations for several states. They may produce damaging gusts.\n\n'
                    + 'Drier air arrives by Sunday, November 22, ending the threat.',
                finishReason: 'stop',
            }),
        });
        const res = await call();
        const text = res.body.copy.join('\n');
        expect(text).not.toContain('source text');
        expect(text).not.toContain('November 22');
        expect(res.body.copy).toEqual([
            'Storms will build over the Ohio Valley this afternoon. They may produce damaging gusts.',
            'Drier air arrives by Sunday, ending the threat.',
        ]);
    });

    it('a long but legitimate copy (12 short paragraphs) is returned and cached, not rejected', async () => {
        setSpc(nextIssuance(), swody1Fresh.productText);
        const twelve = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} explains one more step of the setup.`).join('\n\n');
        stubModel({ copy: async () => ({ text: twelve, finishReason: 'stop' }) });
        const res = await call();
        expect(res.body.copy.length).toBe(12);
        expect(res.headers['cache-control']).toBe('public, s-maxage=900, stale-while-revalidate=3600');
        const again = await call();
        expect(copyCalls()).toBe(1);
        expect(again.body.copy.length).toBe(12);
    });

    it('strips markdown the prompt forbids, since the page prints it as text', () => {
        expect(splitCopy('## Today\n\n**Damaging gusts** are likely.\n- Hail too.\n\n---\n\nThen it clears.'))
            .toEqual(['Today', 'Damaging gusts are likely.', 'Hail too.', 'Then it clears.']);
    });

    it('charges the cold budget per model call: a fresh issuance costs two', async () => {
        coldBudget.reset();
        stubModel();
        for (let i = 0; i < 5; i++) {
            setSpc(nextIssuance(), swody1Fresh.productText);
            expect((await call()).statusCode).toBe(200);
        }
        expect(generateCalls).toBe(10);
        setSpc(nextIssuance(), swody1Fresh.productText);
        const over = await call();
        expect(over.statusCode).toBe(503);
        expect(generateCalls).toBe(10);
        coldBudget.reset();
    });

    it('a cache-busting query string never reaches the model', async () => {
        setSpc(nextIssuance(), swody1Fresh.productText);
        stubModel();
        const res = await call(createReq({ query: { v: '2' } }));
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('unknown_param');
        expect(generateCalls).toBe(0);
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
