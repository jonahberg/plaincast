// api/_store.js: the edition store's pure logic and the one read a page
// makes. See tests/engine-cron.test.js for the poller that writes it.
import { describe, it, expect, afterEach } from 'bun:test';
import { memoryBackend } from './shared-cache-backend.js';
import { OFFICE_NAMES } from '../docs/js/offices.js';
import {
    officeFromIssuing, allOffices, officeTag, HOME_TAG, heartbeatFresh, HEARTBEAT_FRESH_MS,
    emptyState, mergeListing, groupByOffice, readRenderableEdition, validEdition, switchOn,
    STORE_RENDER, PRETRANSLATE, AI_FOR_AGENTS,
} from '../api/_store.js';
import { __setSharedCacheBackendForTests, editionKey, pollStateKey } from '../api/_shared-cache.js';

afterEach(() => __setSharedCacheBackendForTests(null));

const item = (office, id, iso) => ({ id, issuingOffice: office, issuanceTime: iso, productCode: 'AFD' });

describe('issuing office → office code', () => {
    it('drops the K of a contiguous-US id', () => {
        expect(officeFromIssuing('KOTX')).toBe('OTX');
        expect(officeFromIssuing('KLOX')).toBe('LOX');
        expect(officeFromIssuing('klot')).toBe('LOT');
    });

    it('maps the ids that are not K + code', () => {
        expect(officeFromIssuing('TJSJ')).toBe('SJU');
        expect(officeFromIssuing('NSTU')).toBe('PPG');
        expect(officeFromIssuing('PAFC')).toBe('AFC');
        expect(officeFromIssuing('PAFG')).toBe('AFG');
        expect(officeFromIssuing('PAJK')).toBe('AJK');
        expect(officeFromIssuing('PHFO')).toBe('HFO');
        expect(officeFromIssuing('PGUM')).toBe('GUM');
    });

    it('returns null for anything else', () => {
        for (const bad of [null, undefined, '', 'LOX', 'KLOXX', 'PABC', 'K12A', 42]) expect(officeFromIssuing(bad)).toBe(null);
    });

    it('"all offices" is OFFICE_NAMES, whatever its size', () => {
        expect(allOffices()).toEqual(Object.keys(OFFICE_NAMES));
    });
});

describe('tags and switches', () => {
    it('page tags never collide with the shared-cache family tags', () => {
        for (const code of allOffices()) {
            const tag = officeTag(code);
            expect(['ti', 'cl', 'lede']).not.toContain(tag);
            expect(tag).not.toContain(',');
        }
        expect(['ti', 'cl', 'lede']).not.toContain(HOME_TAG);
    });

    it('a switch is on only for the exact value "1"', () => {
        const saved = process.env[STORE_RENDER];
        try {
            for (const v of [undefined, '', '0', 'true', 'yes', ' 1']) {
                if (v === undefined) delete process.env[STORE_RENDER]; else process.env[STORE_RENDER] = v;
                expect(switchOn(STORE_RENDER)).toBe(false);
            }
            process.env[STORE_RENDER] = '1';
            expect(switchOn(STORE_RENDER)).toBe(true);
        } finally {
            if (saved === undefined) delete process.env[STORE_RENDER]; else process.env[STORE_RENDER] = saved;
        }
        expect(new Set([STORE_RENDER, PRETRANSLATE, AI_FOR_AGENTS]).size).toBe(3);
    });
});

describe('heartbeat freshness', () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    it('fresh up to 10 minutes, stale after, never for garbage or the far future', () => {
        expect(heartbeatFresh('2026-11-18T11:59:00Z', now)).toBe(true);
        expect(heartbeatFresh(new Date(now - HEARTBEAT_FRESH_MS).toISOString(), now)).toBe(true);
        expect(heartbeatFresh(new Date(now - HEARTBEAT_FRESH_MS - 1000).toISOString(), now)).toBe(false);
        expect(heartbeatFresh('2026-11-18T13:00:00Z', now)).toBe(false);
        for (const bad of [null, undefined, '', 'yesterday', 12]) expect(heartbeatFresh(bad, now)).toBe(false);
    });
});

