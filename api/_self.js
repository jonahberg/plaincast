// Same-site JSON fetch for the server-rendered pages (api/home.js,
// api/office-page.js, api/national-desk.js) that embed an AI result the CDN
// already holds, so the reader gets the final text in the first response
// instead of watching the page swap it in.
//
// Rules this helper enforces:
//   - The origin is never taken from request headers (no Host spoofing): it is
//     the production domain in production, the deployment URL elsewhere.
//   - Only /api/ paths.
//   - A short timeout, and it NEVER throws: null means "not available right
//     now", and every caller must render without it (the client fetches the
//     same endpoint as a fallback).
//   - Local dev and tests have no VERCEL_* env, so it returns null without
//     touching the network.
const PROD_ORIGIN = 'https://plaincast.live';

export function selfOrigin() {
    if (process.env.VERCEL_ENV === 'production') return PROD_ORIGIN;
    if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
    return null;
}

// "Peek" marks a request that must only READ what already exists. A page
// render is triggered by crawlers as well as readers, so it must never start a
// model run: on a CDN hit the header is irrelevant (the cached answer comes
// back), and on a miss the endpoint sees it and declines with a `no-store`
// non-answer instead of generating. A reader's own browser request (no header)
// is what pays for a translation, exactly as before these pages embedded one.
export const PEEK_HEADER = 'x-plaincast-peek';
export const isPeek = (req) => req?.headers?.[PEEK_HEADER] === '1';

export async function fetchSelfJson(path, { timeoutMs = 400, peek = false } = {}) {
    const origin = selfOrigin();
    if (!origin || typeof path !== 'string' || !path.startsWith('/api/')) return null;
    try {
        const headers = { accept: 'application/json' };
        if (peek) headers[PEEK_HEADER] = '1';
        // Preview deployments sit behind Deployment Protection; Vercel exposes
        // this secret to the function when automation bypass is enabled.
        const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
        if (bypass && process.env.VERCEL_ENV !== 'production') {
            headers['x-vercel-protection-bypass'] = bypass;
        }
        const res = await fetch(origin + path, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}
