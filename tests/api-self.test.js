import { describe, it, expect, afterEach } from 'bun:test';
import { selfOrigin, fetchSelfJson, isPeek, PEEK_HEADER } from '../api/_self.js';

const ENV_KEYS = ['VERCEL_ENV', 'VERCEL_URL', 'VERCEL_AUTOMATION_BYPASS_SECRET'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const savedFetch = globalThis.fetch;

afterEach(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
    globalThis.fetch = savedFetch;
});

function stubFetch(impl) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return impl(url, init);
    };
    return calls;
}

describe('api/_self.js', () => {
    it('has no origin outside Vercel, and never touches the network there', async () => {
        for (const k of ENV_KEYS) delete process.env[k];
        const calls = stubFetch(() => new Response('{}'));
        expect(selfOrigin()).toBe(null);
        expect(await fetchSelfJson('/api/translate-issuance?office=LOX&id=x')).toBe(null);
        expect(calls.length).toBe(0);
    });

    it('uses the production domain in production, never the deployment URL', async () => {
        process.env.VERCEL_ENV = 'production';
        process.env.VERCEL_URL = 'plaincast-abc123.vercel.app';
        process.env.VERCEL_AUTOMATION_BYPASS_SECRET = 'secret';
        const calls = stubFetch(() => Response.json({ ok: true }));
        expect(await fetchSelfJson('/api/national-lede')).toEqual({ ok: true });
        expect(calls[0].url).toBe('https://plaincast.live/api/national-lede');
        expect(calls[0].init.headers['x-vercel-protection-bypass']).toBeUndefined();
    });

    it('uses the deployment URL plus the bypass secret on previews', async () => {
        process.env.VERCEL_ENV = 'preview';
        process.env.VERCEL_URL = 'plaincast-abc123.vercel.app';
        process.env.VERCEL_AUTOMATION_BYPASS_SECRET = 'secret';
        const calls = stubFetch(() => Response.json({ ok: true }));
        await fetchSelfJson('/api/national-lede');
        expect(calls[0].url).toBe('https://plaincast-abc123.vercel.app/api/national-lede');
        expect(calls[0].init.headers['x-vercel-protection-bypass']).toBe('secret');
    });

    it('sends the peek header only when asked', async () => {
        process.env.VERCEL_ENV = 'production';
        const calls = stubFetch(() => Response.json({}));
        await fetchSelfJson('/api/national-lede');
        await fetchSelfJson('/api/changelog?office=LOX', { peek: true });
        expect(calls[0].init.headers[PEEK_HEADER]).toBeUndefined();
        expect(calls[1].init.headers[PEEK_HEADER]).toBe('1');
        expect(isPeek({ headers: { [PEEK_HEADER]: '1' } })).toBe(true);
        expect(isPeek({ headers: { [PEEK_HEADER]: 'true' } })).toBe(false);
        expect(isPeek({ headers: {} })).toBe(false);
        expect(isPeek(undefined)).toBe(false);
    });

    it('only fetches /api/ paths', async () => {
        process.env.VERCEL_ENV = 'production';
        const calls = stubFetch(() => Response.json({}));
        expect(await fetchSelfJson('https://evil.example/api/x')).toBe(null);
        expect(await fetchSelfJson('/o/LOX/')).toBe(null);
        expect(await fetchSelfJson(null)).toBe(null);
        expect(calls.length).toBe(0);
    });

    it('returns null, never throws, on a non-200, bad JSON, or a network error', async () => {
        process.env.VERCEL_ENV = 'production';
        stubFetch(() => new Response('nope', { status: 503 }));
        expect(await fetchSelfJson('/api/national-lede')).toBe(null);
        stubFetch(() => new Response('<html>', { status: 200 }));
        expect(await fetchSelfJson('/api/national-lede')).toBe(null);
        stubFetch(() => { throw new Error('boom'); });
        expect(await fetchSelfJson('/api/national-lede')).toBe(null);
    });
});
