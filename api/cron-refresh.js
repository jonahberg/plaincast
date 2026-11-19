// Vercel cron function (vercel.json `crons`, every 5 minutes, production
// only): the edition poller. It does nothing at all (no store, no NWS) unless
// PLAINCAST_POLLER=1 or a feature switch that needs it is on, so merging the
// engine changes nothing. With PLAINCAST_POLLER alone it only polls
// api.weather.gov and keeps the edition store (api/_store.js) current.
// Rollout: POLLER (watch the summaries), then STORE_RENDER, then
// PRETRANSLATE, then AI_FOR_AGENTS.
//
// One run, in order:
//   1. Lease. One run at a time, and at most one run per MIN_RUN_INTERVAL_MS
//      whoever calls (Vercel's scheduler, or a person on a preview, where a
//      missing CRON_SECRET is allowed): extra calls cost one store read.
//      Production refuses every call until CRON_SECRET is set. The lease is
//      re-read before every state save and model-call reservation; a run
//      that lost it to a racing one stops.
//   2. Poll. The AFDs issued since the last heartbeat minus a margin (the
//      7-day list on a cold start and every FULL_RECONCILE_MS). The state
//      records the newest product per office; the HEARTBEAT is written only
//      after a poll that succeeded, and right away, so a page stops
//      rendering an edition the listing shows superseded.
//   3. Fetch. Every office whose newest product is not the stored edition
//      (derived from state, so a deferred fetch is retried next run):
//      at most FETCH_CAP products, FETCH_CONCURRENCY at a time; a 403/429
//      ends the phase ("try next run"). The stored current edition rotates
//      to previous when it is the new one's predecessor.
//   4. Purge (PLAINCAST_STORE_RENDER=1). Hard-delete the CDN copies of every
//      office whose newest product changed, in this run and the next (a
//      render racing the first purge can re-cache the old page once).
//   5. Pre-translate (PLAINCAST_PRETRANSLATE=1). The current edition of each
//      office, newest issuance first (the one readers are arriving at now,
//      and the least likely to be superseded before it is read), through the
//      same core as /api/translate-issuance, plus the changelog sentence.
//      Spend controls: section reuse, PLAINCAST_PRETRANSLATE_PER_RUN
//      model-call tasks per run (default 6: an issuance's translation or a
//      changelog sentence; each call one request, no SDK retries), issuances
//      2 at a time, a start-time budget well
//      inside maxDuration, PLAINCAST_PRETRANSLATE_DAILY_MAX model calls per
//      UTC day (default 3000) reserved in the store BEFORE each call (no
//      counter, no call), and MAX_ATTEMPTS per edition. A cap ends the phase
//      quietly; on-demand translation keeps working.
//   6. Invalidate (PLAINCAST_STORE_RENDER=1). Mark an office's pages stale
//      once its translation set is complete, so the next render carries it.
// Every phase degrades to "nothing done, try next run"; nothing here can
// fail a page. The response is a JSON summary of the run.
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { sendError } from './_errors.js';
import { rejectUnknownParams } from './_query-guard.js';
import {
    changelogKey, editionKey, leaseKey, modelCallsKey, pollStateKey, translationKey,
    purgeTag as purgeTagDefault, storeRead, storeWrite,
} from './_shared-cache.js';
import {
    AI_FOR_AGENTS, EDITION_VERSION, POLLER, PRETRANSLATE, STORE_RENDER,
    allOffices, emptyState, mergeListing, officeTag, validEdition, validState,
} from './_store.js';
import { fetchAFDsSince, fetchAFDWeek, fetchProductById } from './_nws-feed.js';

