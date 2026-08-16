# The National Desk — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/national/` — a server-rendered national front page (SPC Day-1 lede, Wire of offices under Severe/Extreme warnings, alert Census, client-side local-desk pointer) in the Dispatch design language.

**Architecture:** Clone the proven `api/office-page.js` SSR pattern: a committed-but-not-deployed baked shell (`docs/national/index.html`, excluded via `.vercelignore`, delivered via `includeFiles`) that the function enriches with live NWS data, failing safe to the baked shell. AI appears only in a separate per-issuance-cached endpoint (`api/national-lede.js`, cloned from `api/changelog.js`); the SSR page itself never calls AI. Geolocation is client-side via an uncached `api/whereami.js` so the CDN-cached page stays geo-agnostic.

**Tech Stack:** Vanilla JS ESM, Vercel serverless (Node), `ai` v6 `generateText` via Vercel AI Gateway, Bun test.

**Spec:** `SPEC-national-desk.md` (repo root — read it first; the three owner decisions are resolved: uncovered offices render **unlinked**, name is **`/national/` + "The National Desk"**, OG is the **static** homepage card).

## Global Constraints

- AI model: `anthropic/claude-haiku-4.5` exactly. NO reasoning-tagged models, ever (Aug 1 incident). Copy credits say "Simplified by AI" — never a vendor name.
- New AI surface takes ZERO client input (no query params influence the model call).
- Every interpolated value goes through `escHtml` (`scripts/build-offices.mjs:19`).
- CSP has no `unsafe-inline` for scripts: no inline `<script>` bodies, no inline event handlers. Client JS connects only to `'self'` + `https://api.weather.gov` (`vercel.json` CSP) — `/api/*` calls are same-origin, fine.
- DESIGN.md anti-tells: no maps, meters, cards-with-shadows, emoji icons, blue-because-weather. Reuse existing classes/vars (`.masthead`, `.ledger`, `.office-index`, `--rubric`, `--newsprint`) before inventing new ones.
- Bun everywhere: `bun test tests/`, `bun scripts/build-offices.mjs`.
- NEVER merge to main — merge=deploy on this repo. Work stays on branch `claude/national-desk-spec` (PR #34).
- NWS API facts (verified 2026-08-15, cited in spec): `limit` is NOT a valid query param on `/alerts/active` or `/products/*`; office code = last 3 chars of `parameters.AWIPSidentifier[0]`; `region_type=land` is valid on `/alerts/active`; census-by-event must come from the filtered feed, not `/alerts/active/count` (state-grouped) — `/count`'s `total` field is still used for the national total.

## File Structure

- `api/_national.js` — NEW. Pure logic: SPC outlook parsing, alert→office extraction, dispatch grouping/ranking, census. No I/O, fully unit-tested.
- `api/_utils.js` — MODIFY. Add three fetchers following the existing `fetchAFDList` shape: `fetchSevereAlerts`, `fetchAlertTotals`, `fetchSpcDy1`.
- `api/national-lede.js` — NEW. AI deck endpoint (changelog.js clone).
- `api/national-desk.js` — NEW. SSR handler (office-page.js clone).
- `api/whereami.js` — NEW. Geo micro-endpoint, `no-store`.
- `docs/national/index.html` — NEW. Baked shell (committed, not deployed).
- `docs/js/national.js` — NEW. Progressive enhancement (lede swap + local desk).
- `docs/styles.css` — MODIFY. `.wire`, `.census`, `.local-desk` styles from existing vars.
- `docs/index.html` — MODIFY. National Desk entry in `.office-index` footer (line ~391).
- `scripts/build-offices.mjs` — MODIFY. Sitemap gains `/national/`; regen baked pages.
- `vercel.json` — MODIFY. Rewrites + `includeFiles`.
- `.vercelignore` — MODIFY. Add `docs/national`.
- Tests: `tests/national.test.js`, `tests/api-national-lede.test.js`, `tests/api-national-desk.test.js`, `tests/api-whereami.test.js`, `tests/fixtures/national/*`.

---

### Task 1: Pure logic module `api/_national.js` + live fixtures

**Files:**
- Create: `api/_national.js`, `tests/national.test.js`
- Create: `tests/fixtures/national/severe-alerts.json`, `tests/fixtures/national/swody1.json`

**Interfaces (Produces):**
- `officeFromAlert(props) -> string|null` — 3-letter WFO code from `props.parameters.AWIPSidentifier[0]`, or null.
- `groupDispatches(features, officeNames) -> Array<{code, city|null, event, count, extreme}>` — Warnings only, one row per office, worst-first, `city` null when code not in `officeNames`.
- `buildCensus(features) -> Array<{event, count}>` — all Severe/Extreme features by event, desc, top 6.
- `parseSpcOutlook(productText) -> {headline: string|null, summary: string|null}`.

- [ ] **Step 1: Capture fixtures from the live API** (fixtures make the tests deterministic; keep them small):

```bash
curl -s "https://api.weather.gov/alerts/active?status=actual&severity=Severe,Extreme&region_type=land" \
  -H "User-Agent: Plaincast/1.0 (plaincast.live)" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps({'features': d['features'][:25]}, indent=1))" \
  > tests/fixtures/national/severe-alerts.json
curl -s "https://api.weather.gov/products/types/SWO/locations/DY1" -H "User-Agent: Plaincast/1.0 (plaincast.live)" \
  | python3 -c "
import json,sys,urllib.request
u=json.load(sys.stdin)['@graph'][0]['@id']
r=urllib.request.Request(u, headers={'User-Agent':'Plaincast/1.0 (plaincast.live)'})
print(json.dumps(json.load(urllib.request.urlopen(r)), indent=1))" > tests/fixtures/national/swody1.json
```

Then hand-check `severe-alerts.json` contains at least one `/warning/i` event and one non-warning (Watch) event; if not, append a synthetic feature copying a real one with `"event": "Flood Watch"`.

- [ ] **Step 2: Write the failing tests** (`tests/national.test.js`; follow the import style of `tests/afd-sections.test.js`):

```js
import { describe, test, expect } from 'bun:test';
import { officeFromAlert, groupDispatches, buildCensus, parseSpcOutlook } from '../api/_national.js';
import alerts from './fixtures/national/severe-alerts.json';
import swody1 from './fixtures/national/swody1.json';

const NAMES = { PUB: 'Pueblo', EPZ: 'El Paso', LOT: 'Chicago' };

describe('officeFromAlert', () => {
    test('extracts last-3 office code from AWIPSidentifier', () => {
        expect(officeFromAlert({ parameters: { AWIPSidentifier: ['SVRPUB'] } })).toBe('PUB');
    });
    test('null on missing/short/garbage identifier', () => {
        expect(officeFromAlert({})).toBeNull();
        expect(officeFromAlert({ parameters: { AWIPSidentifier: ['AB'] } })).toBeNull();
        expect(officeFromAlert({ parameters: { AWIPSidentifier: ['SVR12$'] } })).toBeNull();
    });
});

describe('groupDispatches', () => {
    test('warnings only, one row per office, worst first, count aggregated', () => {
        const feats = [
            f('Severe Thunderstorm Warning', 'Severe', 'SVRPUB'),
            f('Severe Thunderstorm Warning', 'Severe', 'SVRPUB'),
            f('Tornado Warning', 'Extreme', 'TORLOT'),
            f('Flood Watch', 'Severe', 'FFAEPZ'), // watch: excluded
        ];
        const rows = groupDispatches(feats, NAMES);
        expect(rows[0]).toEqual({ code: 'LOT', city: 'Chicago', event: 'Tornado Warning', count: 1, extreme: true });
        expect(rows[1]).toEqual({ code: 'PUB', city: 'Pueblo', event: 'Severe Thunderstorm Warning', count: 2, extreme: false });
        expect(rows.length).toBe(2);
    });
    test('uncovered office keeps its dispatch with city null', () => {
        const rows = groupDispatches([f('Severe Thunderstorm Warning', 'Severe', 'SVRCYS')], NAMES);
        expect(rows[0].code).toBe('CYS');
        expect(rows[0].city).toBeNull();
    });
    test('live fixture produces rows without throwing', () => {
        expect(Array.isArray(groupDispatches(alerts.features, NAMES))).toBe(true);
    });
});

describe('buildCensus', () => {
    test('counts by event desc, capped at 6 classes', () => {
        const feats = ['A','A','A','B','B','C','D','E','F','G'].map(e => f(e, 'Severe', 'XXXLOT'));
        const rows = buildCensus(feats);
        expect(rows[0]).toEqual({ event: 'A', count: 3 });
        expect(rows.length).toBe(6);
    });
});

describe('parseSpcOutlook', () => {
    test('extracts headline and summary from live fixture', () => {
        const { headline, summary } = parseSpcOutlook(swody1.productText);
        expect(headline).toMatch(/risk/i);
        expect(summary.length).toBeGreaterThan(80);
        expect(summary).not.toMatch(/\.\.\.SUMMARY\.\.\./);
    });
    test('null-safe on garbage', () => {
        expect(parseSpcOutlook('')).toEqual({ headline: null, summary: null });
        expect(parseSpcOutlook('no structure here')).toEqual({ headline: null, summary: null });
    });
});

function f(event, severity, awips) {
    return { properties: { event, severity, parameters: { AWIPSidentifier: [awips] } } };
}
```

- [ ] **Step 3: Run to verify failure** — `bun test tests/national.test.js` → FAIL (module not found).

- [ ] **Step 4: Implement `api/_national.js`:**

```js
// Pure logic for the National Desk. No I/O here — fetchers live in _utils.js,
// rendering in national-desk.js — so every branch is unit-testable.

// Office code = last 3 chars of the AWIPS identifier (e.g. SVRPUB -> PUB).
// Verified against the live feed 2026-08-15; senderName is NOT parseable
// ("NWS El Paso Tx/Santa Teresa NM" has no code in it).
export function officeFromAlert(props) {
    const awips = props?.parameters?.AWIPSidentifier;
    const id = Array.isArray(awips) ? String(awips[0] || '') : '';
    const code = id.slice(-3);
    return /^[A-Z]{3}$/.test(code) && id.length >= 6 ? code : null;
}

// One Wire row per office under an active Severe/Extreme *Warning*.
// Worst first: any Extreme outranks all Severe; ties break on count desc.
// The leading event for an office is its worst warning (extreme beats
// severe), first-seen on ties — the feed is already newest-first.
export function groupDispatches(features, officeNames) {
    const byOffice = new Map();
    for (const feat of features || []) {
        const p = feat?.properties || {};
        if (!/warning/i.test(p.event || '')) continue;
        const code = officeFromAlert(p);
        if (!code) continue;
        const extreme = /extreme/i.test(p.severity || '');
        const row = byOffice.get(code);
        if (!row) {
            byOffice.set(code, {
                code,
                city: officeNames[code] || null,
                event: p.event,
                count: 1,
                extreme,
            });
        } else {
            row.count += 1;
            if (extreme && !row.extreme) {
                row.extreme = true;
                row.event = p.event;
            }
        }
    }
    return [...byOffice.values()].sort((a, b) =>
        (b.extreme - a.extreme) || (b.count - a.count) || a.code.localeCompare(b.code));
}

const CENSUS_MAX = 6;

// Event-class counts across the whole Severe/Extreme feed (warnings AND
// watches — the census reports the sky, the Wire reports the offices).
export function buildCensus(features) {
    const counts = new Map();
    for (const feat of features || []) {
        const event = feat?.properties?.event;
        if (!event) continue;
        counts.set(event, (counts.get(event) || 0) + 1);
    }
    return [...counts.entries()]
        .map(([event, count]) => ({ event, count }))
        .sort((a, b) => (b.count - a.count) || a.event.localeCompare(b.event))
        .slice(0, CENSUS_MAX);
}

// SPC Day 1 Convective Outlook shape (verified live 2026-08-15):
//   ...THERE IS A SLIGHT RISK OF SEVERE THUNDERSTORMS PORTIONS OF...
//   ...SUMMARY...
//   <prose paragraph(s)>
//   ...<NEXT SECTION>...
export function parseSpcOutlook(productText) {
    const text = String(productText || '');
    const headlineMatch = text.match(/^\.\.\.(THERE IS [^.].*?)\.\.\.\s*$/ims);
    const headline = headlineMatch
        ? headlineMatch[1].replace(/\s+/g, ' ').trim()
        : null;
    const summaryMatch = text.match(/\.\.\.SUMMARY\.\.\.\s*\n([\s\S]*?)(?=\n\s*\.\.\.|\n\s*\$\$|$)/i);
    const summary = summaryMatch
        ? summaryMatch[1].replace(/\s+/g, ' ').trim() || null
        : null;
    return { headline, summary };
}
```

- [ ] **Step 5: Run** — `bun test tests/national.test.js` → PASS. Note: the headline regex spans lines (`...THERE IS A SLIGHT RISK OF SEVERE THUNDERSTORMS PORTIONS OF THE\nOHIO VALLEY...` wraps); if the fixture headline wraps and the test fails, the fix is in the regex (use `[\s\S]*?` between `THERE IS` and the closing `...`), not the test.

- [ ] **Step 6: Commit** — `git add api/_national.js tests/national.test.js tests/fixtures/national/ && git commit -m "feat(national): pure logic — office extraction, wire grouping, census, SPC parse"`

---

### Task 2: NWS fetchers in `api/_utils.js`

**Files:**
- Modify: `api/_utils.js` (append after `fetchAlertById`)
- Test: extend `tests/national.test.js`

**Interfaces (Produces):**
- `fetchSevereAlerts({signal}) -> Feature[]` (GeoJSON features array)
- `fetchAlertTotals({signal}) -> {total:number}|null`
- `fetchSpcDy1({signal}) -> {productText, issuanceTime}|null` (latest product, fully fetched)

- [ ] **Step 1: Write failing tests** (mock `fetch` the way `tests/api-office-page.test.js` does — read that file's mocking approach first and mirror it):

```js
import { fetchSevereAlerts, fetchAlertTotals, fetchSpcDy1 } from '../api/_utils.js';

describe('national fetchers', () => {
    test('fetchSevereAlerts hits the exact verified query and unwraps features', async () => {
        let seen;
        globalThis.fetch = async (url) => {
            seen = String(url);
            return new Response(JSON.stringify({ features: [{ properties: { event: 'X' } }] }), { status: 200 });
        };
        const feats = await fetchSevereAlerts({});
        expect(seen).toBe('https://api.weather.gov/alerts/active?status=actual&severity=Severe,Extreme&region_type=land');
        expect(feats.length).toBe(1);
    });
    test('fetchSpcDy1 follows @graph[0]["@id"] and returns text+issuance', async () => {
        globalThis.fetch = async (url) => {
            if (String(url).includes('/products/types/SWO/locations/DY1')) {
                return new Response(JSON.stringify({ '@graph': [{ '@id': 'https://api.weather.gov/products/abc' }] }), { status: 200 });
            }
            return new Response(JSON.stringify({ productText: 'TEXT', issuanceTime: '2026-08-15T19:42:00+00:00' }), { status: 200 });
        };
        const out = await fetchSpcDy1({});
        expect(out.productText).toBe('TEXT');
        expect(out.issuanceTime).toContain('2026');
    });
    test('fetchAlertTotals returns null on non-OK (soft data)', async () => {
        globalThis.fetch = async () => new Response('nope', { status: 503 });
        expect(await fetchAlertTotals({})).toBeNull();
    });
});
```

(Save/restore the original `globalThis.fetch` in `beforeEach`/`afterEach`, matching the existing test files' pattern.)

- [ ] **Step 2: Run to verify failure** — `bun test tests/national.test.js` → FAIL.

- [ ] **Step 3: Implement** (append to `api/_utils.js`, reusing `NWS_USER_AGENT`):

```js
// National Severe/Extreme feed. `limit` is not a valid param on this
// endpoint (verified 2026-08-15) — callers slice.
export async function fetchSevereAlerts({ signal } = {}) {
    const res = await fetch('https://api.weather.gov/alerts/active?status=actual&severity=Severe,Extreme&region_type=land', {
        headers: { 'User-Agent': NWS_USER_AGENT }, signal
    });
    if (!res.ok) throw new Error(`NWS API error: ${res.status}`);
    const data = await res.json();
    return Array.isArray(data?.features) ? data.features : [];
}

// Nationwide total (all severities). Grouped by state upstream, so only
// `total` is usable — event classes come from fetchSevereAlerts. Soft: null
// on any failure, the census renders without the total.
export async function fetchAlertTotals({ signal } = {}) {
    try {
        const res = await fetch('https://api.weather.gov/alerts/active/count', {
            headers: { 'User-Agent': NWS_USER_AGENT }, signal
        });
        if (!res.ok) return null;
        const data = await res.json();
        return Number.isFinite(data?.total) ? { total: data.total } : null;
    } catch { return null; }
}

// Latest SPC Day 1 Convective Outlook, listing + product in two hops.
export async function fetchSpcDy1({ signal } = {}) {
    const res = await fetch('https://api.weather.gov/products/types/SWO/locations/DY1', {
        headers: { 'User-Agent': NWS_USER_AGENT }, signal
    });
    if (!res.ok) throw new Error(`NWS API error: ${res.status}`);
    const data = await res.json();
    const url = productUrlFromItem((data?.['@graph'] || [])[0]);
    if (!url) return null;
    const prod = await fetchAFDProduct(url, { signal });
    const productText = typeof prod?.productText === 'string' ? prod.productText : null;
    return productText ? { productText, issuanceTime: prod?.issuanceTime || null } : null;
}
```

- [ ] **Step 4: Run** — `bun test tests/national.test.js` → PASS; then full suite `bun test tests/` → all green (guards against fetch-mock leakage).

- [ ] **Step 5: Commit** — `git commit -am "feat(national): NWS fetchers for severe feed, totals, SPC Day-1"`

---

### Task 3: Baked shell `docs/national/index.html` + styles + deploy config

**Files:**
- Create: `docs/national/index.html`
- Modify: `docs/styles.css` (append), `.vercelignore`, `vercel.json`
- Test: extend `tests/national.test.js` (shell integrity block)

**Interfaces (Produces):** The shell contains, verbatim, the SSR markers the Task 4 handler replaces:
- `<div class="loading" id="desk-loading">Setting the type…</div>` (main content marker)
- `<p class="local-desk" id="local-desk" hidden></p>` (client-side slot)
- `<script type="module" src="/js/national.js" defer></script>`

- [ ] **Step 1: Write failing shell-integrity tests** (extend `tests/national.test.js`; model on `tests/seo-pages.test.js` which reads committed files with `readFileSync`):

```js
import { readFileSync } from 'node:fs';
import { OFFICE_NAMES } from '../docs/js/offices.js';

describe('national shell', () => {
    const shell = readFileSync('docs/national/index.html', 'utf8');
    test('carries the SSR marker and local-desk slot', () => {
        expect(shell).toContain('<div class="loading" id="desk-loading">Setting the type…</div>');
        expect(shell).toContain('id="local-desk"');
        expect(shell).toContain('src="/js/national.js"');
    });
    test('links every covered office in the desk index', () => {
        for (const code of Object.keys(OFFICE_NAMES)) {
            expect(shell).toContain(`href="/o/${code}/"`);
        }
    });
    test('self-canonical, absolute assets, static OG card', () => {
        expect(shell).toContain('<link rel="canonical" href="https://plaincast.live/national/">');
        expect(shell).toContain('href="/styles.css"');
        expect(shell).toContain('content="https://plaincast.live/og-image.png"');
    });
    test('is excluded from deployment', () => {
        expect(readFileSync('.vercelignore', 'utf8')).toMatch(/^docs\/national$/m);
    });
});
```

- [ ] **Step 2: Run to verify failure** — `bun test tests/national.test.js` → FAIL (no such file).

- [ ] **Step 3: Author the shell.** Start from `docs/index.html`'s `<head>` (copy the meta/font/preload block, keep the static `og-image.png` card) and adapt:
  - `<title>The National Desk · Plaincast</title>`; description: `Where the weather is today — the national front page of Plaincast. The SPC outlook in plain English, and every forecast office under a severe warning.`; canonical + `og:url` → `https://plaincast.live/national/`; all asset paths absolute (`/styles.css`, `/js/theme-init.js`, `/fonts/...`).
  - Drop from the copied head: office-scoped modulepreloads (`glossary.js`, `abbreviations.js`, `diff.js`, `timeline.js`), the RSS discovery link, the manifest link. Keep `theme-init.js`, fonts, insights scripts.
  - Body, in the Dispatch grammar (reuse classes; new classes only where listed in Step 4):

```html
<a class="skip-link" href="#desk">Skip to the desk</a>
<header class="masthead header">
    <div class="wrap masthead-inner">
        <div class="folio folio-left" id="folio-date"></div>
        <div class="nameplate-block">
            <h1 class="nameplate">Plaincast</h1>
        </div>
        <div class="folio folio-right">The National Desk</div>
        <p class="motto">What the forecast actually says</p>
        <div class="rule-double" role="presentation"></div>
        <p class="dateline">
            <span class="dateline-city">UNITED STATES</span>
            <span class="dateline-sep" aria-hidden="true">·</span>
            <span class="dateline-date">Convective Outlook &amp; Severe Wire</span>
        </p>
    </div>
</header>
<main class="sheet wrap" id="desk">
    <p class="local-desk" id="local-desk" hidden></p>
    <div class="loading" id="desk-loading">Setting the type…</div>
    <nav class="office-index" aria-label="All Plaincast forecast offices">
        <div class="wrap office-index-inner">
            <div class="office-index-rule" role="presentation"></div>
            <h2 class="office-index-label">The forecast, office by office</h2>
            <ul class="office-index-list">
                <!-- one <li><a href="/o/CODE/">City (CODE)</a></li> per OFFICE_NAMES
                     entry — copy the exact list markup from docs/index.html:395+ -->
            </ul>
        </div>
    </nav>
</main>
```

  Plus the colophon block copied from `docs/index.html` (keep `❧`; drop the "Earlier editions" control — it is office-scoped). The `folio-date` stays empty until JS fills it (national.js sets today's date; static shell shows nothing, which is fine typographically). The office list comes verbatim from the homepage's `office-index-list` markup so the sync test passes.

- [ ] **Step 4: Styles.** Append to `docs/styles.css` (use existing custom properties only — `--ink`, `--rubric`, `--newsprint`, `--control-line`, `--text-muted`; hairlines match the `.ledger` treatment):

```css
/* ── The National Desk ─────────────────────────────────────────── */
.desk-lede { margin: 2rem 0 2.5rem; text-align: center; }
.desk-kicker { font-family: 'DM Sans', sans-serif; text-transform: uppercase; letter-spacing: .14em; font-size: .78rem; color: var(--rubric); }
.desk-deck { font-family: Fraunces, serif; font-variation-settings: 'opsz' 40; font-size: clamp(1.3rem, 3vw, 1.8rem); line-height: 1.35; margin: .6rem auto 0; max-width: 42ch; }
.desk-attrib { color: var(--text-muted); font-size: .85rem; margin-top: .6rem; font-style: italic; }
.wire { border-top: 2px solid var(--ink); margin-top: 2.5rem; }
.wire-label { font-family: 'DM Sans', sans-serif; text-transform: uppercase; letter-spacing: .14em; font-size: .78rem; padding: .5rem 0; border-bottom: 1px solid var(--control-line); }
.wire-list { list-style: none; margin: 0; padding: 0; }
.wire-item { display: flex; justify-content: space-between; gap: 1rem; padding: .55rem 0; border-bottom: 1px solid var(--control-line); font-variant-numeric: oldstyle-nums; }
.wire-item .wire-event { color: var(--text-muted); text-align: right; }
.wire-item.wire-extreme .wire-event { color: var(--rubric); font-style: italic; }
.wire-more { color: var(--text-muted); font-size: .85rem; padding: .55rem 0; }
.census { margin: 2.5rem 0; }
.local-desk { border: 1px solid var(--control-line); padding: .6rem .9rem; font-size: .9rem; margin: 1.2rem 0; }
```

The census strip itself reuses `<dl class="ledger">` markup — no new census layout CSS beyond the wrapper margin.

- [ ] **Step 5: Deploy config.** `.vercelignore`: append `docs/national` (own line, with a one-line comment mirroring the `docs/o` rationale). `vercel.json`: add to `rewrites` (BEFORE the `/o/:code` entries to keep related rules grouped is not required — order among non-overlapping sources doesn't matter, append is fine):

```json
{ "source": "/national", "destination": "/api/national-desk" },
{ "source": "/national/", "destination": "/api/national-desk" }
```

and to `functions`:

```json
"api/national-desk.js": { "includeFiles": "docs/national/index.html" }
```

- [ ] **Step 6: Run** — `bun test tests/national.test.js` → PASS; `bun test tests/` (csp.test.js and sw.test.js must stay green — if sw.test.js asserts a precache manifest, `/national/` is NOT precached; do not add it).

- [ ] **Step 7: Commit** — `git commit -am "feat(national): baked shell, Dispatch styles, rewrites + deploy exclusion"`

---

### Task 4: SSR handler `api/national-desk.js`

**Files:**
- Create: `api/national-desk.js`
- Test: `tests/api-national-desk.test.js`

**Interfaces:**
- Consumes: Task 1 logic (`groupDispatches`, `buildCensus`, `parseSpcOutlook`), Task 2 fetchers, Task 3 shell + markers, `escHtml` and `regexTranslate` from existing modules.
- Produces: exported pure builders for tests — `buildLedeHtml({headline, summary, issuanceTime})`, `buildWireHtml(rows)`, `buildCensusHtml(census, totals)`, plus the default handler.

**Read `api/office-page.js` in full before writing — this file is its sibling and must match it beat for beat:** lazy `loadTemplate()` with the two-candidate path list (swap in `docs/national/index.html`), the `LOADING_DIV`-style marker constant (`<div class="loading" id="desk-loading">Setting the type…</div>`), the baked-floor-first structure, `res.status(200).send(baked)` fallback with `s-maxage=300`, success `s-maxage=600, stale-while-revalidate=1800`, GET/HEAD only, and the `.replace(MARKER, () => ssr)` replacer-function guard against `$`-sequences.

- [ ] **Step 1: Write failing tests** (`tests/api-national-desk.test.js`; mirror `tests/api-office-page.test.js`'s handler-test mechanics — mock req/res and `globalThis.fetch`):

```js
import { describe, test, expect } from 'bun:test';
import { buildLedeHtml, buildWireHtml, buildCensusHtml } from '../api/national-desk.js';

describe('buildLedeHtml', () => {
    test('kicker from headline, deck from regex-translated summary, ai-deck slot present', () => {
        const html = buildLedeHtml({ headline: 'THERE IS A SLIGHT RISK OF SEVERE THUNDERSTORMS', summary: 'Storms tonight.', issuanceTime: '2026-08-15T19:42:00+00:00' });
        expect(html).toContain('desk-kicker');
        expect(html).toContain('id="desk-deck"');
        expect(html).toContain('Storms tonight.');
        expect(html).toContain('Storm Prediction Center');
    });
    test('escapes HTML in upstream text', () => {
        const html = buildLedeHtml({ headline: '<img src=x>', summary: 'a & b <script>', issuanceTime: null });
        expect(html).not.toContain('<img');
        expect(html).not.toContain('<script>');
    });
    test('throws when summary missing (handler falls back to baked)', () => {
        expect(() => buildLedeHtml({ headline: null, summary: null, issuanceTime: null })).toThrow();
    });
});

describe('buildWireHtml', () => {
    const row = (over) => ({ code: 'LOT', city: 'Chicago', event: 'Tornado Warning', count: 2, extreme: true, ...over });
    test('covered office links to its desk; uncovered renders unlinked', () => {
        const html = buildWireHtml([row(), row({ code: 'CYS', city: null, extreme: false })]);
        expect(html).toContain('href="/o/LOT/"');
        expect(html).not.toContain('href="/o/CYS/"');
        expect(html).toContain('CYS');
    });
    test('caps at 12 with an "and N more" line', () => {
        const rows = Array.from({ length: 15 }, (_, i) => row({ code: 'A' + String(i).padStart(2, '0'), city: null }));
        const html = buildWireHtml(rows);
        expect((html.match(/wire-item/g) || []).length).toBeLessThanOrEqual(13); // 12 + class in "more" line never uses wire-item
        expect(html).toContain('3 more offices');
    });
    test('empty wire renders the quiet line, not nothing', () => {
        expect(buildWireHtml([])).toContain('No office is under a severe warning');
    });
});

describe('buildCensusHtml', () => {
    test('ledger markup with event counts and optional national total', () => {
        const html = buildCensusHtml([{ event: 'Flood Warning', count: 62 }], { total: 445 });
        expect(html).toContain('ledger');
        expect(html).toContain('Flood Warning');
        expect(html).toContain('62');
        expect(html).toContain('445');
    });
    test('total omitted when totals null', () => {
        expect(buildCensusHtml([{ event: 'X', count: 1 }], null)).not.toContain('active products nationwide');
    });
});
```

Plus two handler-level tests copied structurally from `api-office-page.test.js`: (a) all fetchers throwing → response is exactly the baked shell with `s-maxage=300`; (b) happy path (fetch mocked with the Task 1 fixtures) → response contains `desk-lede`, `wire`, and no `id="desk-loading"` marker.

- [ ] **Step 2: Run to verify failure** — `bun test tests/api-national-desk.test.js` → FAIL.

- [ ] **Step 3: Implement.** Skeleton (the office-page.js conventions fill the gaps — lazy template, candidates list, GET/HEAD guard):

```js
import { OFFICE_NAMES } from '../docs/js/offices.js';
import { escHtml } from '../scripts/build-offices.mjs';
import { fetchSevereAlerts, fetchAlertTotals, fetchSpcDy1 } from './_utils.js';
import { regexTranslate } from './_afd-sections.js';
import { groupDispatches, buildCensus, parseSpcOutlook } from './_national.js';

const MARKER = '<div class="loading" id="desk-loading">Setting the type…</div>';
const WIRE_MAX = 12;

export function buildLedeHtml({ headline, summary, issuanceTime }) {
    if (!summary) throw new Error('national-desk: no outlook summary');
    const kicker = headline ? sentenceCaseHeadline(headline) : 'The national outlook';
    const issued = issuanceTime ? ` · issued ${escHtml(formatIssuedUtc(issuanceTime))}` : '';
    return `
        <section class="desk-lede">
            <p class="desk-kicker">${escHtml(kicker)}</p>
            <p class="desk-deck" id="desk-deck">${escHtml(regexTranslate(summary))}</p>
            <p class="desk-attrib">From the Storm Prediction Center's Day 1 Convective Outlook${issued}.</p>
        </section>`;
}

export function buildWireHtml(rows) {
    const shown = rows.slice(0, WIRE_MAX);
    const items = shown.map(r => {
        const name = r.city
            ? `<a href="/o/${escHtml(r.code)}/">${escHtml(r.city)} (${escHtml(r.code)})</a>`
            : `${escHtml(r.code)}`;
        const count = r.count > 1 ? ` ×${r.count}` : '';
        return `            <li class="wire-item${r.extreme ? ' wire-extreme' : ''}"><span class="wire-office">${name}</span><span class="wire-event">${escHtml(r.event)}${count}</span></li>`;
    });
    const more = rows.length > shown.length
        ? `        <p class="wire-more">…and ${rows.length - shown.length} more offices under severe warnings.</p>\n` : '';
    const body = items.length
        ? `        <ul class="wire-list">\n${items.join('\n')}\n        </ul>\n${more}`
        : `        <p class="wire-more">No office is under a severe warning right now — a quiet wire is good news.</p>\n`;
    return `\n        <section class="wire" aria-label="Offices under severe warnings">\n` +
        `        <h2 class="wire-label">The Wire · severe warnings by forecast office</h2>\n${body}        </section>`;
}

export function buildCensusHtml(census, totals) {
    const cells = census.map(c =>
        `            <div class="ledger-cell"><dt>${escHtml(c.event)}</dt><dd>${c.count}</dd></div>`);
    const totalLine = totals?.total
        ? `        <p class="wire-more">${totals.total} active products nationwide, all severities.</p>\n` : '';
    return `\n        <section class="census" aria-label="Active severe alert census">\n` +
        `        <dl class="ledger">\n${cells.join('\n')}\n        </dl>\n${totalLine}        </section>`;
}
```

(`sentenceCaseHeadline` lowercases the SPC all-caps headline and uppercases the first letter — small local helper, unit-tested via `buildLedeHtml`'s kicker output. `formatIssuedUtc` mirrors office-page's `formatIssued` with `timeZone: 'UTC'` — wait, no: use `'America/Chicago'`? No. The outlook is national; render the issuance in UTC with a `Z`-suffix label, e.g. `1942 UTC` — SPC's own convention. Implement exactly: `new Date(iso)` → `HHMM UTC` via `toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })` + `' UTC'`.) Check `.ledger`'s actual cell markup in `docs/index.html`/`app.js` before finalizing `buildCensusHtml` — the class names above must match what `.ledger` styles expect (adjust `ledger-cell`/`dt`/`dd` structure to the real one).

Handler flow (structure identical to office-page.js `handler`): load+hold baked shell first; `Promise.all` the three fetchers with `AbortSignal.timeout(8000)` each (`fetchAlertTotals` is already soft); assemble `ssr = lede + wire + census`; verify `baked.includes(MARKER)`; success → 600/1800 cache; any throw → baked, 300.

- [ ] **Step 4: Run** — `bun test tests/api-national-desk.test.js` → PASS, then full suite.

- [ ] **Step 5: Commit** — `git commit -am "feat(national): SSR handler — lede, wire, census with baked fail-safe"`

---

### Task 5: `api/whereami.js`

**Files:**
- Create: `api/whereami.js`
- Test: `tests/api-whereami.test.js`

**Interfaces (Produces):** `GET /api/whereami` → `200 {office, city}` (covered offices only) | `204` (unknown location/office). Always `Cache-Control: no-store` (geo answers must NEVER enter any shared cache — this is the whole reason the endpoint exists; see SPEC geolocation section).

- [ ] **Step 1: Failing tests:**

```js
import { describe, test, expect } from 'bun:test';
import handler from '../api/whereami.js';

function mockRes() {
    const res = { headers: {}, code: null, body: null };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.status = (c) => { res.code = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.send = (b) => { res.body = b; return res; };
    res.end = () => res;
    return res;
}

describe('whereami', () => {
    test('missing geo headers -> 204 no-store', async () => {
        const res = mockRes();
        await handler({ method: 'GET', headers: {} }, res);
        expect(res.code).toBe(204);
        expect(res.headers['cache-control']).toBe('no-store');
    });
    test('valid headers -> resolves gridId via points API, covered office -> 200', async () => {
        globalThis.fetch = async (url) => {
            expect(String(url)).toBe('https://api.weather.gov/points/41.8781,-87.6298');
            return new Response(JSON.stringify({ properties: { gridId: 'LOT' } }), { status: 200 });
        };
        const res = mockRes();
        await handler({ method: 'GET', headers: { 'x-vercel-ip-latitude': '41.8781', 'x-vercel-ip-longitude': '-87.6298' } }, res);
        expect(res.code).toBe(200);
        expect(res.body).toEqual({ office: 'LOT', city: 'Chicago' });
        expect(res.headers['cache-control']).toBe('no-store');
    });
    test('uncovered gridId -> 204', async () => {
        globalThis.fetch = async () => new Response(JSON.stringify({ properties: { gridId: 'CYS' } }), { status: 200 });
        const res = mockRes();
        await handler({ method: 'GET', headers: { 'x-vercel-ip-latitude': '41.1', 'x-vercel-ip-longitude': '-104.8' } }, res);
        expect(res.code).toBe(204);
    });
    test('garbage headers -> 204 without fetching', async () => {
        globalThis.fetch = async () => { throw new Error('must not fetch'); };
        const res = mockRes();
        await handler({ method: 'GET', headers: { 'x-vercel-ip-latitude': 'abc', 'x-vercel-ip-longitude': '1e99' } }, res);
        expect(res.code).toBe(204);
    });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement:**

```js
// Client-side geolocation helper for the National Desk. The desk page itself
// is CDN-cached and geo-agnostic (a server-rendered pointer would bake the
// first visitor's city into the cached body for a whole edge region), so the
// pointer is fetched from here with no-store. IP-level only — no permission
// prompt, no client input trusted: coordinates come from Vercel's headers.
import { OFFICE_NAMES } from '../docs/js/offices.js';

const NWS_USER_AGENT = 'Plaincast/1.0 (plaincast.live)';

function coord(raw, min, max) {
    const n = Number.parseFloat(String(raw || ''));
    return Number.isFinite(n) && n >= min && n <= max ? n.toFixed(4) : null;
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
    const lat = coord(req.headers['x-vercel-ip-latitude'], -90, 90);
    const lon = coord(req.headers['x-vercel-ip-longitude'], -180, 180);
    if (!lat || !lon) return res.status(204).end();
    try {
        const r = await fetch(`https://api.weather.gov/points/${lat},${lon}`, {
            headers: { 'User-Agent': NWS_USER_AGENT },
            signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) return res.status(204).end();
        const data = await r.json();
        const office = data?.properties?.gridId;
        const city = OFFICE_NAMES[office];
        if (!city) return res.status(204).end();
        return res.status(200).json({ office, city });
    } catch {
        return res.status(204).end();
    }
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -am "feat(national): whereami geo micro-endpoint (no-store)"`

---

### Task 6: AI deck endpoint `api/national-lede.js`

**Files:**
- Create: `api/national-lede.js`
- Test: `tests/api-national-lede.test.js`

**Read `api/changelog.js` in full first — this endpoint is its sibling:** same in-memory `cache` Map keyed by issuance, same `inFlight` dedup, same per-IP `checkRateLimit` block (copy it verbatim; `RATE_LIMIT_MAX = 10` here — one page load costs one call and the answer is national, not per-office), same transient-vs-verdict discipline, same soft-fail 200 shape.

**Interfaces (Produces):** `GET /api/national-lede` → `200 {deck: string|null, issued: string|null, cached: boolean}`; failures → `{deck: null, transient: true}`. **Zero query parameters are read** — the endpoint always summarizes the latest SPC Day-1 outlook.

- [ ] **Step 1: Failing tests** (mirror `tests/api-changelog-handler.test.js` mechanics — it already solves mocking `ai`'s `generateText` and the fetch layer; reuse its approach exactly):
  - happy path: mocked `fetchSpcDy1` text + mocked model reply → `{deck, issued, cached:false}`, then a second call → `cached:true` with NO second model call (assert via call counter);
  - model empty output → `{deck:null, transient:true}` and NOT cached (third call hits the model again);
  - upstream SPC fetch failure → 200 `{deck:null, transient:true}` with `s-maxage=60`;
  - query params ignored: calling with `req.query = {office: 'LOT', evil: 'x'}` produces the identical prompt (assert the prompt does not contain 'LOT').

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** Deltas from changelog.js: no office/edition resolution — `fetchSpcDy1()` is the only upstream; cache key = `issuanceTime`; parse via `parseSpcOutlook` and feed BOTH headline and summary to the model. Prompt:

```js
const system = `You rewrite the U.S. Storm Prediction Center's Day 1 Convective Outlook summary as ONE plain-English sentence (max ~35 words) for a general reader: where severe weather is expected today and what kind. Warm, concrete, no jargon, no preamble, no markdown. If the outlook is quiet nationwide, say so plainly.`;
const prompt = `HEADLINE: ${headline || '(none)'}\n\nSUMMARY:\n${summary}`;

const result = await generateText({
    model: 'anthropic/claude-haiku-4.5',
    system,
    prompt,
    maxOutputTokens: 120,
    abortSignal: AbortSignal.timeout(15000),
});
```

Cache headers: success `public, s-maxage=900, stale-while-revalidate=3600`; transient `public, s-maxage=60`. Response body field is `deck` (the client swaps it into `#desk-deck`).

- [ ] **Step 4: Run** → PASS, full suite green. **Step 5: Commit** — `git commit -am "feat(national): AI deck endpoint — per-issuance cache, zero client input"`

---

### Task 7: Client enhancement + sitewide linkage + sitemap + ship

**Files:**
- Create: `docs/js/national.js`
- Modify: `docs/index.html` (office-index footer, line ~391), `scripts/build-offices.mjs` (`renderSitemap`), regenerate `docs/o/**` + `docs/sitemap.xml`
- Test: extend `tests/national.test.js`; `tests/seo-pages.test.js` must stay green via regen

- [ ] **Step 1: Failing tests:**

```js
describe('national linkage', () => {
    test('homepage office-index links the National Desk', () => {
        const home = readFileSync('docs/index.html', 'utf8');
        expect(home).toContain('href="/national/"');
    });
    test('sitemap carries /national/', () => {
        expect(readFileSync('docs/sitemap.xml', 'utf8')).toContain('https://plaincast.live/national/</loc>');
    });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `docs/js/national.js`:**

```js
// Progressive enhancement for the National Desk. The SSR page is complete
// without any of this; every failure path is silence, never an error state.

// Today's date in the masthead folio (the shell can't bake a date — it's CDN-cached).
const folio = document.getElementById('folio-date');
if (folio) {
    folio.textContent = new Date().toLocaleDateString('en-US',
        { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// AI-polished deck: swap the regex-translated SSR deck when the model's
// version arrives. Keep the SSR text on any failure.
fetch('/api/national-lede')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
        const deck = document.getElementById('desk-deck');
        if (deck && data?.deck) {
            deck.textContent = data.deck;
            const attrib = document.querySelector('.desk-attrib');
            if (attrib && !/Simplified by AI/.test(attrib.textContent)) {
                attrib.textContent += ' Simplified by AI.';
            }
        }
    })
    .catch(() => {});

// Your Local Desk — geo pointer from the uncached endpoint.
fetch('/api/whereami')
    .then(r => (r.ok && r.status === 200) ? r.json() : null)
    .then(data => {
        const slot = document.getElementById('local-desk');
        if (!slot || !data?.office || !data?.city) return;
        const a = document.createElement('a');
        a.href = `/o/${data.office}/`;
        a.textContent = `${data.city} (${data.office})`;
        slot.append('Reading from around ', a.cloneNode(true), '? Your local desk: ');
        slot.append(a);
        slot.hidden = false;
    })
    .catch(() => {});
```

(Fix the double-append: build the sentence as `Your local desk: <a>City (CODE)</a> →` with ONE anchor — the block above shows intent; final code appends a single anchor. Test-drive the sentence assembly if extracted as a pure helper; otherwise this file stays untested DOM glue, matching how `theme-init.js` is treated.)

- [ ] **Step 4: Homepage linkage.** In `docs/index.html`'s office-index (line ~391), insert immediately after the `office-index-label` h2:

```html
        <p class="office-index-national"><a href="/national/">The National Desk — where the weather is today →</a></p>
```

with a one-rule style appended to styles.css: `.office-index-national { font-family: 'DM Sans', sans-serif; letter-spacing: .05em; margin: .4rem 0 1rem; }`.

- [ ] **Step 5: Sitemap.** In `renderSitemap` (`scripts/build-offices.mjs:111`), add after the homepage url line:

```js
    urls.push(`  <url><loc>https://plaincast.live/national/</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq><priority>0.9</priority></url>`);
```

- [ ] **Step 6: Regenerate baked artifacts** — `bun scripts/build-offices.mjs` (rewrites all 68 `docs/o/**` pages with the new office-index markup + sitemap). `git status` must show only `docs/o/**`, `docs/sitemap.xml`, and the files you edited.

- [ ] **Step 7: Full suite** — `bun test tests/` → ALL green (seo-pages.test.js validates the regen byte-for-byte).

- [ ] **Step 8: Commit** — `git commit -am "feat(national): client enhancement, sitewide linkage, sitemap"`

---

### Task 8: Live verification checklist (post-deploy, run by the orchestrator)

Not a code task — after Jonah merges (merge=deploy), verify live:
- [ ] `curl -s https://plaincast.live/national/ | grep -c 'wire-item'` ≥ 1 (or the quiet-wire line during calm weather)
- [ ] `curl -s https://plaincast.live/api/national-lede` → `{deck: "...", cached: ...}` with no chain-of-thought artifacts (Aug 1 incident check: the text must read as a single clean sentence)
- [ ] `curl -s -o /dev/null -w '%{http_code}' https://plaincast.live/api/whereami` → 200 or 204, and response headers carry `cache-control: no-store`
- [ ] `/o/LOT/` still serves SSR articles (office-page regression)
- [ ] homepage office-index shows the National Desk link
