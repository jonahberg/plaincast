// The shared store for AI results: the Vercel Runtime Cache, a key-value
// store shared by every function of this project in a region (preview and
// production are kept apart). It is how a page render reads AI text that an
// AI endpoint already produced, and how a cold instance of an AI endpoint
// finds work another instance already paid for. It replaces the HTTP
// self-fetch the pages used to make, which could not work: the page function
// runs in one region, the CDN copy of a translation is created at the
// READER's edge, and CDN caches are per region.
//
// Rules:
//   - This is the only file that imports @vercel/functions.
//   - sharedGet / sharedSet NEVER throw or reject, and are time-bounded: a
//     cache problem must never fail or slow a request. A miss, an error and
//     a timeout all read as null.
//   - Active only on Vercel (process.env.VERCEL). Elsewhere (tests, local
//     dev) both are no-ops, so tests never share hidden state; tests inject
//     an explicit backend with __setSharedCacheBackendForTests.
//   - Every value carries its own identity (office + id, or the issuance)
//     and every reader checks it: a mismatch is a miss.
//
// THE STORE SURVIVES DEPLOYMENTS (unlike the CDN, which a deploy clears).
// Each key carries a version segment; bump that family's version below when
// the rules for its output change (prompt, sanitizer, model, value shape),
// or the new deployment keeps serving text made under the old rules.
//
// It is also ephemeral: entries can be evicted before their TTL, so every
// reader treats a miss as normal and falls back the way it did before.
import { createHash } from 'node:crypto';

// Key versions, one per family. Bump when that output's rules change.
export const TRANSLATION_KEY_VERSION = 'v2'; // api/translate-issuance.js (+ translate.js prompt/sanitizer). v2: date-range sanitizer + no-added-advice prompt rule (Nov 18 2026)
export const CHANGELOG_KEY_VERSION = 'v2';   // api/changelog.js. v2: no-added-advice prompt rule (Nov 18 2026)
export const LEDE_KEY_VERSION = 'v2';        // api/national-lede.js (+ translate.js sanitizer). v2: date-range sanitizer + no-added-advice prompt rule (Nov 18 2026)
// The engine's families (api/_store.js, api/cron-refresh.js). None of them is
// tagged: a CDN purge by tag also deletes Runtime Cache items carrying that
// tag, and the engine purges pages by tag.
export const SECTION_KEY_VERSION = 'v1';     // ts: one section's translation, for reuse. Same prompt,
                                             //     sanitizer and model as ti: bump the two together.
export const EDITION_KEY_VERSION = 'v1';     // ed: an office's current + previous edition
export const POLL_KEY_VERSION = 'v1';        // poll: the poller's state and heartbeat
export const COUNTER_KEY_VERSION = 'v1';     // mc: model calls per UTC day
export const LEASE_KEY_VERSION = 'v1';       // lease: one poller run at a time

// TTLs, in seconds (the Runtime Cache's unit).
export const TRANSLATION_TTL = 7 * 24 * 60 * 60;
export const CHANGELOG_TTL = 7 * 24 * 60 * 60;
export const LEDE_TTL = 2 * 24 * 60 * 60;

// Guard timeouts. A read sits on a page render's critical path; a write runs
// only after a multi-second model call, and is awaited so the function is not
// frozen before it lands (an un-awaited write can be lost once the response
// is sent).
export const GET_TIMEOUT_MS = 250;
export const SET_TIMEOUT_MS = 750;

const OFFICE_RE = /^[A-Z]{3}$/;
const ID_RE = /^[\w.:-]{1,64}$/; // the endpoints' own id contract

// `ti:v2:LOX:<id>`: a complete translate-issuance payload.
export function translationKey(office, id) {
    const o = String(office ?? '').toUpperCase();
    if (!OFFICE_RE.test(o) || typeof id !== 'string' || !ID_RE.test(id)) return null;
    return `ti:${TRANSLATION_KEY_VERSION}:${o}:${id}`;
}

// `cl:v2:LOX:<id>`: the changelog verdict for the pair whose CURRENT
// issuance is <id> (that issuance against its predecessor).
export function changelogKey(office, currentId) {
    const o = String(office ?? '').toUpperCase();
    if (!OFFICE_RE.test(o) || typeof currentId !== 'string' || !ID_RE.test(currentId)) return null;
    return `cl:${CHANGELOG_KEY_VERSION}:${o}:${currentId}`;
}

