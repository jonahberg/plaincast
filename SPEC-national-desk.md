# SPEC — The National Desk

**Status:** DRAFT — awaiting owner review. No implementation until approved.
**Date:** 2026-08-15

## What and why

Plaincast has 68 local editions and no front page. The National Desk is the national
front page of the paper: where the weather *is* today, told in the Dispatch voice, with
every dispatch linking into its local edition. It is the entry point for a reader who
doesn't yet know their forecast office, and the page that makes Plaincast feel like a
publication instead of a lookup tool.

Design constraint (from DESIGN.md): this is a broadsheet front page, typeset — never a
radar map, never a dashboard. All anti-tells apply.

## URL and navigation

- **v1:** `/national/`, linked from the office-index footer on every page (as-built:
  no masthead nav exists anywhere on the site, so the original "masthead running-head"
  line here was unimplementable as written — final-review finding). Whether the front
  page also earns a masthead folio link is an open owner decision.
- **v2 (explicitly deferred):** flipping `/` so returning readers land on their saved
  local desk and new visitors land on the National Desk. This decision is gated on
  Vercel Web Analytics being enabled and a few weeks of real numbers.

## Page anatomy (top to bottom)

1. **Masthead + dateline** — Fraunces nameplate variant: `PLAINCAST · The National Desk`,
   Scotch double-rule, dateline `UNITED STATES · Convective Outlook · {date}`.

2. **The National Lede** — built from the SPC Day 1 Convective Outlook. The product has
   a stable shape (verified live 2026-08-15): a `...THERE IS A <RISK> OF...` headline
   line and a `...SUMMARY...` section. The lede renders the headline as the kicker and
   an AI-condensed deck from the SUMMARY ("Simplified by AI" credit — never a vendor
   name). **Deterministic fallback:** the SUMMARY paragraph regex-translated, exactly
   the office-page.js pattern (AI failure can never blank the lede).

3. **The Wire** — a dense hairline-ruled column of dispatches: every forecast office
   currently under a Severe- or Extreme-severity Warning, worst first (reuse the
   Bulletin Slab's extreme>severe ranking). Each dispatch: city + office code (linked to
   `/o/CODE/`), the leading warning event, and the office's alert count. Capped at ~12
   dispatches with a "and N more offices" line.

4. **The Census** — an almanac-ledger strip in the style of the existing `#ledger`:
   total active products and counts by event class (Tornado / Severe Thunderstorm /
   Flash Flood / …), oldstyle figures, hairline cells.

5. **Your Local Desk** — "Reading from Chicago? Your desk is LOT →". See geolocation
   design below; renders nothing if location is unavailable.

6. **Colophon** — standard, with `❧`.

## Architecture

Clone the proven office-page pattern wholesale:

- `api/national-desk.js` serverless function; `vercel.json` rewrite
  `/national/` → `/api/national-desk` (and the no-trailing-slash variant).
- Baked shell `docs/national/index.html` committed for tests/history, **excluded from
  deployment via `.vercelignore`** (same reason as `docs/o`: filesystem shadows
  rewrites), delivered to the function via `functions.*.includeFiles`.
- **Fail-safe floor:** on any error the function serves the baked shell, which carries
  the masthead + a typeset index of all 68 desks — still a useful page with zero
  upstream fetches. Same "worst case is a good page" contract as office-page.js.
- Client JS is progressive enhancement only (local-desk pointer, AI deck swap); the
  page is complete without it. Periodic Wire refresh is deferred to v1.1 — behind the
  600s/1800s CDN cache a client-side refresh adds little (final-review ruling).

### Geolocation — why it is client-side

The SSR page is cached at the CDN (`s-maxage=600, stale-while-revalidate=1800`). A
server-rendered geo pointer would bake the first visitor's location into the cached
body for everyone behind that edge — "Your desk: Chicago" served to Miami. Therefore:

- The page body is **geo-agnostic and cacheable**.
- A new micro-endpoint `api/whereami.js` reads Vercel's `x-vercel-ip-latitude` /
  `x-vercel-ip-longitude` headers, resolves office via
  `api.weather.gov/points/{lat},{lon}` → `properties.gridId`, and returns
  `{office, city}` with `Cache-Control: no-store`. No client input is trusted or
  needed; no permission prompt (IP-level, not GPS).
