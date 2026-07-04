# TODOS

## Completed

### Forecast Changelog Feature
**What:** Package the existing history/diff hooks as a first-class "what changed since last issuance" view. Every new AFD becomes a delta: what changed, why it changed, and whether confidence went up or down.

**Why:** Weather nerds share deltas, not static forecasts. The current diff infrastructure already exists at `docs/js/diff.js` and `docs/js/app.js` (~line 1030). This would be the most compelling reason for someone to send the Plaincast link to a friend.

**Depends on:** Polish pass complete (this branch). No other blockers.

**Source:** Identified by Codex during /office-hours session (2026-04-03) as "the coolest version of Plaincast."

## Completed

**Completed:** 2026-07-04 — shipped as the edition ledger (?view=changelog) in the level-up arc PR.