export const LEASE_MS = 290 * 1000;
export const MIN_RUN_INTERVAL_MS = 240 * 1000;
export const POLL_MARGIN_MS = 60 * 60 * 1000;
export const FULL_RECONCILE_MS = 6 * 60 * 60 * 1000;
export const FETCH_CAP = 30;
export const FETCH_CONCURRENCY = 4;
export const FETCH_PHASE_MS = 90 * 1000;          // no new product fetch after this
export const TRANSLATE_START_MS = 200 * 1000;     // no new issuance translation after this (maxDuration 300)
export const TRANSLATE_CONCURRENCY = 2;
export const MAX_ATTEMPTS = 2;                    // per edition id, translation and changelog each
export const PURGES_PER_EDITION = 2;
export const PURGE_BATCH = 50;                    // tags per purge call
export const VERIFY_PER_RUN = 12;
export const PER_RUN_DEFAULT = 6;
export const DAILY_MAX_DEFAULT = 3000;
const DAY = 24 * 60 * 60;
const EDITION_TTL = 7 * DAY;
const STATE_TTL = 7 * DAY;
const COUNTER_TTL = 3 * DAY;
const LEASE_TTL = 60 * 60;
const IO = { timeoutMs: 1500 };

function intEnv(env, name, fallback) {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

const DEFAULT_DEPS = {
    fetchAFDsSince,
    fetchAFDWeek,
    fetchProductById,
    purgeTag: purgeTagDefault,
    // Loaded only when pre-translating: the AI SDK can never stop a poll.
    translation: () => import('./translate-issuance.js'),
    changelog: () => import('./changelog.js'),
    reuse: () => import('./_section-reuse.js'),
};

// Thrown when a later run has taken the lease: this run stops before its
// next state save or model-call reservation.
class LeaseLost extends Error {
    constructor() { super('lease lost'); this.name = 'LeaseLost'; }
}

// The poller runs only when it, or a feature that needs it, is switched on.
export function pollerEnabled(env) {
    return [POLLER, STORE_RENDER, PRETRANSLATE, AI_FOR_AGENTS].some(k => env[k] === '1');
}

// A product from NWS, checked against what the listing said it was.
export function productForOffice(prod, office, id) {
    if (!prod || typeof prod !== 'object') return null;
    if (prod.id !== undefined && prod.id !== id) return null;
    const text = prod.productText;
    if (typeof text !== 'string' || !text || typeof prod.issuanceTime !== 'string') return null;
    // The AWIPS line ("AFDLOX") names the office the product is FOR; a
    // product that names another one is not stored (the office stays live).
    const awips = text.split('\n').slice(0, 8).map(l => l.trim()).find(l => /^AFD[A-Z]{3}$/.test(l));
    if (awips && awips !== `AFD${office}`) return null;
    return { id, issuanceTime: prod.issuanceTime, productText: text };
}

function completeTranslation(entry, office, id) {
    if (!entry || typeof entry !== 'object' || entry.office !== office || entry.id !== id || entry.complete !== true) return false;
    const s = entry.sections;
    return Boolean(s && typeof s === 'object' && !Array.isArray(s) && Object.keys(s).length
        && Object.values(s).every(v => typeof v === 'string' && v));
}

function storedVerdict(entry, office, id) {
    return Boolean(entry && typeof entry === 'object' && entry.office === office && entry.id === id
        && !entry.transient && (entry.changelog === null || typeof entry.changelog === 'string'));
}

// Runs `fn` over `items` with at most `n` in flight; `fn` returning false
// stops the pool from starting more.
async function pool(items, n, fn) {
    let i = 0;
    let stopped = false;
    const worker = async () => {
        while (!stopped && i < items.length) {
            const item = items[i++];
            if ((await fn(item)) === false) stopped = true;
        }
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

async function acquireLease(runId, now) {
    const r = await storeRead(leaseKey(), IO);
    if (!r.ok) return { ok: false, reason: 'store-unavailable' };
    const l = r.value && typeof r.value === 'object' ? r.value : null;
    if (l && Number(l.until) > now && l.runId !== runId) return { ok: false, reason: 'busy' };
    if (l && Number(l.startedAt) > now - MIN_RUN_INTERVAL_MS) {
        return { ok: false, reason: 'too-soon', retryAfterSec: Math.ceil((Number(l.startedAt) + MIN_RUN_INTERVAL_MS - now) / 1000) };
    }
    const lease = { runId, startedAt: now, until: now + LEASE_MS };
    if (!(await storeWrite(leaseKey(), lease, { ttl: LEASE_TTL, ...IO }))) return { ok: false, reason: 'store-unavailable' };
    // Last writer wins: re-read so two simultaneous starts cannot both run.
    const check = await storeRead(leaseKey(), IO);
    if (!check.ok || check.value?.runId !== runId) return { ok: false, reason: 'busy' };
    return { ok: true, lease };
}

export async function runPoller({ now = () => Date.now(), env = process.env, deps: overrides = {} } = {}) {
    // Master switch: with PLAINCAST_POLLER and every feature off, nothing at
    // all (no store, no NWS), so merging the engine changes nothing.
    if (!pollerEnabled(env)) return { ok: true, skipped: 'disabled' };
    const deps = { ...DEFAULT_DEPS, ...overrides };
    const started = now();
    const elapsed = () => now() - started;
    const runId = randomUUID();
    const storeRender = env[STORE_RENDER] === '1';
    const pretranslate = env[PRETRANSLATE] === '1';
    const summary = {
        ok: true,
        runId,
        startedAt: new Date(started).toISOString(),
        switches: { poller: env[POLLER] === '1', storeRender, pretranslate, aiForAgents: env[AI_FOR_AGENTS] === '1' },
        skipped: null,
        poll: null,
        heartbeat: null,
        polled: 0,
        newEditions: [],
        fetched: 0,
        fetchDeferred: 0,
        fetchFailed: [],
        purged: { hard: 0, invalidated: 0, failures: [] },
        translated: 0,
        translatePartial: 0,
        translateFailed: 0,
        sectionsReused: 0,
        modelCalls: 0,
        changelogs: 0,
        skippedTranslation: 0,
        capsHit: [],
        dailyCalls: null,
        durationMs: 0,
    };
    const finish = () => { summary.durationMs = elapsed(); return summary; };
    const cap = (name) => { if (!summary.capsHit.includes(name)) summary.capsHit.push(name); };

    // 1. Lease.
    const lease = await acquireLease(runId, started);
    if (!lease.ok) {
        summary.skipped = lease.reason;
        if (lease.retryAfterSec) summary.retryAfterSec = lease.retryAfterSec;
        return finish();
    }

    // Two runs that start within one store round trip can both pass
    // acquireLease (last writer wins, but each may re-read before the other's
    // write lands). The loser finds out here: the lease is re-read before
    // every state save and every model-call reservation, and a run that no
    // longer holds it stops (summary.skipped = 'lease-lost').
    const holdsLease = async () => {
        const r = await storeRead(leaseKey(), IO);
        return r.ok && r.value?.runId === runId;
    };
    let leaseLost = false;

    try {
        const sr = await storeRead(pollStateKey(), IO);
        if (!sr.ok) { summary.skipped = 'store-unavailable'; return finish(); }
        const state = validState(sr.value) || emptyState();
        const saveState = async () => {
            if (!(await holdsLease())) throw new LeaseLost();
            return storeWrite(pollStateKey(), state, { ttl: STATE_TTL, ...IO });
        };
        const offices = allOffices();

        // 2. Poll.
        const fullDue = !state.at || !state.fullAt || started - Date.parse(state.fullAt) > FULL_RECONCILE_MS
            || !Number.isFinite(Date.parse(state.at));
        const since = fullDue ? null : new Date(Date.parse(state.at) - POLL_MARGIN_MS).toISOString();
        try {
            const items = fullDue ? await deps.fetchAFDWeek() : await deps.fetchAFDsSince(since);
            const changed = mergeListing(state, items, { full: fullDue });
            const at = new Date(now()).toISOString();
            state.at = at;
            if (fullDue) state.fullAt = at;
            summary.poll = { ok: true, mode: fullDue ? 'full' : 'since', since, items: items.length };
            summary.newEditions = changed;
            if (!(await saveState())) {
                summary.poll.heartbeatWritten = false;
                summary.skipped = 'store-unavailable';
                return finish();
            }
            summary.heartbeat = at;
        } catch (err) {
            if (err instanceof LeaseLost) throw err;
            summary.poll = { ok: false, mode: fullDue ? 'full' : 'since', since, error: String(err?.message || err).slice(0, 200) };
            console.warn('cron-refresh: poll failed:', summary.poll.error);
        }
        summary.polled = offices.filter(c => state.offices[c]?.id).length;

        // Rotating check that stored editions are still there (LRU eviction):
        // a lost record is fetched again.
        const stored = offices.filter(c => state.offices[c]?.stored);
        const startAt = Number.isInteger(state.verifyAt) ? state.verifyAt : 0;
        const verify = stored.length ? Array.from({ length: Math.min(VERIFY_PER_RUN, stored.length) }, (_, k) => stored[(startAt + k) % stored.length]) : [];
        state.verifyAt = stored.length ? (startAt + verify.length) % stored.length : 0;
        const editions = new Map(); // office -> record read or written this run
        await Promise.all(verify.map(async (code) => {
            const r = await storeRead(editionKey(code), IO);
            if (!r.ok) return;
            const rec = validEdition(r.value, code);
            const o = state.offices[code];
            if (!rec || rec.current.id !== o.stored) {
                delete o.stored;
                delete o.storedPrev;
            } else {
                editions.set(code, rec);
            }
        }));

        // 3. Fetch: current editions first (they unblock rendering), newest
        // issuance first; then predecessors missing from a stored record.
        const byNewest = (a, b) => Date.parse(state.offices[b].issuanceTime) - Date.parse(state.offices[a].issuanceTime);
        const needCurrent = offices.filter(c => state.offices[c]?.id && state.offices[c].stored !== state.offices[c].id).sort(byNewest);
        const needPrev = offices.filter(c => {
            const o = state.offices[c];
            return o?.id && o.stored === o.id && o.prevId && o.storedPrev !== o.prevId;
        }).sort(byNewest);
        const jobs = [...needCurrent.map(code => ({ code, kind: 'current' })), ...needPrev.map(code => ({ code, kind: 'previous' }))];
        const runJobs = jobs.slice(0, FETCH_CAP);
        summary.fetchDeferred = jobs.length - runJobs.length;
        if (summary.fetchDeferred > 0) cap('fetch-cap');
        let throttled = false;

        const fetchJob = async ({ code, kind }) => {
            if (throttled) { summary.fetchDeferred++; return; }
            if (elapsed() > FETCH_PHASE_MS) { summary.fetchDeferred++; cap('time'); return; }
            const o = state.offices[code];
            const wantId = kind === 'current' ? o.id : o.prevId;
            let prod;
            try {
                prod = productForOffice(await deps.fetchProductById(wantId), code, wantId);
            } catch (err) {
                if (err?.throttled) throttled = true;
                summary.fetchFailed.push({ office: code, id: wantId, reason: String(err?.message || err).slice(0, 80) });
                return;
            }
            if (!prod) {
                summary.fetchFailed.push({ office: code, id: wantId, reason: 'product does not match listing' });
                return;
            }
            summary.fetched++;
            let rec = editions.get(code);
            if (!rec) {
                const r = await storeRead(editionKey(code), IO);
                if (!r.ok) { summary.fetchFailed.push({ office: code, id: wantId, reason: 'store read failed' }); return; }
                rec = validEdition(r.value, code);
            }
            let next;
            if (kind === 'current') {
                const current = { ...prod, storedAt: new Date(now()).toISOString(), prevId: o.prevId || null };
                // Rotate: the old current becomes previous when it IS the
                // new edition's predecessor per the listing.
                let previous = null;
                if (o.prevId && rec?.current?.id === o.prevId) {
                    previous = { id: rec.current.id, issuanceTime: rec.current.issuanceTime, productText: rec.current.productText };
                } else if (o.prevId && rec?.previous?.id === o.prevId) {
                    previous = rec.previous;
                }
                next = { v: EDITION_VERSION, office: code, current, previous };
            } else {
                if (!rec || rec.current.id !== o.id) return;
                next = { ...rec, previous: { id: prod.id, issuanceTime: prod.issuanceTime, productText: prod.productText } };
            }
            if (!(await storeWrite(editionKey(code), next, { ttl: EDITION_TTL, ...IO }))) {
                summary.fetchFailed.push({ office: code, id: wantId, reason: 'store write failed' });
                return;
            }
            editions.set(code, next);
            o.stored = next.current.id;
            o.storedPrev = next.previous ? next.previous.id : null;
        };
        await pool(runJobs, FETCH_CONCURRENCY, fetchJob);
        if (throttled) cap('nws-throttled');
        await saveState();

        // 4. Purge (hard) every office whose newest product changed.
        if (storeRender) {
            const due = offices.filter(c => {
                const o = state.offices[c];
                return o?.id && !(o.purge?.id === o.id && o.purge.n >= PURGES_PER_EDITION);
            });
            for (let k = 0; k < due.length; k += PURGE_BATCH) {
                const batch = due.slice(k, k + PURGE_BATCH);
                const r = await deps.purgeTag(batch.map(officeTag), { hard: true });
                if (r?.ok) {
                    for (const c of batch) {
                        const o = state.offices[c];
                        o.purge = { id: o.id, n: (o.purge?.id === o.id ? o.purge.n : 0) + 1 };
                    }
                    summary.purged.hard += batch.length;
                } else {
                    summary.purged.failures.push({ kind: 'hard', offices: batch.length, reason: r?.reason || 'failed' });
                    console.warn('cron-refresh: hard purge failed:', r?.reason);
                }
            }
            if (due.length) await saveState();
        }

        // 5. Pre-translate.
        if (pretranslate) {
            await pretranslatePhase({ state, editions, offices, deps, env, now, elapsed, summary, cap, holdsLease });
            await saveState();
        }

        // 6. Invalidate pages whose translation set became complete.
        if (storeRender) {
            const due = offices.filter(c => {
                const o = state.offices[c];
                return o?.id && o.tr?.id === o.id && o.tr.done && o.ai !== o.id;
            });
            for (let k = 0; k < due.length; k += PURGE_BATCH) {
                const batch = due.slice(k, k + PURGE_BATCH);
                const r = await deps.purgeTag(batch.map(officeTag), { hard: false });
                if (r?.ok) {
                    for (const c of batch) state.offices[c].ai = state.offices[c].id;
                    summary.purged.invalidated += batch.length;
                } else {
                    summary.purged.failures.push({ kind: 'invalidate', offices: batch.length, reason: r?.reason || 'failed' });
                    console.warn('cron-refresh: invalidate failed:', r?.reason);
                }
            }
            if (due.length) await saveState();
        }
        return finish();
    } catch (err) {
        if (err instanceof LeaseLost) {
            leaseLost = true;
            summary.skipped = 'lease-lost';
            return finish();
        }
        summary.ok = false;
        summary.error = String(err?.message || err).slice(0, 200);
        console.warn('cron-refresh: run failed:', summary.error);
        return finish();
    } finally {
        // Release only a lease that is still ours: releasing another run's
        // would let a third start alongside it.
        if (!leaseLost && (await holdsLease())) {
            await storeWrite(leaseKey(), { ...lease.lease, until: 0 }, { ttl: LEASE_TTL, ...IO });
        }
    }
}

async function pretranslatePhase({ state, editions, offices, deps, env, now, elapsed, summary, cap, holdsLease }) {
    const perRun = intEnv(env, 'PLAINCAST_PRETRANSLATE_PER_RUN', PER_RUN_DEFAULT);
    const dailyMax = intEnv(env, 'PLAINCAST_PRETRANSLATE_DAILY_MAX', DAILY_MAX_DEFAULT);
    const exhausted = (rec, id) => rec?.id === id && (rec.done || rec.n >= MAX_ATTEMPTS);
    const candidates = offices.filter((c) => {
        const o = state.offices[c];
        return o?.id && o.stored === o.id && (!exhausted(o.tr, o.id) || !exhausted(o.cl, o.id));
    }).sort((a, b) => Date.parse(state.offices[b].issuanceTime) - Date.parse(state.offices[a].issuanceTime));
    if (candidates.length === 0) return;

    let core;
    let cl;
    let reuse;
    try {
        [core, cl, reuse] = await Promise.all([deps.translation(), deps.changelog(), deps.reuse()]);
    } catch (err) {
        summary.translateFailed++;
        cap('ai-unavailable');
        console.warn('cron-refresh: translation core unavailable:', err?.message || err);
        return;
    }

    // The day's counter. Unreadable → no model call this run (fail closed).
    const day = utcDay(now());
    const cr = await storeRead(modelCallsKey(day), IO);
    if (!cr.ok) { cap('counter-unavailable'); return; }
    let used = cr.value && cr.value.day === day && Number.isFinite(cr.value.calls) ? cr.value.calls : 0;
    summary.dailyCalls = { day, used, max: dailyMax };
    let chain = Promise.resolve();
    // Reserve n calls BEFORE making them; serialised, so this run's two
    // workers can never both spend the last of the budget. Each reservation
    // first re-checks the lease, then re-reads the counter and writes the
    // larger of the stored and the known count plus n, so another writer's
    // count is kept rather than overwritten. Resolves 'ok', 'cap',
    // 'unavailable' or 'lease-lost'.
    const reserve = (n) => {
        const step = chain.then(async () => {
            if (!(await holdsLease())) return 'lease-lost';
            const cur = await storeRead(modelCallsKey(day), IO);
            if (!cur.ok) return 'unavailable';
            const stored = cur.value && cur.value.day === day && Number.isFinite(cur.value.calls) ? cur.value.calls : 0;
            const base = Math.max(stored, used);
            used = base;
            summary.dailyCalls.used = used;
            if (base + n > dailyMax) return 'cap';
            if (!(await storeWrite(modelCallsKey(day), { day, calls: base + n }, { ttl: COUNTER_TTL, ...IO }))) return 'unavailable';
            used = base + n;
            summary.modelCalls += n;
            summary.dailyCalls.used = used;
            return 'ok';
        });
        chain = step.catch(() => {});
        return step;
    };
    const why = (r) => (r === 'cap' ? 'daily' : r === 'lease-lost' ? 'lease-lost' : 'counter-unavailable');

    // The per-run budget counts model-call tasks: one per issuance translated
    // (its sections run in parallel) and one per changelog sentence.
    let unitsThisRun = 0;
    let stop = null;
    const halt = (why) => { if (!stop) stop = why; cap(why); };

    const work = async (code) => {
        if (stop) return false;
        if (elapsed() > TRANSLATE_START_MS) { halt('time'); return false; }
        const o = state.offices[code];
        const id = o.id;
        let rec = editions.get(code);
        if (!rec) {
            const r = await storeRead(editionKey(code), IO);
            if (!r.ok) return true;
            rec = validEdition(r.value, code);
            if (!rec || rec.current.id !== id) {
                delete o.stored;
                return true;
            }
            editions.set(code, rec);
        }
        const { productText, issuanceTime } = rec.current;

        // Translation set.
        if (!exhausted(o.tr, id)) {
            const ti = await storeRead(translationKey(code, id), IO);
            if (ti.ok && completeTranslation(ti.value, code, id)) {
                o.tr = { id, n: o.tr?.id === id ? o.tr.n : 0, done: true };
                summary.skippedTranslation++;
            } else if (ti.ok) {
                let sections = core.translatableSections(productText);
                if (sections.length === 0) {
                    o.tr = { id, n: MAX_ATTEMPTS, none: true };
                } else {
                    sections = await reuse.withReusedSections(code, issuanceTime, sections, IO);
                    const needed = sections.filter(s => !s.reused).length;
                    if (needed > 0) {
                        if (unitsThisRun >= perRun) { halt('per-run'); return false; }
                        unitsThisRun++;
                        const r = await reserve(needed);
                        if (r !== 'ok') { unitsThisRun--; halt(why(r)); return false; }
                    }
                    summary.sectionsReused += sections.length - needed;
                    o.tr = { id, n: (o.tr?.id === id ? o.tr.n : 0) + 1 };
                    try {
                        const payload = await core.translateEdition({
                            office: code, id, issuanceTime, productText, sections,
                            onTranslated: (s, text) => reuse.storeReusedSection(code, issuanceTime, s, text),
                            maxRetries: 0, // one reserved call = one request
                        });
                        if (payload.complete) {
                            // Done only once the shared write landed. A lost
                            // write is retried next run, from the stored
                            // section translations (no new model calls).
                            if (await core.persistTranslation(code, id, payload, IO)) {
                                o.tr.done = true;
                                summary.translated++;
                            } else {
                                summary.translateUnstored = (summary.translateUnstored || 0) + 1;
                            }
                        } else {
                            summary.translatePartial++;
                        }
                    } catch {
                        summary.translateFailed++;
                    }
                }
            }
        }

        // The "since the last update" sentence, when the store holds the
        // exact predecessor.
        if (!exhausted(o.cl, id) && !stop) {
            const prev = rec.previous && o.prevId && rec.previous.id === o.prevId && rec.current.prevId === o.prevId
                ? rec.previous : null;
            if (prev) {
                const c = await storeRead(changelogKey(code, id), IO);
                if (c.ok && storedVerdict(c.value, code, id)) {
                    o.cl = { id, n: o.cl?.id === id ? o.cl.n : 0, done: true };
                } else if (c.ok) {
                    if (cl.needsModelCall(prev.productText, productText)) {
                        if (unitsThisRun >= perRun) { halt('per-run'); return false; }
                        unitsThisRun++;
                        const r = await reserve(1);
                        if (r !== 'ok') { unitsThisRun--; halt(why(r)); return false; }
                    }
                    o.cl = { id, n: (o.cl?.id === id ? o.cl.n : 0) + 1 };
                    try {
                        const v = await cl.summarizeChange({
                            office: code, currentId: id, currText: productText, prevText: prev.productText,
                            since: prev.issuanceTime || null, updated: issuanceTime || null,
                            charge: () => true,
                            maxRetries: 0,
                        });
                        if (v?.payload && v.stored) { o.cl.done = true; summary.changelogs++; }
                    } catch { /* attempt counted; on-demand still works */ }
                }
            }
        }
        return true;
    };
    await pool(candidates, TRANSLATE_CONCURRENCY, work);
}

// Fail closed in production. Vercel's scheduler sends `Authorization:
// Bearer <CRON_SECRET>` when that variable exists; production without it
// refuses every call (the schedule does nothing until it is configured).
// Outside production (a preview behind Deployment Protection, local, tests)
// a missing secret allows the call, so the poller can be run by hand.
// Returns 'ok', 'missing-secret' or 'bad-token'.
export function cronAuthorization(req, env = process.env) {
    const secret = typeof env.CRON_SECRET === 'string' ? env.CRON_SECRET : '';
    if (!secret) return env.VERCEL_ENV === 'production' ? 'missing-secret' : 'ok';
    const got = Buffer.from(String(req.headers?.authorization || ''));
    const want = Buffer.from(`Bearer ${secret}`);
    return got.length === want.length && timingSafeEqual(got, want) ? 'ok' : 'bad-token';
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', 'GET only', { allow: ['GET'] });
    const auth = cronAuthorization(req);
    if (auth === 'missing-secret') {
        return sendError(res, 401, 'forbidden', 'Not authorized', {
            hint: 'CRON_SECRET must be configured for production; the poller does no work without it.',
        });
    }
    if (auth !== 'ok') {
        return sendError(res, 401, 'forbidden', 'Not authorized', {
            hint: 'This endpoint is run by the Vercel scheduler with the project\'s CRON_SECRET.',
        });
    }
    if (rejectUnknownParams(req, res, [])) return;
    const summary = await runPoller();
    return res.status(200).json(summary);
}