- Client JS calls it and fills the Local Desk slot; absent/failed → slot stays empty.

## Data sources (all verified live 2026-08-15)

| Need | Source | Verified facts |
|---|---|---|
| National lede | `api.weather.gov/products/types/SWO/locations/DY1` → latest product | 36 issuances listed; text has stable `...SUMMARY...` + headline; keyed by `issuanceTime` |
| Wire + Census | `api.weather.gov/alerts/active?status=actual&severity=Severe,Extreme` | 188 features at probe time; office code = last 3 chars of `parameters.AWIPSidentifier[0]` (e.g. `SVRPUB` → PUB); `limit` param NOT supported — slice server-side |
| Local desk | `api.weather.gov/points/{lat},{lon}` | `properties.gridId` is the WFO code |

Implementation notes:
- `/alerts/active/count` groups by **state, not office or event** — the Census must be
  computed from the filtered alerts feed, not the count endpoint.
- Marine products (e.g. `SMWMHX`) appear in the severity filter; check the API's
  `region_type=land` parameter during implementation, else filter marine event types.
- All upstream fetches go through the existing `_utils.js` helpers with
  `AbortSignal.timeout`, matching current API hygiene.

## AI usage and cost

One Haiku call per SPC outlook issuance (a handful per day), via the existing AI
Gateway path, cached per `issuanceTime`. **The endpoint takes zero client input** — it
always summarizes the latest outlook, so it cannot be driven by an attacker. This
matters because the AI Gateway spend cap is still unset (open owner action since
Jun 11); every new AI surface must be inherently unabusable. Reasoning-tagged models
are prohibited here (standing rule from the Aug 1 DeepSeek incident).

## Decisions for the owner

1. **Uncovered offices in the Wire** (e.g. Cheyenne CYS appeared in the live probe;
   the roster covers 68 of ~122 WFOs). Recommendation: render them as unlinked
   dispatches in v1 — the news is real even when we lack a local edition — and treat
   roster expansion as its own v2 project.
2. **Name check:** `/national/` and "The National Desk", or another masthead name?
3. **OG card:** v1 ships a static national OG card; a dynamic per-outlook card (like
   `api/og.js`) can follow. OK?

## Non-goals (v1)

- Roster expansion beyond 68 offices (v2: needs names/timezones/stations authored).
- Maps, radar imagery, geographic visualization of any kind (anti-tell).
- The front-page flip (v2, analytics-gated).
- Push/email distribution (Direction A — separate spec if chosen later).

## Testing

Bun tests alongside the existing 351: AWIPS→office extraction and grouping/ranking
(fixtures from the live probe), SPC headline+SUMMARY extraction and the deterministic
fallback, whereami header parsing and gridId mapping, baked-shell marker integrity
(extend the seo-pages sync-check pattern to `docs/national/`), and fail-safe behavior
when every upstream fetch throws.

## v1.1 — The Composed Desk (C × A × E)

**Status:** DRAFT — owner voted C + parts of A + parts of E (2026-08-15); synthesis
presented as Study F in the National Desk Studies artifact. Build starts only after
(a) owner says "go" on Study F and (b) PR #34 is merged (this layers onto it).

### Page order (replaces the v1 composition between masthead and local desk)

1. **Masthead + dateline** — unchanged from v1.
2. **Census index strip** (from A + E) — a one-row DM Sans strip under the dateline:
   national total, top event classes (up to 4), and the quiet-count
   ("56/68 desks quiet"). Replaces the v1 census ledger section lower down.
3. **The risk moment** (from C) — the Day-1 categorical risk as a rubricated
   Fraunces display word (`opsz 144, SOFT 12`), with a small-caps line naming the
   risk type and outlined regions. **Calm-day face:** when no risk is outlined,
   no big word — a small "Quiet skies nationally" line in its place.
4. **Standfirst** — the AI deck (existing `/api/national-lede`, unchanged), centered
   Fraunces deck; deterministic SSR text first, client swap as today.
