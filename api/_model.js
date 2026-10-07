// The Claude model behind every AI endpoint (translate, translate-issuance,
// changelog, explain-alert, national-lede), plus the request options that go
// with it. Change the model HERE, not per file.
//
// Calls go straight to the Claude API (not Vercel AI Gateway), billed to the
// Console organization that receives the Max plan's monthly API credits.
// ANTHROPIC_API_KEY is read at request time. A personal or multi-workspace key
// must also name the workspace each request runs in: set ANTHROPIC_WORKSPACE_ID
// (a `wrkspc_...` id) for that; a key scoped to one workspace needs nothing.
// When the credits run out with no purchased credits behind them, requests
// fail and every endpoint degrades to its non-AI fallback; nothing is billed.
//
// THINKING STAYS OFF. Claude Haiku 5.5 thinks by default (adaptive thinking,
// effort `medium`), and thinking tokens count against maxOutputTokens. Measured
// on 41 live AFD sections, leaving it on truncated 21 translations at 1024
// tokens and returned no text for 9. Every call here is a short, single-shot
// rewrite that Haiku 4.5 ran without thinking, so turning it off keeps that
// behavior, keeps latency inside the 15 s timeouts, and keeps reasoning output
// away from published copy (standing rule since the Aug 1 incident).
// `disabled` is only accepted at effort `high` or below: never pair it with
// `xhigh` or `max`, which return a 400.
//
// Haiku 5.5 also rejects non-default temperature / top_p / top_k and assistant
// prefill. None of the endpoints send them; keep it that way.
import { createAnthropic } from '@ai-sdk/anthropic';

const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
const anthropic = createAnthropic({
    headers: workspaceId ? { 'anthropic-workspace-id': workspaceId } : undefined,
});

export const MODEL = anthropic('claude-haiku-5-5');

export const PROVIDER_OPTIONS = {
    anthropic: { thinking: { type: 'disabled' } },
};
