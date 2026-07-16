# Design System — Plaincast

> **CURRENT SYSTEM: "The Dispatch" (2026-06-11).** Plaincast is set as a *printed weather
> almanac that happens to live on the web* — never a SaaS dashboard. The sections below
> ("Product Context" onward) are the earlier editorial system and are SUPERSEDED where they
> conflict with this block. North star: *a printed weather almanac on the web.* Anti-tells to
> avoid: progress bars/meters, frosted-glass app bars, rounded shadowed cards, emoji icons,
> gradient-mesh heroes, neon dark mode, everything centered, blue-because-weather.

## The Dispatch — Layout & Components
- **Broadsheet**: all content sits on one constant paper `.sheet` (max 1080px, soft shadow, ~3px radius) floating on the atmosphere; full-bleed under 820px.
- **Masthead**: Fraunces nameplate (`opsz 144`, flanking-hairline folios bind date ⟷ nameplate ⟷ `NWS XXX`), italic WONK motto, **Scotch double-rule** (2px+1px ink), terse dateline `CITY · Area Forecast Discussion · {Edition}`.
- **Almanac ledger** (`#ledger`): hairline-celled reference strip — Now · Normal high · Sunrise · Sunset · Daylight · Moon. Oldstyle figures, centered values, two-tone moon SVG. This is the "data-as-content" hero — keep it dense and typeset.
- **Lede**: `.lede-kicker` (oxblood small-caps) → takeaway as a big Fraunces deck (centered) → rubricated 3-line drop cap on the first narrative section → byline (rule above) → `.lede-meta` (issued time + confidence) → "Since the X update" note.
- **Two-column spread** (kept): warm-paper plain-English prose | **cool `--newsprint` facsimile** of the original AFD (JetBrains Mono, de-boxed, jargon underlines). They read as two stocks.
- **Contents nav**: a printed running-head (solid paper, Scotch-rule borders, NO backdrop blur), sticky.
- **Colophon** footer with `❧`, "Earlier editions" history control.

## The Dispatch — Atmosphere (subtle, tasteful, reduced-motion-safe)
- Fixed full-viewport sky behind the broadsheet. `data-phase` ∈ {dawn,morning,midday,golden,dusk,night} from the office's local time; `data-condition` from `/api/conditions` text. OKLCH palettes with `@property` 1.8s crossfade; chroma peaks at golden/dawn/dusk, near-neutral at midday/night. Light "night" stays light paper, just cooled. 96s transform-only glow drift + ≤0.04 feTurbulence grain — both disabled under `prefers-reduced-motion`. The reading card never moves, so contrast is invariant.

## The Dispatch — Type & Color
- Fonts: **Fraunces** display (axes `opsz`/`SOFT`/`WONK`; no small-caps, no oldstyle figures), **Source Serif 4** body (small-caps + oldstyle/lining-tabular numerals live here), **DM Sans** labels (uppercase, tracked), **JetBrains Mono** facsimile (ligatures off, lining-tabular). Prefer `font-variant-*` over `font-feature-settings`; always pin `opsz` when setting Fraunces `font-variation-settings`.
- Drop cap: `initial-letter: 3 3` + float fallback, at `opsz 144`, oxblood.
- Color (light): paper `#f7f3ea`, ink `#211d17`, accent (links) deep teal-ink `#0c5e54` (`--teal` is an alias JS inline styles depend on — keep), rubric oxblood `#8a2b18`, `--newsprint #eceae1`. Controls use `--control-line` (≥3:1). `--text-muted #6d6453` (5.3:1 — AA for small labels). Dark = warm charcoal broadsheet on deep-indigo sky.
- Confidence is a plain **ink italic word** (the word carries the level), never a colored meter.

## Product Context
- **What this is:** AI-powered translator for NWS Area Forecast Discussions — side-by-side plain English summaries with annotated originals
- **Who it's for:** Weather-curious people who want the real forecast, from casual readers to weather enthusiasts
- **Space/industry:** Weather tools, editorial content, reading experiences
- **Project type:** Single-page web app, content-first, read-heavy

