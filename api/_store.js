// The edition store: what the scheduled poller (api/cron-refresh.js) keeps
// about every office's AFD, and the one read the page functions make to
// render from it instead of calling api.weather.gov.
//
// Built on api/_shared-cache.js (the Vercel Runtime Cache): per region,
// shared by every function of the project, separate for preview and
// production, survives deploys, LRU-evicted. It is treated as a cache that
// can lose anything at any time, never as a database: every reader falls
// back to the live NWS path on a miss, a failure or any doubt.
//
// Two families, both untagged (a CDN purge by tag would delete tagged items):
//
//   poll:v1      the poller's state. `at` is the HEARTBEAT: the time of the
//                last successful poll. `offices[CODE]` is the newest product
//                the listing showed for that office ({ id, issuanceTime,
//                prevId }) plus the poller's bookkeeping for it.
//   ed:v1:CODE   { v, office, current: { id, issuanceTime, productText,
//                storedAt, prevId }, previous: { id, issuanceTime,
//                productText } | null }
//
// A page renders from the store only when ALL of these hold; otherwise it
// takes the live path, unchanged:
//   - PLAINCAST_STORE_RENDER=1 (read per request);
//   - the heartbeat is at most HEARTBEAT_FRESH_MS (10 min) old;
//   - the newest product the listing showed for the office IS the stored
//     current edition (a new issuance the poller has seen but not yet
//     fetched, for a 403, a cap or a timeout, makes the office live);
//   - no tie between two products with the same issuance time;
//   - the poller's hard purge of the office's pages succeeded for this
//     edition (a purge that cannot happen keeps the office live).
// A forecast held past its issuance is the worst failure this design can
// have, so every doubt resolves to the live path.
//
// Files prefixed with `_` are not treated as endpoints by Vercel.
import { OFFICE_NAMES, officeCodeFromIssuing } from '../docs/js/offices.js';
import { editionKey, pollStateKey, storeRead } from './_shared-cache.js';

// ── Switches (environment, read per request; all default OFF) ─────────
export const STORE_RENDER = 'PLAINCAST_STORE_RENDER';
export const PRETRANSLATE = 'PLAINCAST_PRETRANSLATE';
export const AI_FOR_AGENTS = 'PLAINCAST_AI_FOR_AGENTS';

export function switchOn(name) {
    return process.env[name] === '1';
}

// ── Offices ──────────────────────────────────────────────────────────
// "All offices" is OFFICE_NAMES, never a list or a count kept here.
export function allOffices() {
    return Object.keys(OFFICE_NAMES);
}

// The product listing names the issuing office by its 4-letter ICAO id
// ("KOTX"); the site uses the 3-letter code. Standard ids drop the leading
// K; outside the contiguous US the id is not the code plus a prefix.
// The mapping is the canonical one in docs/js/offices.js, generated from
// real NWS product data (scripts/fetch-office-data.mjs).
export function officeFromIssuing(issuingOffice) {
    return officeCodeFromIssuing(issuingOffice);
}

// ── CDN cache tags ───────────────────────────────────────────────────
// Every page response that shows an office's edition carries that office's
// tag (the homepage also carries `home`), so the poller can purge them all.
// Kept disjoint from the shared-cache family tags (`ti`, `cl`, `lede`):
// purging a page must never delete a stored AI result.
export const HOME_TAG = 'home';
export function officeTag(code) {
    return `office-${code}`;
}

// ── Freshness ────────────────────────────────────────────────────────
// STALENESS INVARIANT: HEARTBEAT_FRESH_MS + the store page's s-maxage
// (api/office-page.js STORE_CACHE) <= 15 minutes, the live path's bound. A
// poll at 12:00 that misses a 12:02 issuance can still render the old
// edition until 12:10, and that copy may be cached until 12:15.
export const HEARTBEAT_FRESH_MS = 10 * 60 * 1000;

export function heartbeatFresh(at, now = Date.now()) {
    const t = Date.parse(at);
    return Number.isFinite(t) && t <= now + 60 * 1000 && now - t <= HEARTBEAT_FRESH_MS;
}

const ID_RE = /^[\w.:-]{1,64}$/;
const validId = (id) => typeof id === 'string' && ID_RE.test(id);
const validText = (t) => typeof t === 'string' && t.length > 0;

export const STATE_VERSION = 1;
export const EDITION_VERSION = 1;

export function emptyState() {
    return { v: STATE_VERSION, at: null, fullAt: null, offices: {} };
}

// A stored state, or null when it is not one this code wrote.
export function validState(state) {
    if (!state || typeof state !== 'object' || state.v !== STATE_VERSION) return null;
    if (!state.offices || typeof state.offices !== 'object' || Array.isArray(state.offices)) return null;
    return state;
}

// A stored edition record for `office`, or null.
export function validEdition(rec, office) {
    if (!rec || typeof rec !== 'object' || rec.v !== EDITION_VERSION || rec.office !== office) return null;
    const c = rec.current;
    if (!c || !validId(c.id) || !validText(c.productText) || typeof c.issuanceTime !== 'string') return null;
    return rec;
}

