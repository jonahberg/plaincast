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
export const TRANSLATION_KEY_VERSION = 'v1'; // api/translate-issuance.js (+ translate.js prompt/sanitizer)
export const CHANGELOG_KEY_VERSION = 'v1';   // api/changelog.js
export const LEDE_KEY_VERSION = 'v1';        // api/national-lede.js

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

// `ti:v1:LOX:<id>`: a complete translate-issuance payload.
export function translationKey(office, id) {
    const o = String(office ?? '').toUpperCase();
    if (!OFFICE_RE.test(o) || typeof id !== 'string' || !ID_RE.test(id)) return null;
    return `ti:${TRANSLATION_KEY_VERSION}:${o}:${id}`;
}

// `cl:v1:LOX:<id>`: the changelog verdict for the pair whose CURRENT
// issuance is <id> (that issuance against its predecessor).
export function changelogKey(office, currentId) {
    const o = String(office ?? '').toUpperCase();
    if (!OFFICE_RE.test(o) || typeof currentId !== 'string' || !ID_RE.test(currentId)) return null;
    return `cl:${CHANGELOG_KEY_VERSION}:${o}:${currentId}`;
}

// `lede:v1:<ISO instant>`: the National Desk's AI pieces for one SPC Day 1
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

// Test seam: an object with get(key) and set(key, value, options), or null to
// restore the default. It takes priority over the environment check. Reset
// it in afterEach: it is module state, shared by every test file in the run.
export function __setSharedCacheBackendForTests(backend) {
    testBackend = backend || null;
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
        runtimePromise = import('@vercel/functions')
            .then(m => m.getCache({ namespace: 'plaincast', keyHashFunction: hashKey }))
            .catch((err) => {
                console.warn('shared-cache: @vercel/functions unavailable:', err?.message || err);
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
