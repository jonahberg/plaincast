// Shared guards for the GET endpoints that spend AI on a cache miss
// (changelog, translate-issuance, explain-alert, national-lede).
//
// 1) Query-param allowlist. The CDN keys on the full URL, so ?office=LOX&x=1,
//    &x=2, ... were each a CDN miss that reached the function — a free
//    cache-bust lever in front of a model call. Unknown params now 400.
//    Vercel rewrite captures arrive as query params too, so each endpoint's
//    allowlist must include them. `path` is allowed defensively: the
//    `/api/:path*` → `/api/:path*` rewrite in vercel.json consumes the capture
//    in its destination (so Vercel should not append it), but a false 400 on
//    every API call would be far worse than one extra accepted name, and the
//    in-memory caches here key on office/id, never on `path`.
//
// 2) A per-instance global cap on cold (uncached) model calls per minute, the
//    same idea as /api/translate's degraded-mode budget: per-IP limits don't
//    stop a rotating-IP caller from turning every cold key into a billed call.
//
// Files prefixed with `_` are not treated as endpoints by Vercel.
import { sendError } from './_errors.js';

const ALWAYS_ALLOWED = ['path'];

// Returns true (and has sent the 400) when the query carries an unknown key.
export function rejectUnknownParams(req, res, allowed) {
    const q = req.query && typeof req.query === 'object' ? req.query : {};
    const ok = new Set([...allowed, ...ALWAYS_ALLOWED]);
    const unknown = Object.keys(q).filter(k => !ok.has(k));
    if (unknown.length === 0) return false;
    sendError(res, 400, 'unknown_param', `Unknown query parameter: ${unknown.slice(0, 5).join(', ')}`, {
        allowed: [...allowed],
    });
    return true;
}

// Fixed-window budget, one per endpoint module instance.
export function createColdBudget(maxPerMinute, windowMs = 60 * 1000) {
    let windowStart = 0;
    let used = 0;
    return {
        // Charge `cost` model calls; false when that would exceed the budget.
        take(cost = 1) {
            const now = Date.now();
            if (now - windowStart > windowMs) { windowStart = now; used = 0; }
            if (used + cost > maxPerMinute) return false;
            used += cost;
            return true;
        },
        reset() { windowStart = 0; used = 0; },
    };
}

// The error a cold path throws when the budget is spent; handlers route any
// error carrying `code` through sendError before their soft-fail branches.
export function overCapacityError() {
    return Object.assign(new Error('over capacity'), {
        statusCode: 503,
        code: 'over_capacity',
        publicMessage: 'Service is busy. Please try again shortly.',
    });
}

export function sendOverCapacity(res, err) {
    res.setHeader('Retry-After', '60');
    res.setHeader('Cache-Control', 'no-store');
    return sendError(res, err.statusCode, err.code, err.publicMessage);
}
