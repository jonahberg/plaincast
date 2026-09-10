# Plaincast — shadcn/ui edition

A React rebuild of Plaincast with [shadcn/ui](https://ui.shadcn.com), Vite, and
Tailwind CSS v4. Same product as the vanilla client in `docs/` — the latest NWS
Area Forecast Discussion translated into plain English — but a full redesign:
the stock shadcn look (default neutral theme, system font stack, cards and
tabs), not the editorial "Dispatch" design system from DESIGN.md.

## Layout

- Sticky app header: wordmark, grouped office Select (all 68 offices), share,
  keyboard-shortcuts Dialog, GitHub link, theme toggle
- Page intro: office title, issue time, forecaster, confidence Progress +
  Badge, and the key takeaway as an Alert
- One Card per AFD section with **Plain English / Original** Tabs — the
  original shows the raw NWS text with every glossary term as a Tooltip
- Active alerts as an Accordion in a Card, with severity Badges
- Section nav buttons with scrollspy, j/k//? keyboard shortcuts, Skeleton
  loading states, light/dark theme

## Components

Hand-vendored shadcn components (JSX, `new-york` style, neutral base) live in
`src/components/ui/`: Accordion, Alert, Badge, Button, Card, Dialog, Progress,
Select, Separator, Skeleton, Tabs, Tooltip. `components.json` is configured so
`npx shadcn@latest add <component>` drops new ones into the same tree.

## Single source of truth

The canonical data modules are imported straight from the vanilla client via
the `@data` alias (`../docs/js`): `offices.js`, `glossary.js` (230+ terms),
`abbreviations.js`, and `timeline.js` (confidence scoring). The pure AFD
parsing/translation logic is ported into `src/lib/afd.js` with the timezone as
a parameter instead of a module global; glossary annotation returns segment
arrays rendered as shadcn Tooltips instead of HTML strings.

Forecast data comes client-side from the public `api.weather.gov` endpoints
(products + active alerts), same as the vanilla client. The AI translation
endpoints (`/api/translate`) are not wired up here — the plain-English tab
uses the same regex/abbreviation translator the vanilla client falls back to.

## Run it

```sh
cd shadcn
bun install
bun run dev      # dev server
bun run build    # production build to dist/
```
