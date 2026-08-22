// Structured JSON errors for every /api/* endpoint.
//
// WHY THIS EXISTS: the handlers already answered with JSON, but the body was a
// bare `{"error": "Invalid office"}` — a human sentence with nothing an agent
// can branch on. An agent that gets it back knows something failed and nothing
// about what to do next. Every error now also carries a stable machine code, a
// resolution hint naming the fix, and a docs URL.
//
// ADDITIVE ON PURPOSE: `error` keeps the exact string it has today. docs/js/app.js
// only ever checks `res.ok` (verified — it never reads the body of a failed
// response), so nothing in the frontend depends on this shape; the fields are
// added as siblings anyway, so any third party that parsed `error` yesterday
// still works today. Never nest `error` into an object.
//
// Files prefixed with `_` are not treated as endpoints by Vercel.

export const DOCS_URL = 'https://plaincast.live/developers';
export const SPEC_URL = 'https://plaincast.live/openapi.json';

// Stable, lowercase_snake machine codes. These are a contract: rename one and
// an agent's branch on it silently stops matching. Add, never repurpose.
export const CODES = {
    invalid_office: 'The office code is missing or is not one of the 68 Plaincast covers.',
    invalid_id: 'The id parameter is missing or malformed.',
    invalid_request: 'The request body or query string could not be parsed.',
    method_not_allowed: 'This endpoint does not accept that HTTP method.',
    not_found: 'No endpoint exists at this path.',
    rate_limited: 'Too many requests from this client.',
    upstream_error: 'A National Weather Service upstream call failed.',
    timeout: 'The request took too long and was abandoned.',
    internal_error: 'Something failed on our side.',
    forbidden: 'The request was understood but refused.',
};

const OFFICE_HINT = 'Pass ?office=<CODE> with a 3-letter NWS office code, e.g. ?office=LOX. '
    + 'All 68 codes are listed at https://plaincast.live/llms.txt';

// Default hints per code. A caller may override with a more specific one.
const HINTS = {
    invalid_office: OFFICE_HINT,
    invalid_id: 'Check the id against the one returned by the endpoint that issued it.',
    invalid_request: `See the request schema at ${SPEC_URL}`,
    method_not_allowed: `See the allowed methods for this path at ${SPEC_URL}`,
    not_found: `See the list of available endpoints at ${SPEC_URL}`,
    rate_limited: 'Wait 60 seconds and retry. Plaincast needs no API key; the limit is per IP.',
    upstream_error: 'This is upstream at api.weather.gov, not Plaincast. Retry shortly.',
    timeout: 'Retry once. If it persists, the upstream is degraded.',
    internal_error: `If this persists, report it at ${DOCS_URL}`,
    forbidden: `See the endpoint's stated contract at ${SPEC_URL}`,
};

// Build the body without sending it — used by handlers that need to merge extra
// fields, and by the tests.
export function errorBody(code, message, { hint, ...extra } = {}) {
    const known = Object.prototype.hasOwnProperty.call(CODES, code);
    const safeCode = known ? code : 'internal_error';
    return {
        // `error` stays a human-readable string: unchanged from today.
        error: message || CODES[safeCode],
        code: safeCode,
        hint: hint || HINTS[safeCode],
        docs: DOCS_URL,
        ...extra,
    };
}

// The one exit for an /api/* failure. Always JSON, always the same shape.
export function sendError(res, status, code, message, opts = {}) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // An error is about THIS request; never let a CDN pin it to the URL.
    if (!res.getHeader?.('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json(errorBody(code, message, opts));
}
