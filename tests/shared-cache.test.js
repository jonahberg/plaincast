import { describe, it, expect, afterEach } from 'bun:test';
import {
    sharedGet, sharedSet, translationKey, changelogKey, ledeKey,
    __setSharedCacheBackendForTests, GET_TIMEOUT_MS, SET_TIMEOUT_MS,
    TRANSLATION_TTL, CHANGELOG_TTL, LEDE_TTL,
} from '../api/_shared-cache.js';
import { memoryBackend, recordFetches } from './shared-cache-backend.js';

const savedVercel = process.env.VERCEL;
afterEach(() => {
    __setSharedCacheBackendForTests(null);
    if (savedVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = savedVercel;
});

describe('api/_shared-cache.js key builders', () => {
    it('build versioned keys per family', () => {
        expect(translationKey('LOX', 'a1b2-c3')).toBe('ti:v2:LOX:a1b2-c3');
        expect(translationKey('lox', 'a1b2-c3')).toBe('ti:v2:LOX:a1b2-c3');
        expect(changelogKey('OKX', 'cur-1')).toBe('cl:v2:OKX:cur-1');
        expect(ledeKey('2026-11-12T05:23:00Z')).toBe('lede:v2:2026-11-12T05:23:00.000Z');
    });

    it('canonicalise the lede issuance: two spellings of one instant share a key', () => {
        expect(ledeKey('2026-11-12T05:23:00+00:00')).toBe(ledeKey('2026-11-12T05:23:00Z'));
        expect(ledeKey('2026-11-12T00:23:00-05:00')).toBe(ledeKey('2026-11-12T05:23:00Z'));
    });

    it('return null, never throw, for input that cannot name an entry', () => {
        for (const [office, id] of [[null, 'x'], ['', 'x'], ['LOXX', 'x'], ['LOX', ''], ['LOX', null], ['LOX', '<bad>'], ['LOX', 'x'.repeat(65)]]) {
            expect(translationKey(office, id)).toBe(null);
            expect(changelogKey(office, id)).toBe(null);
        }
        for (const issued of [null, undefined, '', 'not a date', 42]) expect(ledeKey(issued)).toBe(null);
    });

    it('TTLs: a week for translations and changelogs, two days for the lede', () => {
        expect(TRANSLATION_TTL).toBe(7 * 86400);
        expect(CHANGELOG_TTL).toBe(7 * 86400);
        expect(LEDE_TTL).toBe(2 * 86400);
    });
});

describe('api/_shared-cache.js sharedGet / sharedSet', () => {
    it('is a no-op off Vercel: null reads, silent writes, no network', async () => {
        delete process.env.VERCEL;
        const fetches = recordFetches();
        try {
            await sharedSet('ti:v1:LOX:x', { a: 1 }, { ttl: 60 });
            expect(await sharedGet('ti:v1:LOX:x')).toBe(null);
        } finally {
            fetches.restore();
        }
        expect(fetches.calls).toEqual([]);
    });

    it('round-trips through an injected backend, with the TTL and the family tag', async () => {
        const backend = memoryBackend();
        __setSharedCacheBackendForTests(backend);
        await sharedSet('cl:v1:LOX:cur-1', { changelog: 'x' }, { ttl: 3600 });
        expect(await sharedGet('cl:v1:LOX:cur-1')).toEqual({ changelog: 'x' });
        expect(backend.writes).toEqual([{ key: 'cl:v1:LOX:cur-1', options: { tags: ['cl'], ttl: 3600 } }]);
        await sharedSet('lede:v1:2026-11-12T05:23:00.000Z', { deck: 'd' }, { ttl: 60, name: 'lede' });
        expect(backend.writes[1].options).toEqual({ tags: ['lede'], ttl: 60, name: 'lede' });
    });

    it('reads a miss as null, and never touches the backend for a null key', async () => {
        const backend = memoryBackend();
        __setSharedCacheBackendForTests(backend);
        expect(await sharedGet('ti:v1:LOX:missing')).toBe(null);
        expect(await sharedGet(null)).toBe(null);
        await sharedSet(null, { a: 1 });
        await sharedSet('ti:v1:LOX:x', undefined);
        expect(backend.reads).toEqual(['ti:v1:LOX:missing']);
        expect(backend.writes).toEqual([]);
        __setSharedCacheBackendForTests({ get: async () => undefined, set: async () => {} });
        expect(await sharedGet('ti:v1:LOX:x')).toBe(null);
    });

    it('never throws or rejects when the backend throws, rejects, or is malformed', async () => {
        for (const backend of [
            { get: () => { throw new Error('sync boom'); }, set: () => { throw new Error('sync boom'); } },
            { get: async () => { throw new Error('async boom'); }, set: async () => { throw new Error('async boom'); } },
            { get: 'not a function', set: null },
        ]) {
            __setSharedCacheBackendForTests(backend);
            expect(await sharedGet('ti:v1:LOX:x')).toBe(null);
            expect(await sharedSet('ti:v1:LOX:x', { a: 1 }, { ttl: 60 })).toBeUndefined();
        }
    });

    it('a hanging backend costs at most the guard timeout, then reads as a miss', async () => {
        __setSharedCacheBackendForTests({ get: () => new Promise(() => {}), set: () => new Promise(() => {}) });
        let t = performance.now();
        expect(await sharedGet('ti:v1:LOX:x')).toBe(null);
        let elapsed = performance.now() - t;
        expect(elapsed).toBeGreaterThanOrEqual(GET_TIMEOUT_MS - 5);
        expect(elapsed).toBeLessThan(GET_TIMEOUT_MS + 200);

        t = performance.now();
        await sharedSet('ti:v1:LOX:x', { a: 1 });
        elapsed = performance.now() - t;
        expect(elapsed).toBeLessThan(SET_TIMEOUT_MS + 200);
    });

    it('a late rejection after the timeout is swallowed, not left unhandled', async () => {
        let unhandled = 0;
        const onUnhandled = () => { unhandled += 1; };
        process.on('unhandledRejection', onUnhandled);
        try {
            __setSharedCacheBackendForTests({
                get: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), GET_TIMEOUT_MS + 50)),
                set: async () => {},
            });
            expect(await sharedGet('ti:v1:LOX:x')).toBe(null);
            await new Promise(r => setTimeout(r, 120));
            expect(unhandled).toBe(0);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });

    it('an injected backend wins over the environment check', async () => {
        delete process.env.VERCEL;
        const backend = memoryBackend();
        backend.seed('ti:v1:LOX:x', { ok: true });
        __setSharedCacheBackendForTests(backend);
        expect(await sharedGet('ti:v1:LOX:x')).toEqual({ ok: true });
    });
});

