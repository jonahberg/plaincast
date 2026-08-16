# The Composed Desk (v1.1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework `/national/` into the owner-approved C×A×E composition: census index strip, rubricated risk word, running copy from the SPC discussion, Day 1/2/3 rail, two-line Wire rows, and an outlook clock line.

**Architecture:** Pure additive evolution of the shipped v1 (commit 60a91f6, live in prod). All new logic lands in `api/_national.js` (pure) and `api/_utils.js` (one new fetcher); `api/national-desk.js` re-assembles the SSR blob in the new order; CSS extends the existing National Desk block. The shell, client JS, whereami, and national-lede endpoints are UNTOUCHED. Baked fail-safe floor unchanged.

**Tech Stack:** Vanilla JS ESM, Vercel serverless, Bun test (baseline: 407 pass).

**Spec:** `SPEC-national-desk.md` → section "## v1.1 — The Composed Desk (C × A × E)" (committed on this branch). The v1 sections above it still bind everything they cover.

## Global Constraints

- Every interpolated value through `escHtml`; no client input anywhere; the deck endpoint remains the ONLY AI call (this plan adds zero model calls); model rules unchanged.
- Page order (spec §Page order): strip → risk moment → standfirst deck (`id="desk-deck"` MUST survive — client swap depends on it) → running copy → day rail → Wire → clock → local-desk slot untouched in shell.
- De-duplication rule: deck ← SUMMARY; running copy ← post-SUMMARY discussion ONLY; fallback per spec (summary as copy + deterministic deck suppressed — never both from one source).
- Visual-review rules (spec §Visual-review): strip cells `flex:1 1 auto; text-align:center`; copy justified+hyphens only ≥640px, left below; copy opens with forecast prose; deck one size step below v1.
- Fail-safety: DY1 outlook remains hard-required (any failure → exact baked shell, `s-maxage=300`); DY2/DY3 and totals are SOFT — each rail cell independently renders "—" on failure. Missing wire row-2 fields → row 2 omitted.
- Dispatch anti-tells; reuse tokens (`--rubric`, `--rule`, `--newsprint`, `--font-*`, `--step-*` where present). Cache headers unchanged (`600/1800` success, `300` fallback).
- Bun only; TDD every task; full suite green before each commit. Never touch main; branch `claude/composed-desk`.
- Mock-shape law (learned in v1): any `mock.module('../api/_utils.js')` stub must carry ALL exports; adding an export means updating all 8 sibling stub sites (grep `mock.module('../api/_utils`).
- Commit style: house (`git log --oneline -5`); body ends `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

- `api/_national.js` — MODIFY (append): `parseRiskCategory`, `parseDiscussionBody`, `digestArea`, `formatExpiry`, `nextOutlookTime`.
- `api/_utils.js` — MODIFY: add `fetchSpcOutlook(location)`; `fetchSpcDy1` becomes a one-line delegate (export kept — national-lede.js imports it).
- `api/national-desk.js` — MODIFY: new builders `buildStripHtml`, `buildRiskHtml`, `buildCopyHtml`, `buildRailHtml`; rework `buildWireHtml` (two-line rows) and `buildLedeHtml` (deck+attrib only — kicker's job moves to the risk moment); handler re-assembly.
- `docs/styles.css` — MODIFY (extend the National Desk block).
- Tests: extend `tests/national.test.js` (pure logic), `tests/api-national-desk.test.js` (builders + handler); new fixtures `tests/fixtures/national/swody2.json`, `swody3.json`.

---

### Task 1: Pure logic — parsers, digests, clock

**Files:**
- Modify: `api/_national.js` (append), `tests/national.test.js` (append describes)
- Create: `tests/fixtures/national/swody2.json`, `tests/fixtures/national/swody3.json`

**Interfaces (Produces):**
- `parseRiskCategory(headline) -> {level: 'MARGINAL'|'SLIGHT'|'ENHANCED'|'MODERATE'|'HIGH', regions: string}|null`
- `parseDiscussionBody(productText) -> string[]` (0–3 paragraphs, post-SUMMARY only)
- `digestArea(areaDesc) -> string|null` (≤2 named areas + "…" overflow marker)
- `formatExpiry(iso, tz) -> string|null` (e.g. "until 730 PM MDT")
- `nextOutlookTime(nowIso) -> string` (e.g. "0600 UTC")

- [ ] **Step 1: Capture Day-2/3 fixtures** (same UA/shape discipline as the v1 fixtures — capture the LISTING's first product fully):

```bash
for d in DY2 DY3; do
  curl -s "https://api.weather.gov/products/types/SWO/locations/$d" -H "User-Agent: Plaincast/1.0 (plaincast.live)" \
  | python3 -c "
