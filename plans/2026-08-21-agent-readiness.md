# Agent readiness — Is Agentic 73/100 → fixes

Five findings from the Ora audit of https://plaincast.live, in priority order.

## 1. Content without JavaScript (Essential, Partial)
`/` is a static `docs/index.html` whose `#sections` is an empty shell — every word of
forecast content arrives from `api.weather.gov` client-side, and that origin's robots.txt
disallows crawlers. Fix: route `/` through `api/home.js`, which server-renders a digest of
the current AFD into `#sections` exactly the way `api/office-page.js` already does for
`/o/<CODE>/`, plus a standfirst that says what Plaincast is in prose.

Routing note: `vercel.json` rewrites are evaluated AFTER `handle: filesystem`, so a
deployed `docs/index.html` shadows any `/` rewrite. `docs/index.html` therefore joins
`docs/o` in `.vercelignore` (it stays in the repo, still reaches the functions through
`includeFiles`, and remains the local-dev + generator source of truth).

TRADE-OFF, deliberate: the homepage loses its static-file floor. The handler degrades to
the exact `docs/index.html` bytes on ANY internal error, but a failure of lambda
invocation itself has no static net. Same trade already accepted for `/o/` and `/national/`.

## 2. Agent-friendly 404s (Essential, Partial)
Nonexistent paths already return a real 404 — but Vercel's default plain-text body.
Fix: a catch-all rewrite (LAST, after every other rewrite) to `api/not-found.js`, which
returns 404 with a short markdown body pointing at `/`, `/national/`, `/llms.txt`,
`/sitemap.xml` and an example office page. Negotiates HTML too. `s-maxage` on the
response so a garbage-path flood is absorbed by the CDN rather than billed as invocations.

## 3. Markdown content negotiation (Essential, Failed)
Nothing on the site negotiates. Fix: `api/_negotiate.js` — an RFC 9110 Accept parser
(q-values, specificity tie-break, `q=0`), used by every HTML-serving function.
- `Accept: text/markdown` → `text/markdown; charset=utf-8`
- no Accept / `*/*` / browser headers → HTML (unchanged)
- nothing acceptable → `406` with a plain-text list of representations, `no-store`
- `Vary: Accept, Accept-Encoding` on EVERY response path of a negotiating handler,
  including the fallbacks — the moment one URL has two bodies, a missing `Vary` is
  edge-cache poisoning.
Covered: `/`, `/o/<CODE>/`, `/national/`, `/about`, `/contact`, `/privacy`, and 404s.

## 4. Agent instruction / when-to-use (Recommended, Failed)
Add a `## When to use Plaincast` section to `docs/llms.txt`: the concrete jobs it is right
for, the jobs it is wrong for, and the exact call patterns (URL shapes, RSS, Accept header).

## 5. Trust anchor pages (Recommended, Failed)
`/about`, `/contact`, `/privacy` — 500+ chars each, real content. One `api/page.js`
handler renders them from `api/_pages.js` into `api/_page-shell.html`, so HTML and
Markdown come from one source. Added to `sitemap.xml`.

## Verification
Preview deploy, then the acceptmarkdown matrix (markdown 200 + content-type + Vary;
no-Accept → HTML; `q=0` → HTML; `application/pdf` → 406) on `/` and `/o/OKX/`, plus
per-variant `x-vercel-cache: HIT` after warmup to prove Vary really splits the edge cache.
