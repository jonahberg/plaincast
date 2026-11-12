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

export async function fetchSelfJson(path, { timeoutMs = 400 } = {}) {
    const origin = selfOrigin();
    if (!origin || typeof path !== 'string' || !path.startsWith('/api/')) return null;
    try {
        const headers = { accept: 'application/json' };
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