import json,sys,urllib.request
u=json.load(sys.stdin)['@graph'][0]['@id']
r=urllib.request.Request(u, headers={'User-Agent':'Plaincast/1.0 (plaincast.live)'})
print(json.dumps(json.load(urllib.request.urlopen(r)), indent=1))" > tests/fixtures/national/swo${d#DY*}.json 2>/dev/null || true
done
mv tests/fixtures/national/swo2.json tests/fixtures/national/swody2.json 2>/dev/null || true
mv tests/fixtures/national/swo3.json tests/fixtures/national/swody3.json 2>/dev/null || true
```

(If the shell mangling above fights you, just run the curl twice by hand with explicit output names — the point is two committed fixture files with real `productText`.) Hand-check both contain a `...` headline or a categorical risk mention; note in your report which categorical words appear. Also verify the EXISTING `tests/fixtures/national/severe-alerts.json` features carry `areaDesc` and `expires`/`ends` properties (they are full NWS alert objects, so they should) — if absent, re-capture that fixture the same way v1's Task 1 did.

- [ ] **Step 2: Failing tests** (append to `tests/national.test.js`; import the new fns from `'../api/_national.js'`):

```js
import swody2 from './fixtures/national/swody2.json';
import swody3 from './fixtures/national/swody3.json';

describe('parseRiskCategory', () => {
    test('extracts level and regions from a THERE-IS headline', () => {
        const r = parseRiskCategory('THERE IS A SLIGHT RISK OF SEVERE THUNDERSTORMS PORTIONS OF THE OHIO VALLEY AND PARTS OF THE CENTRAL HIGH PLAINS');
        expect(r.level).toBe('SLIGHT');
        expect(r.regions).toMatch(/Ohio Valley/i);
    });
    test('all five categorical words map', () => {
        for (const w of ['MARGINAL','SLIGHT','ENHANCED','MODERATE','HIGH']) {
            expect(parseRiskCategory(`THERE IS A ${w} RISK OF SEVERE THUNDERSTORMS SOMEWHERE`).level).toBe(w);
        }
    });
    test('null on no-risk / garbage headlines (calm face)', () => {
        expect(parseRiskCategory('NO SEVERE THUNDERSTORM AREAS FORECAST')).toBeNull();
        expect(parseRiskCategory(null)).toBeNull();
    });
});

describe('parseDiscussionBody', () => {
    test('returns post-SUMMARY prose only, from the live DY1 fixture', () => {
        const paras = parseDiscussionBody(swody1.productText);
        expect(paras.length).toBeGreaterThan(0);
        expect(paras.length).toBeLessThanOrEqual(3);
        const { summary } = parseSpcOutlook(swody1.productText);
        expect(paras[0]).not.toBe(summary);           // never the summary itself
        for (const p of paras) {
            expect(p).not.toMatch(/^\.\.\./);          // no section-header lines
            expect(p.length).toBeGreaterThanOrEqual(40);
        }
    });
    test('empty array when nothing follows the summary', () => {
        expect(parseDiscussionBody('...SUMMARY...\nOnly a summary here with enough length to pass filters.\n$$')).toEqual([]);
        expect(parseDiscussionBody('')).toEqual([]);
    });
});

describe('digestArea', () => {
    test('two areas + overflow marker', () => {
        expect(digestArea('Otero; Crowley; Pueblo; Las Animas')).toBe('Otero & Crowley +2 more');
        expect(digestArea('Franklin Mountains')).toBe('Franklin Mountains');
        expect(digestArea('A; B')).toBe('A & B');
        expect(digestArea('')).toBeNull();
        expect(digestArea(null)).toBeNull();
    });
});

describe('formatExpiry', () => {
    test('office-local until-time', () => {
        expect(formatExpiry('2026-08-16T01:30:00Z', 'America/Denver')).toMatch(/until 7:30 PM MDT/i);
    });
    test('null on garbage', () => {
        expect(formatExpiry('nope', 'America/Denver')).toBeNull();
        expect(formatExpiry(null, 'America/Denver')).toBeNull();
    });
});