// The one read a page makes. Two store reads in parallel (state + edition),
// each bounded by the store's read timeout. Resolves with
// { current: { id, issuanceTime, productText }, previous } when the store
// may be rendered from, or null (take the live path). `previous` is the
// current edition's predecessor per the NWS listing, or null when the store
// does not hold exactly that product. Never throws.
export async function readRenderableEdition(office, { now = Date.now() } = {}) {
    try {
        const [st, ed] = await Promise.all([storeRead(pollStateKey()), storeRead(editionKey(office))]);
        if (!st.ok || !ed.ok) return null;
        const state = validState(st.value);
        if (!state || !heartbeatFresh(state.at, now)) return null;
        const seen = state.offices[office];
        if (!seen || seen.tie || !validId(seen.id)) return null;
        // Only once the CDN copies of the previous edition were hard-deleted
        // for THIS edition: if the purge API is unavailable, the office stays
        // on the live path and its short cache windows, as before the engine.
        if (seen.purge?.id !== seen.id) return null;
        const rec = validEdition(ed.value, office);
        if (!rec || rec.current.id !== seen.id) return null;
        const p = rec.previous;
        const previous = p && validId(p.id) && validText(p.productText)
            && seen.prevId && p.id === seen.prevId && rec.current.prevId === seen.prevId
            ? { id: p.id, issuanceTime: typeof p.issuanceTime === 'string' ? p.issuanceTime : null, productText: p.productText }
            : null;
        const c = rec.current;
        return { current: { id: c.id, issuanceTime: c.issuanceTime, productText: c.productText }, previous };
    } catch (err) {
        console.warn('store: render read failed:', err?.message || err);
        return null;
    }
}

// ── Listing → state (pure) ───────────────────────────────────────────
const time = (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : -Infinity;
};

// Listing items grouped by known office code, newest first. Items for
// offices outside OFFICE_NAMES, or without an id or a time, are dropped.
export function groupByOffice(items) {
    const groups = new Map();
    for (const it of Array.isArray(items) ? items : []) {
        const code = officeFromIssuing(it?.issuingOffice);
        if (!code || !OFFICE_NAMES[code]) continue;
        const id = it?.id;
        if (!validId(id) || !Number.isFinite(Date.parse(it?.issuanceTime))) continue;
        if (!groups.has(code)) groups.set(code, []);
        groups.get(code).push({ id, issuanceTime: it.issuanceTime });
    }
    for (const g of groups.values()) g.sort((a, b) => time(b.issuanceTime) - time(a.issuanceTime));
    return groups;
}

// Merge one listing into the state. Returns the offices whose edition
// changed (each one is fetched and its pages hard-purged by the poller).
//
//   - Never moves an office backward: a product issued earlier than the one
//     already known is ignored, in either mode (the 7-day list can lag the
//     incremental listing by minutes).
//   - Twins: NWS can list two products with the same issuance time (a
//     correction keeps the original's time). Which one its per-office list
//     shows first is not ours to guess, so the office is marked `tie` and
//     renders live until a newer issuance arrives; and a product id not seen
//     before at that time counts as a NEW edition (the office's id moves to
//     it), so the cached pages of the superseded text are purged. Detection
//     does not depend on listing order: every product at the newest time is
//     compared with every product already seen at that time (`tieIds`).
//   - The full list (`full`) also corrects the predecessor of the product
//     already known.
// The office's bookkeeping (stored, purge, ...) survives; the poller
// compares it against the new id.
export function mergeListing(state, items, { full = false } = {}) {
    const changed = [];
    for (const [code, g] of groupByOffice(items)) {
        const prior = state.offices[code] || {};
        const T = time(g[0].issuanceTime);
        const priorT = prior.id ? time(prior.issuanceTime) : -Infinity;
        if (prior.id && T < priorT) continue; // a lagging listing
        const twinIds = g.filter(x => time(x.issuanceTime) === T).map(x => x.id).sort();
        const older = g.find(x => time(x.issuanceTime) < T) || null;
        const sameTime = Boolean(prior.id) && T === priorT;
        const known = new Set(sameTime ? [prior.id, ...(Array.isArray(prior.tieIds) ? prior.tieIds : [])] : []);
        const fresh = twinIds.filter(id => !known.has(id));
        let id;
        let prevId;
        if (sameTime) {
            if (fresh.length === 0 && !full) continue; // nothing new
            id = fresh.length ? fresh[fresh.length - 1] : prior.id;
            prevId = older ? older.id : (prior.prevId ?? null);
        } else {
            id = twinIds[twinIds.length - 1];
            // The next product down the listing, or (when an incremental
            // window holds only the new one) the product we knew.
            prevId = older ? older.id : (prior.id ?? null);
        }
        const seenAtT = [...new Set([...known, ...twinIds])].sort();
        const tie = seenAtT.length > 1;
        const next = {
            id,
            issuanceTime: sameTime ? prior.issuanceTime : g.find(x => x.id === id).issuanceTime,
            prevId,
        };
        const sameTieIds = JSON.stringify(tie ? seenAtT : undefined) === JSON.stringify(prior.tieIds);
        if (prior.id === next.id && prior.prevId === next.prevId && Boolean(prior.tie) === tie && sameTieIds) continue;
        if (prior.id !== next.id) changed.push(code);
        const merged = { ...prior, ...next };
        if (tie) {
            merged.tie = true;
            merged.tieIds = seenAtT;
        } else {
            delete merged.tie;
            delete merged.tieIds;
        }
        state.offices[code] = merged;
    }
    return changed;
}
