import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorBody, sendError, CODES, DOCS_URL, SPEC_URL } from '../api/_errors.js';
import notFoundJson, { PUBLIC_ENDPOINTS } from '../api/api-not-found.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function mockRes() {
    const res = { headers: {}, code: 0, body: null };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
    res.getHeader = (k) => res.headers[k.toLowerCase()];
    res.status = (c) => { res.code = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.send = (b) => { res.body = b; return res; };
    return res;
}

describe('structured JSON errors', () => {
    it('carries a machine code, a human message, a hint and a docs link', () => {
        const b = errorBody('invalid_office', 'Invalid office');
        expect(b.error).toBe('Invalid office');
        expect(b.code).toBe('invalid_office');
        expect(b.hint).toContain('?office=');
        expect(b.docs).toBe(DOCS_URL);
    });

    // The contract that keeps this change safe: `error` is still the string it
    // always was. Anything already parsing it keeps working.
    it('keeps `error` a plain string and never nests it', () => {
        for (const code of Object.keys(CODES)) {
            const b = errorBody(code, 'msg');
            expect(typeof b.error).toBe('string');
        }
    });

    it('falls back to internal_error for an unregistered code rather than emitting it', () => {
        expect(errorBody('made_up_code', 'x').code).toBe('internal_error');
    });

    it('defaults the message from the code when none is given', () => {
        expect(errorBody('rate_limited').error).toBe(CODES.rate_limited);
    });

    it('a caller-supplied hint wins, and extras are merged as siblings', () => {
        const b = errorBody('method_not_allowed', 'GET only', { hint: 'Use GET.', allow: ['GET'] });
        expect(b.hint).toBe('Use GET.');
        expect(b.allow).toEqual(['GET']);
    });

    it('sendError emits JSON and refuses to let a CDN cache a per-request failure', () => {
        const res = mockRes();
        sendError(res, 400, 'invalid_office', 'Invalid office');
        expect(res.code).toBe(400);
        expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
        expect(res.headers['cache-control']).toBe('no-store');
    });

    it('does not clobber a Cache-Control the handler already set', () => {
        const res = mockRes();
        res.setHeader('Cache-Control', 'public, s-maxage=300');
        sendError(res, 404, 'not_found', 'nope');
        expect(res.headers['cache-control']).toBe('public, s-maxage=300');
    });

    it('every documented code has a hint', () => {
        for (const code of Object.keys(CODES)) {
            expect(errorBody(code).hint.length).toBeGreaterThan(10);
        }
    });
});

describe('unknown /api/* paths answer as JSON, not HTML', () => {
    it('404s with the structured shape and the endpoint list', async () => {
        const res = mockRes();
        await notFoundJson({ method: 'GET' }, res);
        expect(res.code).toBe(404);
        expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
        expect(res.body.code).toBe('not_found');
        expect(res.body.spec).toBe(SPEC_URL);
        expect(res.body.endpoints).toEqual(PUBLIC_ENDPOINTS);
        expect(res.body.hint).toContain('text/markdown');
    });

    it('is CDN-cacheable, so a garbage-path flood is one invocation per path', async () => {
        const res = mockRes();
        await notFoundJson({ method: 'GET' }, res);
        expect(res.headers['cache-control']).toContain('s-maxage=');
    });

    it('advertises only keyless read endpoints — never the AI backend', () => {
        const joined = PUBLIC_ENDPOINTS.join(' ');
        for (const secret of ['translate', 'changelog', 'explain-alert', 'national-lede']) {
            expect(joined).not.toContain(secret);
        }
    });
});

describe('routing keeps /api/* off the HTML 404', () => {
    const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
    const rewrites = vercel.rewrites;
    const idx = (pred) => rewrites.findIndex(pred);

    it('routes /api, /api/ and /api/* misses to the JSON 404', () => {
        for (const src of ['/api', '/api/']) {
            expect(rewrites.find(r => r.source === src)?.destination).toBe('/api/api-not-found');
        }
        expect(rewrites.some(r => r.source === '/api/:path*' && r.destination === '/api/api-not-found')).toBe(true);
    });

    // The regression this fixes: the sitewide catch-all was swallowing /api/*
    // and serving an HTML broadsheet to agents probing the API.
    it('puts the JSON /api 404 BEFORE the sitewide HTML catch-all', () => {
        const jsonApi404 = idx(r => r.destination === '/api/api-not-found' && r.source === '/api/:path*');
        const htmlCatchAll = idx(r => r.destination === '/api/not-found');
        expect(jsonApi404).toBeGreaterThan(-1);
        expect(htmlCatchAll).toBe(rewrites.length - 1);
        expect(jsonApi404).toBeLessThan(htmlCatchAll);
    });

    it('keeps the real /api self-rewrite first, so live endpoints still win', () => {
        expect(rewrites[0]).toEqual({ source: '/api/:path*', destination: '/api/:path*' });
    });
});
