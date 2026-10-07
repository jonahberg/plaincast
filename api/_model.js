// The Claude model behind every AI endpoint (translate, translate-issuance,
// changelog, explain-alert, national-lede), as a Vercel AI Gateway id, plus
// the request options that go with it. Change the model HERE, not per file.
//
// THINKING STAYS OFF. Claude Haiku 5.5 thinks by default (adaptive thinking,
// effort `medium`), and thinking tokens count against maxOutputTokens: at the
// small caps the changelog and national lede use, a turn could spend its whole
// budget thinking and come back with no text. Every call here is a short,
// single-shot rewrite that Haiku 4.5 ran without thinking, so turning it off
// keeps that behavior, keeps latency well inside the 15 s timeouts, and keeps
// reasoning output away from published copy (standing rule since the Aug 1
// incident). `disabled` is only accepted at effort `high` or below: never pair
// it with `xhigh` or `max`, which return a 400.
//
// Haiku 5.5 also rejects non-default temperature / top_p / top_k and assistant
// prefill. None of the endpoints send them; keep it that way.
export const MODEL = 'anthropic/claude-haiku-5.5';

export const PROVIDER_OPTIONS = {
    anthropic: { thinking: { type: 'disabled' } },
};