describe('mergeListing', () => {
    it('a full listing sets the newest product per office and its predecessor', () => {
        const state = emptyState();
        const changed = mergeListing(state, [
            item('KLOX', 'lox-3', '2026-11-18T11:00:00+00:00'),
            item('KOKX', 'okx-2', '2026-11-18T10:00:00+00:00'),
            item('KLOX', 'lox-2', '2026-11-18T05:00:00+00:00'),
            item('KLOX', 'lox-1', '2026-11-17T23:00:00+00:00'),
            item('KZZZ', 'zzz-1', '2026-11-18T11:30:00+00:00'), // not a Plaincast office
            item('PAFC', 'afc-1', '2026-11-18T09:00:00+00:00'),
        ], { full: true });
        expect(changed.sort()).toEqual(['AFC', 'LOX', 'OKX']);
        expect(state.offices.LOX).toEqual({ id: 'lox-3', issuanceTime: '2026-11-18T11:00:00+00:00', prevId: 'lox-2' });
        expect(state.offices.OKX).toEqual({ id: 'okx-2', issuanceTime: '2026-11-18T10:00:00+00:00', prevId: null });
        expect(state.offices.AFC.id).toBe('afc-1');
        expect(state.offices.ZZZ).toBeUndefined();
    });

    it('an incremental listing moves an office forward and names the product it replaced', () => {
        const state = emptyState();
        state.offices.LOX = { id: 'lox-2', issuanceTime: '2026-11-18T05:00:00+00:00', prevId: 'lox-1', stored: 'lox-2', purge: { id: 'lox-2', n: 2 } };
        let changed = mergeListing(state, [item('KLOX', 'lox-3', '2026-11-18T11:00:00+00:00')]);
        expect(changed).toEqual(['LOX']);
        expect(state.offices.LOX).toMatchObject({ id: 'lox-3', prevId: 'lox-2', stored: 'lox-2', purge: { id: 'lox-2', n: 2 } });

        // Two new ones in one window: the predecessor is the second newest.
        changed = mergeListing(state, [
            item('KLOX', 'lox-5', '2026-11-18T17:00:00+00:00'),
            item('KLOX', 'lox-4', '2026-11-18T14:00:00+00:00'),
            item('KLOX', 'lox-3', '2026-11-18T11:00:00+00:00'),
        ]);
        expect(changed).toEqual(['LOX']);
        expect(state.offices.LOX).toMatchObject({ id: 'lox-5', prevId: 'lox-4' });

        // The same newest product again: nothing changes.
        expect(mergeListing(state, [item('KLOX', 'lox-5', '2026-11-18T17:00:00+00:00')])).toEqual([]);
        // An older product (a late-indexed one, or a correction) never moves it back.
        expect(mergeListing(state, [item('KLOX', 'lox-x', '2026-11-18T16:00:00+00:00')])).toEqual([]);
        expect(state.offices.LOX.id).toBe('lox-5');
    });

    it('the full list never moves an office back to an earlier product (a lagging list)', () => {
        const state = emptyState();
        state.offices.LOX = { id: 'lox-3', issuanceTime: '2026-11-18T11:00:00+00:00', prevId: 'lox-2', stored: 'lox-3' };
        const changed = mergeListing(state, [
            item('KLOX', 'lox-2', '2026-11-18T05:00:00+00:00'),
            item('KLOX', 'lox-1', '2026-11-17T23:00:00+00:00'),
        ], { full: true });
        expect(changed).toEqual([]);
        expect(state.offices.LOX).toEqual({ id: 'lox-3', issuanceTime: '2026-11-18T11:00:00+00:00', prevId: 'lox-2', stored: 'lox-3' });
    });

    it('the full list corrects the predecessor of the product already known', () => {
        const state = emptyState();
        // An incremental window missed lox-2b, so lox-2 was taken as the predecessor.
        state.offices.LOX = { id: 'lox-3', issuanceTime: '2026-11-18T11:00:00+00:00', prevId: 'lox-2', stored: 'lox-3' };
        const changed = mergeListing(state, [
            item('KLOX', 'lox-3', '2026-11-18T11:00:00+00:00'),
            item('KLOX', 'lox-2b', '2026-11-18T08:00:00+00:00'),
            item('KLOX', 'lox-2', '2026-11-18T05:00:00+00:00'),
        ], { full: true });
        expect(changed).toEqual([]);
        expect(state.offices.LOX).toMatchObject({ id: 'lox-3', prevId: 'lox-2b', stored: 'lox-3' });
    });

    it('a same-time twin (a correction) is a new edition: tie (live path), id moves, office reported changed', () => {
        const state = emptyState();
        state.offices.LOX = { id: 'lox-2', issuanceTime: '2026-11-18T05:00:00+00:00', prevId: 'lox-1', stored: 'lox-2', purge: { id: 'lox-2', n: 2 } };
        const changed = mergeListing(state, [item('KLOX', 'lox-2b', '2026-11-18T05:00:00+00:00')]);
        expect(changed).toEqual(['LOX']);
        expect(state.offices.LOX).toMatchObject({ id: 'lox-2b', prevId: 'lox-1', tie: true, tieIds: ['lox-2', 'lox-2b'], stored: 'lox-2' });
        // Seen again: nothing new.
        expect(mergeListing(state, [item('KLOX', 'lox-2', '2026-11-18T05:00:00+00:00'), item('KLOX', 'lox-2b', '2026-11-18T05:00:00+00:00')])).toEqual([]);
        // A newer issuance clears it.
        expect(mergeListing(state, [item('KLOX', 'lox-3', '2026-11-18T11:00:00+00:00')])).toEqual(['LOX']);
        expect(state.offices.LOX.tie).toBeUndefined();
        expect(state.offices.LOX.tieIds).toBeUndefined();
        expect(state.offices.LOX).toMatchObject({ id: 'lox-3', prevId: 'lox-2b' });
    });

    it('twin detection does not depend on listing order, in either mode', () => {
        const P = item('KOTX', 'P', '2026-11-18T22:45:00+00:00');
        const A = item('KOTX', 'A', '2026-11-18T23:11:00+00:00');
        const B = item('KOTX', 'B-RRA', '2026-11-18T23:11:00+00:00');
        for (const full of [false, true]) {
            for (const order of [[A, B, P], [B, A, P]]) {
                const s = emptyState();
                mergeListing(s, [P], { full: true });
                mergeListing(s, [A, P]);
                s.offices.OTX.purge = { id: 'A', n: 2 };
                s.offices.OTX.stored = 'A';
                expect(mergeListing(s, order, { full })).toEqual(['OTX']);
                expect(s.offices.OTX).toMatchObject({ id: 'B-RRA', prevId: 'P', tie: true, tieIds: ['A', 'B-RRA'] });
            }
        }
        // Both twins in the first listing ever: a tie either way round, same id.
        for (const order of [[A, B, P], [B, A, P]]) {
            const s = emptyState();
            mergeListing(s, order, { full: true });
            expect(s.offices.OTX).toMatchObject({ id: 'B-RRA', prevId: 'P', tie: true });
        }
    });

    it('drops malformed items', () => {
        const g = groupByOffice([
            item('KLOX', 'ok-1', '2026-11-18T05:00:00Z'),
            item('KLOX', '<bad>', '2026-11-18T06:00:00Z'),
            item('KLOX', 'no-time', 'soon'),
            null,
            { id: 'x' },
        ]);
        expect([...g.keys()]).toEqual(['LOX']);
        expect(g.get('LOX').map(x => x.id)).toEqual(['ok-1']);
        expect(groupByOffice(null).size).toBe(0);
    });
});

