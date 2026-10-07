# TODOS

## Open

### Owner actions (Vercel dashboard / CLI, not code)
- **Keep the Claude API capped.** AI calls bill to the Console org that gets
  the Max plan's monthly API credits; with no card or auto-reload behind them,
  the credits ARE the cap (requests stop, endpoints fall back). If purchased
  credits or auto-reload are ever added, set a workspace spend limit first
  (Console → Settings → Limits) so an attack can't drain them.
- **WAF rate-limit rule** on `/api/(translate|translate-issuance|changelog|explain-alert)`,
  ~20 req/min per IP → 429. The in-code limiters are per instance only.
- **Swap `ANTHROPIC_API_KEY` for a workspace-scoped key.** The current key is a
  personal multi-workspace key, so `ANTHROPIC_WORKSPACE_ID` has to name the
  workspace. A key created inside that one workspace needs no header and can't
  reach the others; once it's in, `ANTHROPIC_WORKSPACE_ID` can be deleted.

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