## Aesthetic Direction
- **Direction:** Editorial/Magazine — like the best independent newsletter you subscribe to, not a newspaper
- **Decoration level:** Intentional — subtle warmth through cream/off-white backgrounds, not stark white
- **Mood:** Warm, authored, grounded. The meteorologist's voice comes through in the design. "Slow down, read, this is worth your attention."
- **Reference sites:** Ventusky (visual excellence), Substack/The New Yorker (editorial quality), Instapaper (reading surface)
- **Anti-patterns:** No data dashboards, no icon-heavy weather layouts, no blue-accent-because-weather defaults, no AI slop gradients

## Typography

- **Display/Hero:** Fraunces (variable, 400 weight) — warm old-style serif with personality. Slight wonkiness gives Plaincast a point of view. `letter-spacing: -0.02em`
- **Body:** Source Serif 4 (variable, 400/600 weight) — designed for screen reading with optical sizes. 17px / line-height 1.75. More personality than Georgia, beautiful in long-form.
- **UI/Labels:** DM Sans (variable, 400-600 weight) — clean geometric sans, excellent at small sizes. Used for all non-prose text: navigation, labels, meta info, form controls.
- **Data/Tables:** DM Sans with `font-variant-numeric: tabular-nums` for aligned numbers
- **Code/AFD text:** JetBrains Mono (variable, 400 weight) — best-in-class readability for dense meteorological abbreviations. 0.82rem / line-height 1.65.
- **Loading:** Google Fonts CDN with `display=swap`

### Font Stacks (CSS Custom Properties)
```css
--font-display: 'Fraunces', serif;
--font-body: 'Source Serif 4', serif;
--font-ui: 'DM Sans', sans-serif;
--font-mono: 'JetBrains Mono', monospace;
```

### Type Scale
| Role | Font | Size | Weight | Extra |
|------|------|------|--------|-------|
| Page title | Fraunces | 2rem (1.5rem mobile) | 400 | letter-spacing: -0.02em |
| Section subhead | Fraunces | 1.5rem | 400 | color: --text-secondary |
| Callout / lead | Source Serif 4 | 1.1rem | 400 | line-height: 1.6 |
| Body | Source Serif 4 | 17px | 400 | line-height: 1.75 |
| UI text | DM Sans | 0.85rem | 400 | — |
| Section titles | DM Sans | 0.8rem | 600 | uppercase, letter-spacing: 0.08em |
| Small labels | DM Sans | 0.7rem | 600 | uppercase, letter-spacing: 0.08em |
| Badge / tag | DM Sans | 0.65rem | 600 | uppercase, letter-spacing: 0.08em |
| Monospace (AFD) | JetBrains Mono | 0.82rem | 400 | line-height: 1.65 |

## Color

- **Approach:** Restrained with intentional departures — teal primary replaces the default blue every weather tool uses

### Light Mode (default)
| Token | Value | Usage |
|-------|-------|-------|
| `--text` | `#1C1917` | Body text (warm near-black) |
| `--text-secondary` | `#57534E` | Secondary text |
| `--text-muted` | `#78716C` | Muted text, labels, meta |
| `--teal` | `#0F766E` | Primary accent — links, active states, key takeaway |
| `--teal-light` | `#F0FDFA` | Accent backgrounds (callouts, active pills) |
| `--teal-muted` | `rgba(15, 118, 110, 0.08)` | Subtle accent tints |
| `--amber` | `#B45309` | Warnings, emphasis, jargon highlights |
| `--amber-light` | `#FFFBEB` | Warning backgrounds |
| `--border` | `#E7E5E4` | Borders, dividers |
| `--bg` | `#FAFAF5` | Page background (warm cream, not white) |
| `--bg-surface` | `#FFFFFF` | Card/modal surfaces |
| `--bg-inset` | `#F5F5F0` | Inset backgrounds (code blocks, mono panels) |

