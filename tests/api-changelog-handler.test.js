import { describe, it, expect, mock, beforeEach } from 'bun:test';

let mockGenerateText = async () => ({
    text: 'Rain chances rose for Thursday and the forecaster grew more confident about the weekend warmup.',
    finishReason: 'stop',
});
mock.module('ai', () => ({ generateText: (...args) => mockGenerateText(...args) }));

// items[0] = current, items[1] = previous. productUrlFromItem -> item.id,
// fetchAFDProduct(url) -> the matching product.
let mockItems = [];
let mockProducts = {};
let mockListThrows = false;
mock.module('../api/_utils.js', () => ({
    fetchAlertById: async () => null,
    fetchAFDList: async () => { if (mockListThrows) throw new Error('NWS down'); return mockItems; },
    fetchAFDProduct: async (url) => mockProducts[url] || {},
    productUrlFromItem: (item) => item?.id || null,
}));

const { default: handler, changedParagraphs } = await import('../api/changelog.js');

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
const createReq = (o = {}) => ({ method: 'GET', query: {}, ...o });

const PREV = `.SYNOPSIS...High pressure keeps the region dry and mild through midweek with seasonable temperatures and light winds across the valleys.

$$`;
// Current AFD: the synopsis paragraph is reworded (a "changed" paragraph).
const CURR = `.SYNOPSIS...A cold front now arrives Thursday afternoon bringing a good chance of showers and noticeably cooler temperatures behind it across the valleys and coast.

$$`;

let idCounter = 0;
function setScenario({ curr = CURR, prev = PREV, items } = {}) {
    const curId = `cur-${idCounter++}`;
    mockItems = items || [{ id: curId }, { id: 'prev-x' }];
    mockProducts = {
        [mockItems[0]?.id]: { productText: curr, issuanceTime: '2026-03-24T18:25:00+00:00' },
        [mockItems[1]?.id]: { productText: prev, issuanceTime: '2026-03-24T10:25:00+00:00' },
    };
    return mockItems;
}

describe('changedParagraphs', () => {
    it('returns paragraphs added/changed in current vs previous', () => {
        const changes = changedParagraphs(PREV, CURR);
        expect(changes.length).toBeGreaterThan(0);
        expect(changes.join(' ')).toMatch(/cold front/i);
    });
    it('returns nothing when the text is identical', () => {
        expect(changedParagraphs(CURR, CURR).length).toBe(0);
    });
    it('ignores short lines and "None." noise', () => {
        const prev = 'Something old here that is reasonably long and descriptive enough.';
        const curr = 'None.\n\n.AVIATION...\n\nVFR.';
        expect(changedParagraphs(prev, curr).length).toBe(0);
    });
});

