import { describe, it, expect, mock, beforeEach } from 'bun:test';

let mockGenerateText = async () => ({ text: 'Stay indoors until the storm passes.', finishReason: 'stop' });
mock.module('ai', () => ({ generateText: (...args) => mockGenerateText(...args) }));

let mockAlert = null;
let mockAlertThrows = false;
mock.module('../api/_utils.js', () => ({
    fetchAFDList: async () => [],
    fetchAFDProduct: async () => ({}),
    productUrlFromItem: () => null,
    fetchAlertById: async () => {
        if (mockAlertThrows) throw new Error('NWS down');
        return mockAlert;
    },
}));

const { default: handler } = await import('../api/explain-alert.js');

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
    return `10.77.${Math.floor(ipCounter / 255)}.${ipCounter % 255}`;
}
const createReq = (query = {}, ip) => ({
    method: 'GET', query,
    headers: { 'x-forwarded-for': ip || uniqueIp() },
    socket: { remoteAddress: '127.0.0.1' },
});

let urnCounter = 0;
const freshUrn = () => `urn:oid:2.49.0.1.840.0.abc${urnCounter++}`;

const FULL_ALERT = {
    event: 'Severe Thunderstorm Warning',
    headline: 'Severe Thunderstorm Warning until 8 PM EDT',
    areaDesc: 'New York County; Kings County',
    expires: '2026-07-03T20:00:00-04:00',
    description: 'At 645 PM EDT, a severe thunderstorm was located over Newark, moving east at 30 mph. Sixty mph wind gusts and quarter size hail expected.',
    instruction: 'Move to an interior room on the lowest floor of a building.',
};

describe('GET /api/explain-alert', () => {
    beforeEach(() => {
        mockAlert = { ...FULL_ALERT };
        mockAlertThrows = false;
        mockGenerateText = async () => ({ text: 'A severe thunderstorm is over Newark. **Move to an interior room.**', finishReason: 'stop' });
    });

    it('rejects non-GET and non-URN ids', async () => {
        let res = createRes();
        await handler({ ...createReq({ id: freshUrn() }), method: 'POST' }, res);
        expect(res.statusCode).toBe(405);

        for (const bad of ['', 'not-a-urn', 'urn:oid:<script>', 'x'.repeat(301)]) {
            res = createRes();
            await handler(createReq({ id: bad }), res);
            expect(res.statusCode).toBe(400);
        }
    });

    it('404s when the alert has expired at NWS', async () => {
        mockAlert = null;
        const res = createRes();
        await handler(createReq({ id: freshUrn() }), res);
        expect(res.statusCode).toBe(404);
    });

    it('explains a live alert from server-fetched (unforgeable) text', async () => {
        let aiArgs;
        mockGenerateText = async (args) => {
            aiArgs = args;
            return { text: 'Storm over Newark. **Get inside.**', finishReason: 'stop' };
        };
        const res = createRes();
        await handler(createReq({ id: freshUrn() }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.explanation).toContain('Newark');
        // model input came from the server fetch, not from the client
        expect(aiArgs.prompt).toContain('interior room');
        expect(res.headers['cache-control']).toContain('s-maxage=1800');
    });

    it('caches per alert id — second call skips the model', async () => {
        const id = freshUrn();
        const first = createRes();
        await handler(createReq({ id }), first);
        expect(first.body.cached).toBe(false);

        mockGenerateText = async () => { throw new Error('re-billed'); };
        const second = createRes();
        await handler(createReq({ id }), second);
        expect(second.statusCode).toBe(200);
        expect(second.body.cached).toBe(true);
    });

    it('503s on content-filter, 500s on model errors, 504s on timeouts', async () => {
        mockGenerateText = async () => ({ text: '', finishReason: 'content-filter' });
        let res = createRes();
        await handler(createReq({ id: freshUrn() }), res);
        expect(res.statusCode).toBe(503);

        mockGenerateText = async () => { throw new Error('boom'); };
        res = createRes();
        await handler(createReq({ id: freshUrn() }), res);
        expect(res.statusCode).toBe(500);

        mockGenerateText = async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; };
        res = createRes();
        await handler(createReq({ id: freshUrn() }), res);
        expect(res.statusCode).toBe(504);
    });

    it('rate limits per IP', async () => {
        const ip = uniqueIp();
        let last = 0;
        for (let i = 0; i < 11; i++) {
            const res = createRes();
            await handler(createReq({ id: freshUrn() }, ip), res);
            last = res.statusCode;
        }
        expect(last).toBe(429);
    });
});