// `ed:v1:LOX`: the office's current edition and its predecessor.
export function editionKey(office) {
    const o = String(office ?? '').toUpperCase();
    return OFFICE_RE.test(o) ? `ed:${EDITION_KEY_VERSION}:${o}` : null;
}

// `poll:v1`: the poller's state (newest product seen per office) and its
// heartbeat (the time of the last successful poll).
export const pollStateKey = () => `poll:${POLL_KEY_VERSION}`;

// `lease:v1`: who is running the poller, until when.
export const leaseKey = () => `lease:${LEASE_KEY_VERSION}`;

// `mc:v1:2026-11-18`: the poller's model calls on one UTC day.
export function modelCallsKey(day) {
    return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? `mc:${COUNTER_KEY_VERSION}:${day}` : null;
}

// `ts:v1:LOX:<sha256 hex>`: one section's translation, keyed by a hash of
// everything the model's answer depends on (api/_store.js sectionHash).
export function sectionKey(office, hash) {
    const o = String(office ?? '').toUpperCase();
    if (!OFFICE_RE.test(o) || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
    return `ts:${SECTION_KEY_VERSION}:${o}:${hash}`;
}

// `lede:v2:<ISO instant>`: the National Desk's AI pieces for one SPC Day 1
// issuance. The instant is canonicalised so two spellings of the same
// issuance ("…+00:00" and "…Z") share one entry.
export function ledeKey(issued) {
    if (typeof issued !== 'string' || !issued) return null;
    const t = Date.parse(issued);
    if (!Number.isFinite(t)) return null;
    return `lede:${LEDE_KEY_VERSION}:${new Date(t).toISOString()}`;
}

// The Runtime Cache hashes keys with a 32-bit hash by default, and on the
// Hobby plan every project of a team shares one cache: a full-width hash and
// a namespace keep this project's entries from colliding with anything.
const hashKey = (key) => createHash('sha256').update(key).digest('hex');

let testBackend = null;
let runtimePromise = null;
let testPurge = null;
let functionsPromise = null;

// Test seam: an object with get(key) and set(key, value, options), or null to
// restore the default. It takes priority over the environment check. Reset
// it in afterEach: it is module state, shared by every test file in the run.
export function __setSharedCacheBackendForTests(backend) {
    testBackend = backend || null;
}

// Test seam for purgeTag: an object with invalidateByTag(tags) and
// dangerouslyDeleteByTag(tags), or null to restore the default.
export function __setPurgeBackendForTests(backend) {
    testPurge = backend || null;
}

function vercelFunctions() {
    if (!functionsPromise) {
        functionsPromise = import('@vercel/functions').catch((err) => {
            console.warn('shared-cache: @vercel/functions unavailable:', err?.message || err);
            return null;
        });
    }
    return functionsPromise;
}

async function backend() {
    if (testBackend) return testBackend;
    // Never call getCache() off Vercel: it would fall back to a process-wide
    // in-memory cache (and warn), which is exactly the hidden state this
    // module promises tests it will not have.
    if (!process.env.VERCEL) return null;
    if (!runtimePromise) {
        // Loaded lazily (like @vercel/blob in _snapshots.js) so a problem in
        // the package can never stop a page function from loading; the warning
        // makes an inert store visible in the runtime logs.
        runtimePromise = vercelFunctions()
            .then(m => (m ? m.getCache({ namespace: 'plaincast', keyHashFunction: hashKey }) : null))
            .catch((err) => {
                console.warn('shared-cache: runtime cache unavailable:', err?.message || err);
                return null;
            });
    }
    return runtimePromise;
}

// Resolves with the promise's value, or `fallback` on rejection or once `ms`
// has passed. Never rejects; a late rejection from the losing side is
// swallowed rather than left unhandled.
function settleWithin(promise, ms, fallback) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(fallback), ms);
        timer.unref?.();
        Promise.resolve(promise).then(
            (v) => { clearTimeout(timer); resolve(v); },
            () => { clearTimeout(timer); resolve(fallback); },
        );
    });
}