describe('GET /api/changelog', () => {
    beforeEach(() => {
        mockListThrows = false;
        mockGenerateText = async () => ({
            text: 'A cold front Thursday brings showers and cooler air.',
            finishReason: 'stop',
        });
    });

    it('returns 405 for non-GET', async () => {
        const res = createRes();
        await handler(createReq({ method: 'POST', query: { office: 'LOX' } }), res);
        expect(res.statusCode).toBe(405);
    });

    it('returns 400 for an invalid office', async () => {
        const res = createRes();
        await handler(createReq({ query: { office: 'XXX' } }), res);
        expect(res.statusCode).toBe(400);
    });

    it('returns null changelog when there is no previous issuance', async () => {
        mockItems = [{ id: `solo-${idCounter++}` }];
        mockProducts = { [mockItems[0].id]: { productText: CURR, issuanceTime: 'x' } };
        const res = createRes();
        await handler(createReq({ query: { office: 'LOX' } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.changelog).toBeNull();
    });

    it('summarizes the delta when paragraphs changed', async () => {
        setScenario();
        const res = createRes();
        await handler(createReq({ query: { office: 'LOX' } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.changelog).toMatch(/cold front/i);
        expect(res.body.since).toBe('2026-03-24T10:25:00+00:00');
        expect(res.body.cached).toBe(false);
    });

    it('caches by current issuance — second call does not re-run AI', async () => {
        const items = setScenario({ items: [{ id: `cache-${idCounter++}` }, { id: 'prev-x' }] });
        const first = createRes();
        await handler(createReq({ query: { office: 'LOX' } }), first);
        expect(first.body.cached).toBe(false);

        mockGenerateText = async () => { throw new Error('should not be called'); };
        mockItems = items; // same current id
        const second = createRes();
        await handler(createReq({ query: { office: 'LOX' } }), second);
        expect(second.statusCode).toBe(200);
        expect(second.body.cached).toBe(true);
        expect(second.body.changelog).toMatch(/cold front/i);
    });

    it('returns null when the model judges the change trivial (NONE)', async () => {
        setScenario();
        mockGenerateText = async () => ({ text: 'NONE', finishReason: 'stop' });
        const res = createRes();
        await handler(createReq({ query: { office: 'LOX' } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.changelog).toBeNull();
    });

    it('returns null changelog when nothing changed (no AI call)', async () => {
        setScenario({ curr: CURR, prev: CURR });
        mockGenerateText = async () => { throw new Error('should not be called'); };
        const res = createRes();
        await handler(createReq({ query: { office: 'LOX' } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.changelog).toBeNull();
    });

    it('soft-fails to null (200) when NWS is unreachable', async () => {
        mockListThrows = true;
        const res = createRes();
        await handler(createReq({ query: { office: 'LOX' } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.changelog).toBeNull();
    });
});

describe('GET /api/changelog?id= (pinned issuance for the timeline)', () => {
    beforeEach(() => {
        mockListThrows = false;
        mockGenerateText = async () => ({
            text: 'Snow chances faded from the Tuesday forecast.',
            finishReason: 'stop',
        });
    });

    it('diffs the pinned issuance against its predecessor, not the latest pair', async () => {
        const mid = `mid-${idCounter++}`;
        const old = `old-${idCounter++}`;
        mockItems = [{ id: `new-${idCounter++}` }, { id: mid }, { id: old }];
        mockProducts = {
            [mockItems[0].id]: { productText: CURR, issuanceTime: '2026-03-25T00:25:00+00:00' },
            [mid]: { productText: CURR, issuanceTime: '2026-03-24T18:25:00+00:00' },
            [old]: { productText: PREV, issuanceTime: '2026-03-24T10:25:00+00:00' },
        };
        const res = createRes();
        await handler(createReq({ query: { office: 'LOX', id: mid } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.changelog).toMatch(/snow chances/i);
        // since/updated must belong to the pinned pair
        expect(res.body.since).toBe('2026-03-24T10:25:00+00:00');
        expect(res.body.updated).toBe('2026-03-24T18:25:00+00:00');
    });

    it('serves non-latest pairs with a long CDN cache window', async () => {
        const mid = `mid-${idCounter++}`;
        mockItems = [{ id: `new-${idCounter++}` }, { id: mid }, { id: `old-${idCounter++}` }];
        mockProducts = {
            [mockItems[0].id]: { productText: CURR, issuanceTime: 'a' },
            [mid]: { productText: CURR, issuanceTime: 'b' },
            [mockItems[2].id]: { productText: PREV, issuanceTime: 'c' },
        };
        const res = createRes();
        await handler(createReq({ query: { office: 'LOX', id: mid } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toContain('s-maxage=86400');
    });

    it('returns null for an unknown id without calling AI', async () => {
        setScenario();
        mockGenerateText = async () => { throw new Error('should not be called'); };
        const res = createRes();
        await handler(createReq({ query: { office: 'LOX', id: 'does-not-exist' } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.changelog).toBeNull();
    });

    it('returns null for the oldest retained issuance (nothing to diff against)', async () => {
        const items = setScenario();
        mockGenerateText = async () => { throw new Error('should not be called'); };
        const res = createRes();
        await handler(createReq({ query: { office: 'LOX', id: items[1].id } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.changelog).toBeNull();
    });

    it('rejects malformed ids', async () => {
        setScenario();
        const res = createRes();
        await handler(createReq({ query: { office: 'LOX', id: '<script>alert(1)</script>' } }), res);
        expect(res.statusCode).toBe(400);
    });
});