// ── The engine's families and I/O (api/_store.js, api/cron-refresh.js) ──
import {
    editionKey, pollStateKey, leaseKey, modelCallsKey, sectionKey,
    storeRead, storeWrite, purgeTag, __setPurgeBackendForTests,
    STORE_READ_TIMEOUT_MS,
} from '../api/_shared-cache.js';

describe('api/_shared-cache.js engine key builders', () => {
    it('build versioned keys per family', () => {
        expect(editionKey('lox')).toBe('ed:v1:LOX');
        expect(pollStateKey()).toBe('poll:v1');
        expect(leaseKey()).toBe('lease:v1');
        expect(modelCallsKey('2026-11-18')).toBe('mc:v1:2026-11-18');
        expect(sectionKey('LOX', 'a'.repeat(64))).toBe(`ts:v1:LOX:${'a'.repeat(64)}`);
    });

    it('return null for input that cannot name an entry', () => {
        for (const o of [null, '', 'LOXX', 'L0X']) expect(editionKey(o)).toBe(null);
        for (const d of [null, '2026-1-18', 'today', 20261118]) expect(modelCallsKey(d)).toBe(null);
        expect(sectionKey('LOX', 'abc')).toBe(null);
        expect(sectionKey('LOX', 'G'.repeat(64))).toBe(null);
        expect(sectionKey('LOXX', 'a'.repeat(64))).toBe(null);
    });
});

