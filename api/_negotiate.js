// Accept-header content negotiation, per acceptmarkdown.com / RFC 9110 §12.5.1.
//
// WHY THIS EXISTS: agent clients ask for `Accept: text/markdown` so they can
// read prose instead of DOM. Every Plaincast page that serves HTML from a
// function routes its response through here so one URL can serve two
// representations without a substring match — `accept.includes('text/markdown')`
// happens to work, but the mirror-image bug (matching a real Chrome header into
// the Markdown branch) is exactly what a real parser prevents.
//
// Files prefixed with `_` are not treated as endpoints by Vercel, so this
// module is server-only.
//
// THE CACHE CONTRACT: the moment one URL has two bodies, a response without
// `Vary: Accept` is edge-cache poisoning — the CDN will hand an agent the HTML
// variant, or a browser the Markdown one, depending only on who asked first.
// `sendNegotiated`/`send406` therefore set Vary on EVERY path, including the
// fail-safe fallbacks. Never `res.send()` an HTML page from a negotiating
// handler without going through here.

export const HTML = 'text/html';
export const MARKDOWN = 'text/markdown';

// Vercel compresses at the edge, so Accept-Encoding is already part of the
// real cache key; listing it keeps the header honest for any other cache.
export const VARY = 'Accept, Accept-Encoding';

// One entry of a parsed Accept header.
// `specificity`: 2 = fully specified (text/markdown), 1 = subtype wildcard
// (text/*), 0 = catch-all (*/*). Used only to break q-value ties.
function parseEntry(raw, index) {
    const parts = String(raw).split(';');
    const media = parts.shift().trim().toLowerCase();
    if (!media) return null;
    const slash = media.indexOf('/');
    if (slash < 0) return null;
    const type = media.slice(0, slash);
    const subtype = media.slice(slash + 1);
    if (!type || !subtype) return null;

    let q = 1;
    for (const param of parts) {
        const eq = param.indexOf('=');
        if (eq < 0) continue;
        if (param.slice(0, eq).trim().toLowerCase() !== 'q') continue;
        // A malformed q is treated as absent (q=1), per RFC 9110's tolerance.
        const n = Number.parseFloat(param.slice(eq + 1).trim());
        if (Number.isFinite(n)) q = Math.min(Math.max(n, 0), 1);
    }

    const specificity = type === '*' ? 0 : (subtype === '*' ? 1 : 2);
    return { type, subtype, q, specificity, index };
}

// Accept header → entries in header order. Malformed entries are dropped, not
// fatal: a broken Accept must never take a page down.
export function parseAccept(header) {
    if (typeof header !== 'string') return [];
    return header.split(',').map(parseEntry).filter(Boolean);
}

// Best q-value this Accept header assigns to one media type. Ties between a
// wildcard and an exact match go to the exact match (RFC 9110 specificity),
// which is what makes `text/markdown;q=0, */*` resolve to "not markdown".
function scoreFor(entries, mediaType) {
    const slash = mediaType.indexOf('/');
    const type = mediaType.slice(0, slash);
    const subtype = mediaType.slice(slash + 1);
    let best = null;
    for (const e of entries) {
        const matches = (e.type === '*' && e.subtype === '*')
            || (e.type === type && e.subtype === '*')
            || (e.type === type && e.subtype === subtype);
        if (!matches) continue;
        if (!best || e.specificity > best.specificity) best = e;
    }
    return best ? best.q : 0;
}

// Pick a representation. `offered` is most-preferred-first — put the default
// (HTML) first, so a client with no opinion (`*/*`, no header, a browser
// header that catch-alls everything at the same q) gets the default.
//
// Returns the chosen media type, or null when nothing is acceptable → 406.
// A missing or empty Accept means "no constraint", NOT "nothing works".
export function selectRepresentation(header, offered = [HTML, MARKDOWN]) {
    const entries = parseAccept(header);
    if (entries.length === 0) return offered[0] || null;

    let winner = null;
    let winningScore = 0;
    for (const mediaType of offered) {
        const score = scoreFor(entries, mediaType);
        // Strictly greater: ties fall to the earlier (more preferred) offer.
        if (score > winningScore) {
            winningScore = score;
            winner = mediaType;
        }
    }
    return winner; // null when every offer scored 0 (absent or q=0)
}

export const wantsMarkdown = (header, offered) =>
    selectRepresentation(header, offered) === MARKDOWN;

// Accept lives in a header, and Node lowercases incoming header names.
export const acceptHeader = (req) => req?.headers?.accept ?? req?.headers?.Accept ?? '';

// Add `Accept` to Vary without clobbering anything a caller already set.
export function setVary(res, extra = VARY) {
    const existing = res.getHeader ? res.getHeader('Vary') : null;
    if (!existing) { res.setHeader('Vary', extra); return; }
    const have = new Set(String(existing).split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
    const merged = String(existing).split(',').map(s => s.trim()).filter(Boolean);
    for (const token of extra.split(',').map(s => s.trim())) {
        if (!have.has(token.toLowerCase())) merged.push(token);
    }
    res.setHeader('Vary', merged.join(', '));
}

// 406 Not Acceptable. RFC 9110 recommends listing the representations the
// client could ask for instead, so it can retry without guessing.
// Never cached: the same URL is a 200 for the very next client.
export function send406(res, offered = [HTML, MARKDOWN], requested = '') {
    setVary(res);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const asked = String(requested || '').trim();
    const body = `This resource is available in:\n${offered.map(t => `- ${t}`).join('\n')}\n`
        + (asked ? `\nYou requested: ${asked}\n` : '');
    return res.status(406).send(body);
}

// The one exit every negotiating handler should use for a successful response.
// `bodies` maps a media type to its body (string) — omit a type to not offer it.
export function sendNegotiated(req, res, bodies, { status = 200, cacheControl } = {}) {
    const offered = Object.keys(bodies);
    const header = acceptHeader(req);
    const chosen = selectRepresentation(header, offered);
    if (!chosen) return send406(res, offered, header);

    setVary(res);
    res.setHeader('Content-Type', `${chosen}; charset=utf-8`);
    if (cacheControl) res.setHeader('Cache-Control', cacheControl);
    return res.status(status).send(bodies[chosen]);
}