### Dark Mode (`.dark` on `<html>`)
| Token | Value | Usage |
|-------|-------|-------|
| `--text` | `#E7E5E4` | Body text |
| `--text-secondary` | `#A8A29E` | Secondary text |
| `--text-muted` | `#78716C` | Muted text |
| `--teal` | `#2DD4BF` | Primary accent (desaturated for dark) |
| `--teal-light` | `rgba(13, 148, 136, 0.12)` | Accent backgrounds |
| `--teal-muted` | `rgba(45, 212, 191, 0.08)` | Subtle accent tints |
| `--amber` | `#FBBF24` | Warnings, emphasis |
| `--amber-light` | `rgba(180, 83, 9, 0.15)` | Warning backgrounds |
| `--border` | `#292524` | Borders |
| `--bg` | `#111110` | Page background |
| `--bg-surface` | `#1C1917` | Card/modal surfaces |
| `--bg-inset` | `#0C0C0B` | Inset backgrounds |

### Semantic Colors
| State | Light | Dark |
|-------|-------|------|
| Warning (red) | `#DC2626` on `#FEF2F2` | `#F87171` on `rgba(220,38,38,0.12)` |
| Watch (amber) | `#B45309` on `#FFFBEB` | `#FBBF24` on `rgba(180,83,9,0.15)` |
| Advisory (teal) | `#0F766E` on `#F0FDFA` | `#2DD4BF` on `rgba(13,148,136,0.12)` |
| Info (blue) | `#2563EB` on `#EFF6FF` | `#60A5FA` on `rgba(37,99,235,0.12)` |
| Success (green) | `#16A34A` on `#F0FDF4` | `#4ADE80` on `rgba(22,163,74,0.1)` |
| Statement (stone) | `#78716C` on `#F5F5F4` | `#A8A29E` on `rgba(120,113,108,0.12)` |

### Dark Mode Strategy
Reduce saturation 10-20% for accents. Use semi-transparent backgrounds for tinted surfaces. Warm dark backgrounds (not pure black, not cold gray).

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable — more generous than the previous system. Let the content breathe.

| Token | Value |
|-------|-------|
| Page max-width | 1100px (centered) |
| Horizontal padding | 2rem (1.25rem mobile) |
| Section gap | 3.5rem |
| Column gap | 2.5rem (1.5rem mobile) |
| Header top padding | 3rem |
| Component internal padding | 1.25rem–1.5rem |

### Spacing Scale
| Name | Value |
|------|-------|
| 2xs | 2px |
| xs | 4px |
| sm | 8px |
| md | 16px |
| lg | 24px |
| xl | 32px |
| 2xl | 48px |
| 3xl | 64px |

## Layout
- **Approach:** Grid-disciplined — the two-column side-by-side IS the product
- **Grid:** 2 columns on desktop (1fr 1fr), 1 column on mobile
- **Max content width:** 1100px
- **Border radius:** sm: 4px (inputs), md: 6px (cards, callouts, alerts), lg: 10px (modals), full: 999px (pills, toggles)

## Motion
- **Approach:** Minimal-functional — only transitions that aid comprehension
- **Easing:** enter: ease-out, exit: ease-in, move: ease-in-out
- **Duration:** micro: 100ms (hover states), short: 150ms (border/color transitions), medium: 200ms (slide-down banners), long: 500ms (confidence bar fill)
- **Reduced motion:** Respect `prefers-reduced-motion: reduce` — disable animations, keep opacity

## Components

### Pill Button (Section Nav)
- `border-radius: 999px`, 1px border `var(--border)`, `0.25rem 0.75rem` padding
- Font: DM Sans, 0.8rem
- Active: `background: var(--teal-muted)`, `border-color: var(--teal)`, `color: var(--teal)`
- Hover: `border-color: var(--text-muted)`, `color: var(--text)`
- Transition: all 0.15s

### Callout Box (Key Takeaway)
- Background: `var(--teal-light)`, 3px solid left border `var(--teal)`
- Right border-radius: 6px
- Label: DM Sans, 0.7rem, uppercase, letter-spaced, `color: var(--teal)`
- Text: Source Serif 4, 1.1rem