describe('nextOutlookTime', () => {
    test('walks the fixed SPC schedule', () => {
        expect(nextOutlookTime('2026-08-16T02:00:00Z')).toBe('0600 UTC');
        expect(nextOutlookTime('2026-08-16T06:01:00Z')).toBe('1300 UTC');
        expect(nextOutlookTime('2026-08-16T23:30:00Z')).toBe('0100 UTC'); // wraps
    });
});
```

(`swody2`/`swody3` imports are used in Task 3's rail tests; importing here proves they parse as JSON.)

- [ ] **Step 3: Run to verify failure** — `bun test tests/national.test.js` → FAIL.

- [ ] **Step 4: Implement** (append to `api/_national.js`):

```js
const RISK_LEVELS = ['MARGINAL', 'SLIGHT', 'ENHANCED', 'MODERATE', 'HIGH'];

// Day-1 categorical risk from the THERE-IS headline. Regions is the prose
// after "OF SEVERE THUNDERSTORMS" (or the whole tail), title-cased lightly
// by the caller's CSS (small caps), so we just trim connective noise.
export function parseRiskCategory(headline) {
    const text = String(headline || '');
    const m = text.match(/THERE IS AN? (MARGINAL|SLIGHT|ENHANCED|MODERATE|HIGH) RISK OF SEVERE THUNDERSTORMS\s*(.*)$/i);
    if (!m) return null;
    const level = m[1].toUpperCase();
    if (!RISK_LEVELS.includes(level)) return null;
    const regions = m[2]
        .replace(/^(ACROSS|FOR|OVER|PORTIONS OF|PARTS OF)\s+/i, '')
        .replace(/\s+/g, ' ')
        .trim();
    return { level, regions };
}

const HEADER_LINE = /^\s*\.\.\./;

// Narrative paragraphs AFTER the ...SUMMARY... block — the standfirst already
// covers the summary, so the running copy must never repeat it (spec §5).
export function parseDiscussionBody(productText) {
    const text = String(productText || '');
    const sumIdx = text.search(/\.\.\.SUMMARY\.\.\./i);
    if (sumIdx === -1) return [];
    const after = text.slice(sumIdx);
    // The summary may span multiple paragraphs; the reliable cut point is the
    // next ...SECTION... header line after SUMMARY — body prose starts there.
    const lines = after.split('\n');
    let bodyStart = -1;
    for (let i = 1; i < lines.length; i++) {
        if (HEADER_LINE.test(lines[i])) { bodyStart = i; break; }
    }
    if (bodyStart === -1) return [];
    const body = lines.slice(bodyStart).join('\n');
    return body
        .split(/\n\s*\n+/)
        .map(p => p.split('\n')
            .filter(l => !HEADER_LINE.test(l) && !/^\s*\$\$|^\s*&&/.test(l))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim())
        .filter(p => p.length >= 40 && !/^(ATTN|\.\.\.)/.test(p))
        .slice(0, 3);
}

// areaDesc digest: NWS separates areas with ';'. Two names + overflow count.
export function digestArea(areaDesc) {
    const parts = String(areaDesc || '').split(';').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    const head = `${parts[0]} & ${parts[1]}`;
    return parts.length > 2 ? `${head} +${parts.length - 2} more` : head;
}

export function formatExpiry(iso, tz) {
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return null;
        const t = d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' });
        return `until ${t}`;
    } catch { return null; }
}