describe('readRenderableEdition', () => {
    const NOW = Date.parse('2026-11-18T12:00:00Z');
    const text = '.SYNOPSIS...\nFog.\n\n$$';
    const record = (over = {}) => ({
        v: 1, office: 'LOX',
        current: { id: 'lox-3', issuanceTime: '2026-11-18T11:00:00+00:00', productText: text, storedAt: '2026-11-18T11:05:00Z', prevId: 'lox-2' },
        previous: { id: 'lox-2', issuanceTime: '2026-11-18T05:00:00+00:00', productText: 'prev text' },
        ...over,
    });
    const state = (over = {}) => ({
        v: 1, at: '2026-11-18T11:55:00Z', fullAt: '2026-11-18T08:00:00Z',
        offices: { LOX: { id: 'lox-3', issuanceTime: '2026-11-18T11:00:00+00:00', prevId: 'lox-2', stored: 'lox-3', purge: { id: 'lox-3', n: 1 } } },
        ...over,
    });
    function seed(s, r) {
        const b = memoryBackend();
        if (s !== undefined) b.seed(pollStateKey(), s);
        if (r !== undefined) b.seed(editionKey('LOX'), r);
        __setSharedCacheBackendForTests(b);
        return b;
    }

    it('returns the stored edition and its exact predecessor when everything agrees', async () => {
        const b = seed(state(), record());
        const got = await readRenderableEdition('LOX', { now: NOW });
        expect(got).toEqual({
            current: { id: 'lox-3', issuanceTime: '2026-11-18T11:00:00+00:00', productText: text },
            previous: { id: 'lox-2', issuanceTime: '2026-11-18T05:00:00+00:00', productText: 'prev text' },
        });
        expect(b.reads.sort()).toEqual([editionKey('LOX'), pollStateKey()].sort());
    });

    it('omits a previous edition that is not the listed predecessor', async () => {
        seed(state(), record({ previous: { id: 'lox-1', issuanceTime: 'x', productText: 'older' } }));
        expect((await readRenderableEdition('LOX', { now: NOW })).previous).toBe(null);
        seed(state(), record({ previous: null }));
        expect((await readRenderableEdition('LOX', { now: NOW })).previous).toBe(null);
    });

    it('no successful hard purge for this edition → null (the purge API may be unavailable)', async () => {
        for (const purge of [undefined, { id: 'lox-2', n: 2 }]) {
            const s = state();
            s.offices.LOX.purge = purge;
            seed(s, record());
            expect(await readRenderableEdition('LOX', { now: NOW })).toBe(null);
        }
    });

    it('stale heartbeat → null (live path)', async () => {
        seed(state({ at: '2026-11-18T11:49:00Z' }), record());
        expect(await readRenderableEdition('LOX', { now: NOW })).toBe(null);
    });

    it('a newer product seen but not stored → null: never render a superseded forecast', async () => {
        const s = state();
        s.offices.LOX = { ...s.offices.LOX, id: 'lox-4', prevId: 'lox-3' };
        seed(s, record());
        expect(await readRenderableEdition('LOX', { now: NOW })).toBe(null);
    });

    it('store miss, missing office, a tie, a malformed record or state → null', async () => {
        seed(state(), undefined);
        expect(await readRenderableEdition('LOX', { now: NOW })).toBe(null);
        seed(undefined, record());
        expect(await readRenderableEdition('LOX', { now: NOW })).toBe(null);
        seed(state({ offices: {} }), record());
        expect(await readRenderableEdition('LOX', { now: NOW })).toBe(null);
        const tie = state();
        tie.offices.LOX.tie = true;
        seed(tie, record());
        expect(await readRenderableEdition('LOX', { now: NOW })).toBe(null);
        for (const bad of [
            record({ v: 2 }), record({ office: 'OKX' }),
            record({ current: { id: 'lox-3', issuanceTime: '2026-11-18T11:00:00+00:00', productText: '' } }),
            record({ current: { id: 'lox-3', productText: text } }),
            'string', null,
        ]) {
            seed(state(), bad);
            expect(await readRenderableEdition('LOX', { now: NOW })).toBe(null);
        }
        seed({ ...state(), v: 9 }, record());
        expect(await readRenderableEdition('LOX', { now: NOW })).toBe(null);
    });

    it('a failing or hanging store → null, within the read timeout', async () => {
        __setSharedCacheBackendForTests({ get: async () => { throw new Error('down'); }, set: async () => {} });
        expect(await readRenderableEdition('LOX', { now: NOW })).toBe(null);
        __setSharedCacheBackendForTests({ get: () => new Promise(() => {}), set: async () => {} });
        const t = performance.now();
        expect(await readRenderableEdition('LOX', { now: NOW })).toBe(null);
        expect(performance.now() - t).toBeLessThan(600);
    });

    it('off Vercel (no store) → null', async () => {
        const saved = process.env.VERCEL;
        delete process.env.VERCEL;
        try {
            expect(await readRenderableEdition('LOX', { now: NOW })).toBe(null);
        } finally {
            if (saved !== undefined) process.env.VERCEL = saved;
        }
    });

    it('validEdition checks the office and the record version', () => {
        expect(validEdition(record(), 'LOX')).not.toBe(null);
        expect(validEdition(record(), 'OKX')).toBe(null);
    });
});