### Alert Items — the Hazard Ledger
- Alerts render as a hairline-ruled ledger (`.hz-ledger` of `.hz-row` rows), not boxed cards. No emoji.
- **Severity marks** (`.hz-mark`, emoji-free, ~0.62em): filled square for a Warning, diagonal-hatched for a Watch, thin hollow outline for an Advisory, dashed outline for a Statement. Each kind (`hz-warn`/`hz-watch`/`hz-adv`/`hz-stmt`) sets a shared `--sev` ink that the mark, rules, and headings read.
- Rows expand **inline** on click to a plain-English lead above the verbatim NWS text (this replaces the old alert detail modal).
- **Bulletin Slab** (`.hz-slab`): during severe posture the worst Severe/Extreme Warning is promoted to a headline above the ledger, with its own plain-English lead.
- **On the clock** (`.clock-col`, `.hz-clock-*` chart): an optional timetable view that plots timed alerts against the hours ahead, offered as a third view toggle once enough alerts carry start/end times.

### Select / Dropdown
- DM Sans, 0.85rem, 1px border, 6px radius
- Background: `var(--bg-surface)`

### Input
- DM Sans, 0.85rem, 1px border `var(--border)`, 6px radius
- Focus: `border-color: var(--teal)`

### Modal
- 10px radius, max-width 600px, 2rem padding
- Background: `var(--bg-surface)`
- Backdrop: `rgba(0,0,0,0.4)` (0.6 in dark)
- Focus trap, Escape to close

### Tooltip (Jargon Highlights)
- Highlight: `background: rgba(180, 83, 9, 0.12)`, `border-bottom: 1px dashed var(--amber)`
- Tooltip: 6px radius, dark bg, white text, max-width 280px
- Below variant for top-of-screen overflow

### Banner (Auto-refresh, Offline)
- Same callout pattern with 3px left border
- Teal variant for informational, amber for warnings
- Slide-down animation (0.2s ease-out)

### Theme Toggle
- Use clean SVG icon (sun/moon), not emoji
- `border-radius: 999px`, 32x32px, 1px border
- Transition: border-color and color 0.15s

### Confidence Bar
- Track: 8px height, `var(--border)` background, 4px radius
- Fill: `var(--teal)`, 4px radius
- Label: DM Sans, 0.7rem, uppercase, letter-spaced

## Patterns

- **Labels**: DM Sans, uppercase, small (0.65–0.8rem), letter-spaced (0.08em), `color: var(--text-muted)`
- **Emphasis**: 3px solid left border + tinted background (callout pattern)
- **Loading**: 12px spinning circle with teal accent `border-top`
- **Dividers**: 1px solid `var(--border)`
- **Links**: `color: var(--teal)`, underline on hover

## Breakpoints

| Name | Query | Key Changes |
|------|-------|-------------|
| Mobile | `max-width: 768px` | Single column, larger touch targets, horizontal scroll nav, reduced padding |
| Desktop | `> 768px` | Two-column side-by-side, keyboard shortcuts visible |

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-19 | Replaced blue accent with deep teal | Every weather tool uses blue. Teal says "nature, calm, knowledge" while being instantly distinctive. |
| 2026-03-19 | Adopted Fraunces for display type | Warm old-style serif with personality. Gives Plaincast a distinctive editorial voice vs. generic Georgia. |
| 2026-03-19 | Adopted Source Serif 4 for body text | Designed for screen reading with optical sizes. Replaces Georgia for better personality and readability. |
| 2026-03-19 | Adopted DM Sans for UI text | Clean geometric sans, excellent at small sizes. Replaces system sans-serif for consistency across platforms. |
| 2026-03-19 | Adopted JetBrains Mono for AFD text | Best-in-class character distinction for dense meteorological abbreviations. Replaces SF Mono/Monaco. |
| 2026-03-19 | Changed background from pure white to warm cream (#FAFAF5) | Shifts feel from "website" to "reading surface." Better for long-form reading, premium feel. |
| 2026-03-19 | Amber for jargon highlights | Replaces yellow. Warmer, more intentional, pairs with the teal accent. Amber also maps to weather advisory severity. |
| 2026-03-19 | Full design system rewrite | Fresh start from /design-consultation with competitive research across weather and editorial sites. |