// The stored value, or null (miss, error, timeout, off Vercel, null key).
// The guard covers the first call's module load as well as the read.
export async function sharedGet(key) {
    if (typeof key !== 'string' || !key) return null;
    const read = (async () => {
        const b = await backend();
        return b ? b.get(key) : null;
    })();
    const value = await settleWithin(read, GET_TIMEOUT_MS, null);
    return value ?? null;
}

// Stores a JSON-serialisable value. `ttl` is in seconds. Entries are tagged
// with their family (`ti`, `cl`, `lede`) so one family can be expired from
// the dashboard without a deploy. Resolves when written, failed or timed out.
export async function sharedSet(key, value, { ttl, name } = {}) {
    if (typeof key !== 'string' || !key || value === undefined) return;
    const options = { tags: [key.split(':')[0]] };
    if (Number.isFinite(ttl) && ttl > 0) options.ttl = Math.floor(ttl);
    if (typeof name === 'string' && name) options.name = name;
    const write = (async () => {
        const b = await backend();
        if (b) await b.set(key, value, options);
    })();
    await settleWithin(write, SET_TIMEOUT_MS, undefined);
}

// ── The engine's I/O (api/_store.js, api/cron-refresh.js) ─────────────
// Unlike sharedGet/sharedSet, these REPORT the outcome: the poller must not
// read a timed-out lookup as "nothing stored" (that would refetch, rotate an
// edition wrongly, purge a page needlessly or read the day's model-call count
// as zero). They never throw either, and they never tag an item.

export const STORE_READ_TIMEOUT_MS = 250;   // a page render's critical path
export const STORE_WRITE_TIMEOUT_MS = 1500;
const FAILED = Symbol('failed');

// { ok: true, value } (value null for a miss) or { ok: false } for an
// error, a timeout, a null key, or no store (off Vercel).
export async function storeRead(key, { timeoutMs = STORE_READ_TIMEOUT_MS } = {}) {
    if (typeof key !== 'string' || !key) return { ok: false };
    const read = (async () => {
        const b = await backend();
        if (!b) return FAILED;
        return b.get(key);
    })();
    const value = await settleWithin(read, timeoutMs, FAILED);
    return value === FAILED ? { ok: false } : { ok: true, value: value ?? null };
}

// Stores a JSON-serialisable value, untagged. Resolves true once written;
// false on an error, a timeout or no store.
export async function storeWrite(key, value, { ttl, timeoutMs = STORE_WRITE_TIMEOUT_MS } = {}) {
    if (typeof key !== 'string' || !key || value === undefined) return false;
    const options = {};
    if (Number.isFinite(ttl) && ttl > 0) options.ttl = Math.floor(ttl);
    const write = (async () => {
        const b = await backend();
        if (!b) return false;
        await b.set(key, value, options);
        return true;
    })();
    return settleWithin(write, timeoutMs, false);
}

// Purge CDN responses by cache tag (and, per Vercel, Runtime Cache and data
// cache items with that tag: which is why the engine's items carry none).
// `hard` deletes (dangerouslyDeleteByTag); otherwise the entries are marked
// stale (invalidateByTag) and served once more while they regenerate.
// Resolves { ok: true } only when a purge API was there to call and
// resolved: @vercel/functions resolves silently without a request context,
// so its promise alone proves nothing. Never throws.
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
export const PURGE_TIMEOUT_MS = 5000;

export async function purgeTag(tags, { hard = false } = {}) {
    const list = (Array.isArray(tags) ? tags : [tags]).filter(t => typeof t === 'string' && t && !t.includes(','));
    if (list.length === 0) return { ok: false, reason: 'no-tags' };
    const attempt = (async () => {
        let api = testPurge;
        if (!api) {
            if (!process.env.VERCEL) return { ok: false, reason: 'off-vercel' };
            if (!globalThis[REQUEST_CONTEXT]?.get?.()?.purge) return { ok: false, reason: 'no-purge-context' };
            api = await vercelFunctions();
            if (!api) return { ok: false, reason: 'no-functions-package' };
        }
        await (hard ? api.dangerouslyDeleteByTag(list) : api.invalidateByTag(list));
        return { ok: true };
    })().catch(err => ({ ok: false, reason: String(err?.message || err).slice(0, 200) }));
    return settleWithin(attempt, PURGE_TIMEOUT_MS, { ok: false, reason: 'timeout' });
}
