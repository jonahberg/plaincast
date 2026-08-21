# Plaincast

## Project Structure
```
docs/              Static frontend (served as outputDirectory)
  index.html       Markup (~360 loc)
  styles.css       All CSS
  js/app.js        Main app logic
  js/glossary.js   230+ term glossary
  js/offices.js    68 NWS office data
  js/abbreviations.js  109 abbreviation patterns
  js/diff.js       Forecast diff engine
  sw.js            Service worker
  manifest.json    PWA manifest
api/               Vercel serverless functions
  home.js          SSR homepage for /  (docs/index.html + live AFD digest)
  office-page.js   SSR /o/<CODE>/
  national-desk.js SSR /national/
  page.js          /about, /contact, /privacy (content in _pages.js)
  not-found.js     catch-all agent-friendly 404
  _negotiate.js    Accept-header content negotiation (HTML / Markdown / 406)
  _edition-markdown.js  Markdown twin of an edition
  translate.js     AI translation (AI Gateway + Claude)
  feed.js          RSS per office
  og.js            Dynamic OG images
  conditions.js    Current weather + averages
tests/             Bun test suite (559 tests)
```

## Routing rule
`vercel.json` rewrites are evaluated AFTER `handle: filesystem`, so any static
file at a path shadows a rewrite to that path. `docs/index.html` and `docs/o`
are therefore in `.vercelignore` — they stay committed (local dev, generators,
tests) and reach the functions via `functions.*.includeFiles`. The 404
catch-all must stay LAST in the `rewrites` array.

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
Any PR that changes files under docs/ MUST bump CACHE_NAME in docs/sw.js —
the service worker precaches the app shell cache-first, and a stale version
serves new HTML with old CSS/JS to returning clients.

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
