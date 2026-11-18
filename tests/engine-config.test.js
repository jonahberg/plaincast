// vercel.json for the engine: the poller's schedule, its duration, and the
// routing rule (rewrites run after the filesystem; the first matching rewrite
// for /api/cron-refresh must be the /api self-rewrite, never the JSON 404).
import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRANSLATE_START_MS, FETCH_PHASE_MS } from '../api/cron-refresh.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));

// Vercel's path-to-regexp subset as used in this file: `:name*` (any
// segments), `:name` (one segment) and the catch-all's explicit group.
function matches(source, path) {
    if (source.startsWith('/:path((')) return new RegExp(`^/${source.slice('/:path'.length)}$`).test(path);
    const re = source
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\/:[a-z]+\*/g, '(?:/.*)?')
        .replace(/:[a-z]+/g, '[^/]+');
    return new RegExp(`^${re}$`).test(path);
}

describe('vercel.json: the edition poller', () => {
    it('is scheduled every 5 minutes', () => {
        expect(vercel.crons).toEqual([{ path: '/api/cron-refresh', schedule: '*/5 * * * *' }]);
    });

    it('may run 300 s, and its own budgets stop well before that', () => {
        expect(vercel.functions['api/cron-refresh.js']).toEqual({ maxDuration: 300 });
        expect(FETCH_PHASE_MS).toBeLessThan(TRANSLATE_START_MS);
        // A translation started at the deadline has a 15 s model timeout per
        // section call (parallel) plus store writes: 60 s of headroom.
        expect(TRANSLATE_START_MS + 60 * 1000).toBeLessThanOrEqual(300 * 1000);
    });

    it('/api/cron-refresh resolves to the function, not the JSON 404', () => {
        expect(existsSync(join(ROOT, 'api', 'cron-refresh.js'))).toBe(true);
        const first = vercel.rewrites.find(r => matches(r.source, '/api/cron-refresh'));
        expect(first).toEqual({ source: '/api/:path*', destination: '/api/:path*' });
        expect(vercel.rewrites.indexOf(first)).toBe(0);
        // The matcher is sane: a non-API path falls through to the catch-all.
        expect(vercel.rewrites.find(r => matches(r.source, '/nope'))?.destination).toBe('/api/not-found');
        expect(vercel.rewrites.find(r => matches(r.source, '/o/LOX/'))?.destination).toBe('/api/office-page?code=:code');
    });

    it('the routing rule still holds: the JSON /api 404 before the catch-all, the catch-all last', () => {
        const r = vercel.rewrites;
        expect(r[r.length - 1].destination).toBe('/api/not-found');
        const json404 = r.findIndex(x => x.source === '/api/:path*' && x.destination === '/api/api-not-found');
        expect(json404).toBeGreaterThan(0);
        expect(json404).toBeLessThan(r.length - 1);
    });
});
