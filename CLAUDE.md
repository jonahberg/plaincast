# Plaincast

## Project Structure
```
shadcn/            PRODUCTION FRONTEND: shadcn/ui + Vite + React SPA.
  index.html       The app shell — carries the TEMPLATE MARKERS that
                   scripts/build-offices.mjs and the SSR functions key on
                   (edit markers only with the generator, then regenerate)
  public/sw.js     The deployed /sw.js (takes over old registrations)
  src/lib/afd.js   Ported pure logic — parity-locked to docs/js/app.js by
                   tests/shadcn-parity.test.js
  dist/            Build output = Vercel outputDirectory (buildCommand runs
                   vite build + scripts/prepare-deploy.mjs, which deletes
                   dist/index.html and copies docs/ statics in)
docs/              LEGACY vanilla client (no longer deployed as the frontend)
                   + the canonical data modules and the deployed static
                   surface (copied into dist at build)
  js/app.js        Legacy app logic (still the parity source of truth)
  js/glossary.js   230+ term glossary (canonical, imported by shadcn/)
  js/offices.js    68 NWS office data (canonical)
  js/abbreviations.js  109 abbreviation patterns (canonical)
  js/diff.js       Forecast diff engine (canonical)
  sw.js            Legacy service worker (not deployed; /sw.js is shadcn's)
  manifest.json    PWA manifest
api/               Vercel serverless functions
  home.js          SSR homepage for /  (docs/index.html + live AFD digest)
  office-page.js   SSR /o/<CODE>/
  national-desk.js SSR /national/
  page.js          /about, /contact, /privacy, /developers (content in _pages.js)
  not-found.js     catch-all agent-friendly 404 (HTML + Markdown)
  api-not-found.js JSON 404 for unknown /api/* paths
  _errors.js       structured JSON errors (code + hint + docs)
  _negotiate.js    Accept-header content negotiation (HTML / Markdown / 406)
  _edition-markdown.js  Markdown twin of an edition
  translate.js     AI translation (AI Gateway + Claude)
  feed.js          RSS per office
  og.js            Dynamic OG images
  conditions.js    Current weather + averages
docs/openapi.json  OpenAPI 3.1 spec (lint: bunx @redocly/cli lint docs/openapi.json)
tests/             Bun test suite (598 tests)
```

## Routing rule
`vercel.json` rewrites are evaluated AFTER `handle: filesystem`, so any static
file at a path shadows a rewrite to that path. That is why
`scripts/prepare-deploy.mjs` DELETES `shadcn/dist/index.html` from the build
output (else it shadows the `/` → api/home.js rewrite), and why the functions
read the shell from the committed `api/_home-shell.html` twin (generated from
`shadcn/index.html` by `scripts/build-offices.mjs`) via
`functions.*.includeFiles`. The 404 catch-all must stay LAST in the
`rewrites` array, and the `/api/:path*` → `/api/api-not-found` rewrite must
stay BEFORE it — otherwise `/api/bogus` serves an HTML page to an agent
probing the API.

## Heading rule
Every page needs an `<h1>` inside `<main>`, not only the masthead nameplate.
Main-content extractors strip `<header>` as boilerplate, so a page whose only
H1 lives there reads as having no heading. `tests/agent-readiness.test.js`
reproduces that stripping and fails if the main H1 goes away.

## API error rule
Every `/api/*` failure goes through `sendError` in `api/_errors.js`. `error`
stays a human string (unchanged contract); `code`, `hint` and `docs` are
siblings. Codes are a contract — add, never repurpose. `api/explain-alert.js`
has its own local `sendError(res, e)`, so it imports the shared one as
`sendJsonError`.

## Content negotiation
Every HTML-serving function goes through `api/_negotiate.js`. Never `res.send()`
an HTML body from one of them directly: with two representations behind one URL,
a response missing `Vary: Accept` poisons the edge cache. The published
acceptmarkdown.com test vectors live in `tests/negotiate.test.js`.

## Commands
- `bun test tests/` — run all tests
- `cd docs && python3 -m http.server 8765` — local dev. Note: `/` serves the
  static shell with an empty `#sections`; the SSR digest, the trust pages and
  Markdown negotiation are functions, so they need `vercel dev`.

## Release rule
The deployed service worker is shadcn/public/sw.js. Any PR that changes the
frontend (shadcn/src, shadcn/index.html, or the docs/ statics copied into the
deploy) MUST bump its CACHE const. Its asset strategy is network-first (the
built asset names are STABLE, not hashed — the committed SSR shell references
them), so stale-code risk is lower than the old cache-first worker, but the
cache namespace still needs the bump to shed old entries. The old rule (bump
CACHE_NAME in docs/sw.js on docs/ changes) still applies while the legacy
client stays committed.

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
