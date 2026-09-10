# Plaincast — shadcn/ui edition

**The production frontend of plaincast.live** — a React rebuild with
[shadcn/ui](https://ui.shadcn.com), Vite, and Tailwind CSS v4: the stock shadcn look (default neutral theme, system font
stack, cards and tabs), not the editorial "Dispatch" design system from
DESIGN.md — that redo was explicitly requested.

## Features

- **AI translation**, wired to the deployed site's functions: one CDN-cached
  `/api/translate-issuance` GET covers every section, with the per-section
  `/api/translate` POST as fallback, upgraded lazily as cards scroll into view
  (IntersectionObserver), credited "via Claude" only once its text is on
  screen. Off-platform (standalone dev) everything soft-fails to the instant
  regex translation.
- **Edition history**: an editions selector (latest 10 issuances),
  `?edition=<id>` permalinks with an aged-out snapshot fallback via the server,
  and canonical `/o/CODE/` office URLs with back/forward support.
- **Diffs**: each section changed since the previous edition gets an
  "Updated" badge and a "What changed" tab (paragraph-level LCS diff from
  `docs/js/diff.js`), plus the server's one-line changelog under the takeaway.
- **Alerts**: live alerts as an Accordion with severity badges, future-onset
  windows ("start → end", Upcoming badge), in-effect/upcoming counts, and a
  lazy plain-English lead per alert via `/api/explain-alert`.
- **Almanac**: sunrise/sunset/daylight/moon computed client-side, live
  Now/Normal-high via `/api/conditions` when available.
- **Auto-refresh**: 10-minute polling for a newer issuance (2 minutes while a
  Severe/Extreme Warning is active), surfaced as a dismissible banner.
- **Offline/PWA**: a service worker caches the shell, hashed assets, and the
  last NWS responses; the app also keeps the last edition per office in
  localStorage and renders it with an offline notice when fetches fail.
- Geolocation ("find my nearest office"), `navigator.share` with clipboard +
  toast fallback, keyboard shortcuts (j/k/?//), scrollspy, skeleton loading,
  an aria-live announcer, tap-friendly glossary tooltips, error boundary,
  light/dark theme that follows the OS until explicitly toggled.

## Components

Hand-vendored shadcn components (JSX, `new-york` style, neutral base) live in
`src/components/ui/`: Accordion, Alert, Badge, Button, Card, Dialog, Progress,
Select, Separator, Skeleton, Sonner, Tabs, Tooltip. `components.json` is
configured so `npx shadcn@latest add <component>` drops new ones into the
same tree.

## Single source of truth + fork guards

Canonical data modules are imported straight from the vanilla client
(`docs/js/`): `offices.js`, `glossary.js` (230+ terms), `abbreviations.js`,
`timeline.js` (confidence scoring), `diff.js` (the diff engine). Components
use the `@data` Vite alias; `src/lib/*` uses plain relative imports so the
repo's Bun test suite can load them.

The pure functions ported out of `docs/js/app.js` are locked against drift:
`tests/shadcn-parity.test.js` asserts the forked bodies (parseSections,
stripAIArtifacts, escapeHTML, stripNWSArtifacts, hasRealAlerts,
reorderSections, formatTranslationHTML, sunTimes, moonPhase) stay
code-identical to app.js, and `tests/shadcn-afd.test.js` covers the
deliberate divergences (timezone as a parameter, segment-based glossary
annotation) behaviorally.

## Run it

```sh
cd shadcn
bun install
bun run dev      # dev server
bun run build    # production build to dist/
bun test tests/  # from the repo root — includes the shadcn suites
```

## Deployment & the agent/SEO surface

This app IS the deployed frontend: the Vercel buildCommand runs `vite build`
plus `scripts/prepare-deploy.mjs` (deletes `dist/index.html` so the `/`
rewrite reaches api/home.js, copies the docs/ static surface in), and
`outputDirectory` is `shadcn/dist`. `index.html` here is the TEMPLATE for the
whole SSR pipeline — `scripts/build-offices.mjs` transforms it (built asset
refs via `scripts/app-shell.mjs`) into the committed `api/_home-shell.html`
that api/home.js and api/office-page.js inject the server-rendered digest
into, and into every baked `docs/o/<CODE>/` page. Its `#ssr-root` region is
what crawlers, agents, and no-JS readers see; the app removes it on mount.
Markdown content negotiation, per-office canonicals/OG/JSON-LD, sitemap,
llms.txt, and the JSON API surface all continue to work unchanged. Edit the
marker strings in `index.html` only together with the generator, then run
`bun scripts/build-offices.mjs` and commit.
