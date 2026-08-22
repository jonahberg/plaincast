// Vercel serverless function: the JSON 404 for unknown /api/* paths.
//
// WHY THIS EXISTS: /api/bogus used to fall through to api/not-found.js and
// return an HTML page — a regression introduced by the sitewide catch-all
// rewrite. An agent probing the API surface got a broadsheet. This returns the
// same honest 404 as structured JSON, with the endpoint list an agent needs to
// correct itself.
//
// ROUTING: `/api/:path*` rewrites here, immediately AFTER the existing
// self-rewrite. The self-rewrite carries `check: true`, so a path that resolves
// to a real function wins and only a MISS falls through to this one. The bare
// `/api` and `/api/` forms are routed explicitly — the compiled `:path*`
// pattern does not match them.
//
// Deliberately NOT content-negotiated: this is an API surface, so it is JSON
// for everyone. The HTML/Markdown 404 at api/not-found.js still serves pages.

import { sendError, SPEC_URL } from './_errors.js';

// Cacheable: a flood against one bad path should cost one invocation, not one
// per request. Short enough that a newly added endpoint is not shadowed for long.
const CACHE = 'public, s-maxage=300, stale-while-revalidate=3600';

// The read-only endpoints a third party may call. The AI-backed endpoints
// (translate, translate-issuance, changelog, explain-alert, national-lede) are
// deliberately absent: they are this site's own backend, they spend model
// budget per call, and they are rate-limited per IP. See /developers.
export const PUBLIC_ENDPOINTS = [
    'GET /api/feed?office=<CODE>',
    'GET /api/conditions?office=<CODE>',
    'GET /api/og?office=<CODE>',
    'GET /api/whereami',
];

export default async function handler(req, res) {
    res.setHeader('Cache-Control', CACHE);
    return sendError(
        res, 404, 'not_found',
        'No such endpoint.',
        {
            hint: `See ${SPEC_URL} for the full API surface. Most Plaincast content is `
                + 'served as pages, not endpoints: request any page URL with '
                + '`Accept: text/markdown` to get it as prose.',
            endpoints: PUBLIC_ENDPOINTS,
            spec: SPEC_URL,
        },
    );
}