describe('api/_shared-cache.js storeRead / storeWrite', () => {
    afterEach(() => __setPurgeBackendForTests(null));

    it('tells a miss from a failure', async () => {
        const backend = memoryBackend();
        __setSharedCacheBackendForTests(backend);
        expect(await storeRead('ed:v1:LOX')).toEqual({ ok: true, value: null });
        backend.seed('ed:v1:LOX', { a: 1 });
        expect(await storeRead('ed:v1:LOX')).toEqual({ ok: true, value: { a: 1 } });

        __setSharedCacheBackendForTests({ get: async () => { throw new Error('down'); }, set: async () => {} });
        expect(await storeRead('ed:v1:LOX')).toEqual({ ok: false });
        expect(await storeRead(null)).toEqual({ ok: false });
    });

    it('a hanging read is a failure after its timeout, not a miss', async () => {
        __setSharedCacheBackendForTests({ get: () => new Promise(() => {}), set: async () => {} });
        const t = performance.now();
        expect(await storeRead('poll:v1')).toEqual({ ok: false });
        expect(performance.now() - t).toBeLessThan(STORE_READ_TIMEOUT_MS + 200);
        expect(await storeRead('poll:v1', { timeoutMs: 20 })).toEqual({ ok: false });
    });

    it('off Vercel there is no store: reads and writes fail, nothing is touched', async () => {
        delete process.env.VERCEL;
        expect(await storeRead('poll:v1')).toEqual({ ok: false });
        expect(await storeWrite('poll:v1', { at: 1 })).toBe(false);
    });

    it('writes untagged, with the TTL, and reports success', async () => {
        const backend = memoryBackend();
        __setSharedCacheBackendForTests(backend);
        expect(await storeWrite('ed:v1:LOX', { a: 1 }, { ttl: 3600 })).toBe(true);
        expect(await storeWrite('poll:v1', { at: 1 })).toBe(true);
        expect(backend.writes).toEqual([
            { key: 'ed:v1:LOX', options: { ttl: 3600 } },
            { key: 'poll:v1', options: {} },
        ]);
        expect(await storeWrite(null, { a: 1 })).toBe(false);
        expect(await storeWrite('poll:v1', undefined)).toBe(false);
    });

    it('a failing or hanging write reports false, never throws', async () => {
        __setSharedCacheBackendForTests({ get: async () => null, set: async () => { throw new Error('down'); } });
        expect(await storeWrite('poll:v1', { at: 1 })).toBe(false);
        __setSharedCacheBackendForTests({ get: async () => null, set: () => new Promise(() => {}) });
        expect(await storeWrite('poll:v1', { at: 1 }, { timeoutMs: 20 })).toBe(false);
    });
});

describe('api/_shared-cache.js purgeTag', () => {
    afterEach(() => __setPurgeBackendForTests(null));

    it('hard-deletes or invalidates through the injected API, with the tag list', async () => {
        const calls = [];
        __setPurgeBackendForTests({
            invalidateByTag: async (t) => { calls.push(['invalidate', t]); },
            dangerouslyDeleteByTag: async (t) => { calls.push(['delete', t]); },
        });
        expect(await purgeTag('office-LOX', { hard: true })).toEqual({ ok: true });
        expect(await purgeTag(['office-LOX', 'home'])).toEqual({ ok: true });
        expect(calls).toEqual([['delete', ['office-LOX']], ['invalidate', ['office-LOX', 'home']]]);
    });

    it('drops tags that cannot be tags (commas, empty) and refuses an empty list', async () => {
        const calls = [];
        __setPurgeBackendForTests({ invalidateByTag: async (t) => { calls.push(t); }, dangerouslyDeleteByTag: async () => {} });
        expect(await purgeTag(['a,b', '', null])).toEqual({ ok: false, reason: 'no-tags' });
        expect(calls).toEqual([]);
    });

    it('a resolved promise is not proof: no request context or off Vercel reports not purged', async () => {
        delete process.env.VERCEL;
        expect((await purgeTag('office-LOX', { hard: true })).ok).toBe(false);
        process.env.VERCEL = '1';
        expect(await purgeTag('office-LOX', { hard: true })).toEqual({ ok: false, reason: 'no-purge-context' });
    });

    it('a throwing or hanging purge API reports failure, never throws', async () => {
        __setPurgeBackendForTests({ invalidateByTag: async () => { throw new Error('purge 500'); }, dangerouslyDeleteByTag: () => { throw new Error('sync'); } });
        expect(await purgeTag('office-LOX')).toEqual({ ok: false, reason: 'purge 500' });
        expect(await purgeTag('office-LOX', { hard: true })).toEqual({ ok: false, reason: 'sync' });
    });
});
