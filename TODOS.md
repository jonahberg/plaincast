# TODOS

## Open

### Owner actions (Vercel dashboard / CLI, not code)
- **AI Gateway budget for the plaincast project.** None exists, so the Gateway
  credit balance is the only ceiling on LLM spend. A daily budget caps an
  attack at one day's limit: `vercel ai-gateway budgets set project plaincast --limit 5 --refresh-period daily`.
- **WAF rate-limit rule** on `/api/(translate|translate-issuance|changelog|explain-alert)`,
  ~20 req/min per IP → 429. The in-code limiters are per instance only.
- **Remove the unused `ANTHROPIC_API_KEY`** from Production env and revoke it at
  Anthropic (the Gateway authenticates via OIDC; nothing references the key).

### Code follow-ups
- **Shared cache for AI results.** Caches are in-memory per instance; Blob is not
  provisioned, so `api/_snapshots.js` is inert. Provisioning Blob (or moving to
  Vercel Runtime Cache) turns cold starts into cache hits.
- **@vercel/og is pinned to exactly 1.0.1.** 1.0.2 and 1.0.3 import `dist/hb.wasm`
  (harfbuzz) but do not ship it, so every render throws ENOENT. Before bumping,
  check the tarball: `npm pack @vercel/og@<v> --dry-run | grep hb.wasm`.
- **Other majors:** ai 7, vite 8, @vitejs/plugin-react 6, lucide-react 1.x.

## Completed


### Forecast Changelog Feature
**What:** Package the existing history/diff hooks as a first-class "what changed since last issuance" view. Every new AFD becomes a delta: what changed, why it changed, and whether confidence went up or down.

**Why:** Weather nerds share deltas, not static forecasts. The current diff infrastructure already exists at `docs/js/diff.js` and `docs/js/app.js` (~line 1030). This would be the most compelling reason for someone to send the Plaincast link to a friend.

**Depends on:** Polish pass complete (this branch). No other blockers.

**Source:** Identified by Codex during /office-hours session (2026-04-03) as "the coolest version of Plaincast."


**Completed:** 2026-07-04 — shipped as the edition ledger (?view=changelog) in the level-up arc PR.