// Fixed SPC Day-1 issuance slots (UTC). Next slot strictly after `nowIso`.
const SPC_SLOTS = [1, 6, 13, 16.5, 20]; // 0100, 0600, 1300, 1630, 2000 UTC
export function nextOutlookTime(nowIso) {
    const d = new Date(nowIso);
    const nowH = d.getUTCHours() + d.getUTCMinutes() / 60;
    const next = SPC_SLOTS.find(s => s > nowH) ?? SPC_SLOTS[0];
    const h = Math.floor(next), m = Math.round((next - h) * 60);
    return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')} UTC`;
}
```

NOTE on `parseDiscussionBody`: the algorithm above (cut at the first header line after SUMMARY) is the intent; the live fixture is the authority. If the fixture's structure defeats it (e.g. no header between summary and body), adjust the implementation until the fixture-driven test passes honestly — do NOT weaken the test's "never the summary" and "no header lines" assertions.

ALSO in this task (moved here so each file has one owner): `groupDispatches` rows gain two RAW passthrough fields captured from each office's LEADING warning — `areaDesc: props.areaDesc || null` and `expires: props.expires || props.ends || null`. Signature unchanged, no formatting here (Task 3 renders them via `digestArea`/`formatExpiry`). Update the existing v1 `groupDispatches` assertions to the new shape (switch `toEqual` to `toMatchObject`, or extend the expected objects) — this is a contract rework, not a test weakening; the code/city/event/count/extreme expectations must keep passing unchanged.

- [ ] **Step 5: Run** — `bun test tests/national.test.js` → PASS; full suite green.
- [ ] **Step 6: Commit** — `feat(national): v1.1 pure logic — risk parser, discussion body, area/expiry digests, outlook clock`

---

### Task 2: `fetchSpcOutlook(location)` in `api/_utils.js`

**Files:**
- Modify: `api/_utils.js`, `tests/national.test.js` (append), all 8 files matching `mock.module('../api/_utils` (add the new key)

**Interfaces (Produces):** `fetchSpcOutlook(location, {signal}) -> {productText, issuanceTime}|null` where location ∈ DY1|DY2|DY3 (validated; anything else throws). `fetchSpcDy1({signal})` keeps its exact contract as a delegate.

- [ ] **Step 1: Failing tests:** (a) `fetchSpcOutlook('DY2', {})` hits `https://api.weather.gov/products/types/SWO/locations/DY2` and unwraps like the DY1 test from v1; (b) `fetchSpcOutlook('EVIL', {})` rejects without fetching (mock fetch throws if called); (c) `fetchSpcDy1({})` still resolves through the new path (same mock as v1's test).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement:** generalize the v1 `fetchSpcDy1` body into `fetchSpcOutlook(location, {signal})` with `if (!/^DY[123]$/.test(location)) throw new Error('bad outlook location')` up front; `fetchSpcDy1 = ({signal} = {}) => fetchSpcOutlook('DY1', {signal})`. Then grep `mock.module('../api/_utils` and add `fetchSpcOutlook: async () => null` (or the file's stub idiom) to ALL 8 stub sites — same reasoning comment as v1.
- [ ] **Step 4: Run full suite** (mock-shape law makes this the load-bearing check) → all green.
- [ ] **Step 5: Commit** — `feat(national): parameterized SPC outlook fetcher (DY1/2/3)`

---

### Task 3: Builders + handler re-assembly in `api/national-desk.js`

**Files:**
- Modify: `api/national-desk.js`, `tests/api-national-desk.test.js`

**Interfaces:**
- Consumes: everything Tasks 1–2 produce; `OFFICE_TIMEZONES` from `docs/js/offices.js` (for wire expiry); existing `escHtml`/`regexTranslate`.
- Produces (exported for tests): `buildStripHtml(census, totals, quiet)`, `buildRiskHtml(risk)`, `buildCopyHtml(paragraphs)`, `buildRailHtml(rails)` where `rails = [{label, level|null, note|null}, ×3]`, reworked `buildWireHtml(rows)` (rows gain optional `area`, `until` strings), reworked `buildLedeHtml` → deck+attrib only (kicker removed — the risk moment replaces it).

**Read the CURRENT `api/national-desk.js` in full first.** The v1.1 diff must preserve: the marker replacement mechanics, GET/HEAD guard, baked-floor structure, cache headers, `id="desk-deck"`, and all escaping discipline. The SSR assembly order becomes: strip → risk → deck/attrib → copy → rail → wire → clock.

Handler data flow (implement exactly):
- `Promise.all` stays for the HARD requirements: DY1 product + severe alerts feed (both throw → baked).
- SOFT parallel set via `Promise.allSettled`: `fetchAlertTotals`, `fetchSpcOutlook('DY2')`, `fetchSpcOutlook('DY3')` — each failure yields its cell's null.
- `quiet = 68 - dispatches-with-city-count`... NO: quiet = total covered desks minus covered desks present in the wire — compute as `Object.keys(OFFICE_NAMES).length - new Set(rows.filter(r => r.city).map(r => r.code)).size`.
- Rail: Day 1 level from `parseRiskCategory(headline)`; Day 2/3 from each fetched product's own parsed headline; note strings are the parsed `regions` (truncated ~60 chars); null level → `—` + spec's no-risk note.
- Wire rows: Task 1 already gave `groupDispatches` rows raw `areaDesc`/`expires` fields; this task renders them — `area = digestArea(row.areaDesc)`, `until = formatExpiry(row.expires, OFFICE_TIMEZONES[row.code])` — at build time in `buildWireHtml`. Row 2 omitted when both are null.
- v1 test rework authorization: `buildLedeHtml`'s v1 tests pin the `desk-kicker` markup this task removes (the risk moment replaces the kicker). UPDATE those assertions to the new deck+attrib contract — a rework, not a deletion or weakening; escaping assertions carry over to every new builder.
- Calm face: `risk === null` → `buildRiskHtml` renders the small "Quiet skies nationally" line (spec §3), and the page continues.
- De-dup fallback: `parseDiscussionBody` empty → copy = regexTranslated SUMMARY paragraphs and the deterministic deck slot renders EMPTY (`<p class="desk-deck" id="desk-deck"></p>` — id must exist for the client swap) — never both from one source.

- [ ] **Step 1: Failing tests** — unit-test every builder (escaping payloads included, as v1 did), plus handler-level: (a) happy path with all mocks → order of section markers in the output HTML is strip < risk < desk-deck < copy < rail < wire < clock (assert via `indexOf` comparisons); (b) DY2/DY3 both failing → rail renders two `—` cells, page still 200 with `s-maxage=600`; (c) DY1 failing → exact baked bytes, `s-maxage=300`; (d) calm headline → quiet-skies line present, no `.desk-risk-word`; (e) discussion-empty fallback → summary text present in copy AND `id="desk-deck"` present but empty.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full suite green.**
- [ ] **Step 5: Commit** — `feat(national): composed-desk SSR — strip, risk moment, running copy, day rail, two-line wire, clock`

---

### Task 4: CSS — the composed page's dress

**Files:**
- Modify: `docs/styles.css` (the National Desk block), `tests/national.test.js` (only if a class-existence check is added — optional)

Class contract (must match Task 3's emitted markup exactly — read the builders first): `.desk-strip` + `.desk-strip span/b`, `.desk-risk` + `.desk-risk-word` + `.desk-risk-of` (+ `.desk-risk-quiet` calm face), `.desk-copy` + drop cap on first paragraph, `.desk-rail` + `.desk-rail-day` (+ `.now` modifier), `.wire-item` gains `.wire-area` second line, `.desk-clock`. Plus the fallback guard: `.desk-deck:empty { display:none; }` — the dedup fallback emits an empty deck `<p>` to preserve the client swap target, and it must not leave a blank margin gap.

**Design authority for this task:** the approved mockup source at
`/private/tmp/claude-501/-Users-jonahberg-ganzarain/96b177a0-ebed-4a21-8d31-01bda99a0bf5/scratchpad/national-desk-studies.template.html` — Study F's markup + the `.a-strip/.c-risk/.c-word/.c-of/.a-lede/.c-rail/.e-row/.e-l2/.e-clock` rules. Translate, don't invent.

- [ ] **Step 1:** Read the mockup's CSS in the studies artifact source (`.a-strip`, `.c-risk/.c-word/.c-of`, `.a-lede`, `.c-rail`, `.e-row/.e-l2`, `.e-clock` in the template file at the scratchpad path in the ledger) — it IS the approved design; translate it to the production block using production tokens (`var(--font-display)`, `var(--font-ui)`, `--rubric`, `--rule`, `--newsprint`, real `--step-*` sizes) and the four visual-review rules from the spec (strip flex-fill; justify only ≥640px; deck one step down; risk word owns the hero).
- [ ] **Step 2:** Apply, keeping every rule inside the existing `/* ── The National Desk ──` block region; mobile behavior via the block's media query.
- [ ] **Step 3:** Full suite (csp/fonts tests must stay green). Visual check is deferred to the preview deploy — note that in your report.
- [ ] **Step 4: Commit** — `style(national): composed-desk dress — strip, risk display, copy, rail, two-line wire, clock`

---

### Task 5: Live verification (post-PR, controller-run)

- [ ] Preview deploy: `/national/` 200; section order strip→risk→deck→copy→rail→wire→clock visible; risk word renders (or calm face if the day is quiet); rail shows 3 cells; wire rows carry second lines where the feed has areaDesc; clock line correct vs UTC now.
- [ ] Browse screenshot of the preview vs the Study F mockup — side-by-side sanity.
- [ ] `/api/national-lede` unchanged; `#desk-deck` swap still works (deck text differs from SSR fallback after JS).
- [ ] `/o/LOT/` regression.
