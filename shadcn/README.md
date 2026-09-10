# Plaincast — shadcn/ui edition

A React port of the Plaincast reader built with [shadcn/ui](https://ui.shadcn.com),
Vite, and Tailwind CSS v4. It renders the same product as the vanilla client in
`docs/`: the latest NWS Area Forecast Discussion, translated into plain English
side by side with the annotated original.

## What's shadcn here

Hand-vendored shadcn components (JSX, `new-york` style) live in
`src/components/ui/`: Button, Badge, Card, Alert, Select, Dialog, Tooltip,
Accordion, Progress, Separator, Skeleton. `components.json` is configured so
`npx shadcn@latest add <component>` drops new ones into the same tree.

The Plaincast design system (DESIGN.md at the repo root) is mapped onto
shadcn's CSS variables in `src/index.css` — cream paper `--background`, deep
teal `--primary`, amber jargon highlights, and the Fraunces / Source Serif 4 /
DM Sans / JetBrains Mono stacks — so the components are stock shadcn but the
page still reads as Plaincast.

## Single source of truth

The canonical data modules are imported straight from the vanilla client via
the `@data` alias (`../docs/js`): `offices.js`, `glossary.js` (230+ terms),
`abbreviations.js`, and `timeline.js` (confidence scoring). The pure AFD
parsing/translation logic is ported into `src/lib/afd.js` with the timezone as
a parameter instead of a module global; glossary annotation returns segment
arrays rendered as shadcn Tooltips instead of HTML strings.

Forecast data comes client-side from the public `api.weather.gov` endpoints
(products + active alerts), same as the vanilla client. The AI translation
endpoints (`/api/translate`) are not wired up here — the plain-English column
uses the same regex/abbreviation translator the vanilla client falls back to.

## Run it

```sh
cd shadcn
bun install
bun run dev      # dev server
bun run build    # production build to dist/
```