5. **Running copy** (from A) — sourced from the SPC **discussion narrative that
   FOLLOWS the SUMMARY section** (the `...20Z Update...` / synopsis / regional
   prose), NEVER the SUMMARY itself — the standfirst already distills the
   summary, and running the summary again says the same thing twice (owner
   correction, 2026-08-16). Regex-translated into 1–3 justified paragraphs
   (skip section-header lines, cap ~3 paragraphs ≥40 chars each) with a 3-line
   rubricated drop cap. SSR, zero AI. **Fallback:** if no post-summary narrative
   parses, run the SUMMARY here and suppress the deterministic deck (never both
   from the same source); the AI deck still swaps in client-side.
6. **Day rail** (from C) — three cells: Day 1 (highlighted, `--newsprint` ground),
   Day 2, Day 3. Each: label, categorical word, one-line region note. Day 2/3 from
   `products/types/SWO/locations/DY2|DY3` (verified live 2026-08-15); each cell
   soft-fails to "—" independently.
7. **The Wire, two-line rows** (from E) — row 1 as v1 (office link, event, count,
   extreme rubric); row 2 small-caps: area digest + expiry
   ("Otero & Crowley counties · until 730 PM MDT"), from the alert feed's
   `areaDesc` (digested: first 2 named areas + "…") and `expires`/`ends` in the
   office's local timezone. Missing fields → row 2 omitted, never blank.
8. **Clock line** (from E) — "Next Day 1 outlook expected by HHMM UTC" from the
   fixed SPC issuance schedule (0600/1300/1630/2000/0100 UTC), plus the CDN
   re-ink note. Pure arithmetic, no fetch.
9. **Local desk slot, office index, colophon** — unchanged.

### New parsing/logic (all pure, all unit-tested)

- `parseRiskCategory(headline) -> {level, regions}` — maps THERE-IS lines to
  MARGINAL/SLIGHT/ENHANCED/MODERATE/HIGH; null on no match (calm face).
- `parseDiscussionBody(productText) -> string[]` — narrative paragraphs AFTER
  the `...SUMMARY...` block: skip `...SECTION...` header lines and `$$`/sig
  noise, keep prose paragraphs ≥40 chars, cap at 3. Empty array on no match
  (triggers the running-copy fallback above). Fixture-tested against a live
  DY1 capture.
- `digestArea(areaDesc) -> string` — first two named areas + ellipsis count.
- `formatExpiry(iso, tz) -> string|null` — office-local, small-caps friendly.
- `nextOutlookTime(now) -> string` — next slot in the fixed SPC schedule.
- Day-rail fetchers: `fetchSpcDy2/Dy3` (clone of fetchSpcDy1 with location swap) —
  or one parameterized `fetchSpcOutlook(day)` refactor, implementation's choice.

### Unchanged invariants (bind as in v1)

Fail-safe baked floor (strip/risk/rail all degrade independently; worst case is
v1's floor). Zero client input on every endpoint. No new AI surface — the deck
endpoint remains the only model call. escHtml on every interpolation. Dispatch
anti-tells. `s-maxage=600, swr=1800` page cache. Suite stays green; new logic
lands with fixture-driven tests (capture DY2/DY3 + an `areaDesc`-rich alerts
fixture on build day).

### Explicitly out (unchanged from v1 rulings)

Roster expansion, maps, front-page flip (analytics-gated), periodic client
refresh beyond the CDN cadence, Gazetteer (B) and Evening Wire (D) — parked as
future studies, not folded in.

### Visual-review build rules (from the Aug 16 screenshot pass)

- Census strip cells `flex: 1 1 auto; text-align: center` — the row must fill
  its measure with no trailing empty segment.
- Running copy is justified with hyphens ONLY ≥640px; below that,
  `text-align: left` (justify at narrow measure produces rivers — observed).
- Running copy must open with forecast prose directly (the parser strips any
  editorial preamble; first paragraph starts with the meteorology).
- Deck sizes one step below v1's (the risk word owns the hero role);
  keep `clamp()` responsive sizing from the shipped page.
- Known, accepted: the risk line ("risk of severe thunderstorms · regions")
  and the deck's opening words overlap slightly — label vs. sentence, both
  earn their place; do not "fix."
