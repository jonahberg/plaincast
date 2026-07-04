# Launch notes — Show HN relaunch

*Drafted 2026-07-03. The Feb 2026 Show HN (item 47029412) got 1 point, 0
comments, and its copy is stale ("19 NWS offices", pre-redesign). HN's FAQ
explicitly permits a repost after a year or when a post got no significant
attention. This is the one clean repost — spend it deliberately.*

## The frame: an artifact, not an AI tool

The genre's proven ceiling on HN is the *aesthetic artifact*: Pirate Weather
(1,149 pts), WeatherStar 4000+ (716), weather_landscape (604), e-ink weather
display (519). All objects, none pitched as AI. The AI is an implementation
detail; the object is the story.

**One-line frame:**

> The National Weather Service writes a daily weather column for your city.
> We typeset and translate it.

## Title candidates (pick one, A/B against a friend)

1. `Show HN: The NWS writes a daily weather column for your city — I typeset it`
2. `Show HN: Plaincast – NWS forecast discussions as a daily newspaper, in plain English`
3. `Show HN: A forecast changelog – what changed in your weather forecast and why`

Candidate 3 leads with the only genuinely novel feature (no competitor does
forecast diffs — verified by market scan Jul 2026: radar archives exist,
forecast *revision history* does not).

## Body copy (draft)

> Every NWS forecast office writes an Area Forecast Discussion 3–4× a day —
> the real forecast, by a human meteorologist reading the models. It's far
> deeper than any weather app, and nearly unreadable unless you speak the
> shorthand.
>
> Plaincast sets it like a fine print publication: plain-English translation
> beside the original facsimile, a jargon glossary, and a **forecast
> changelog** — every revision as a delta: what changed since the last
> issuance, whether the forecasters' confidence rose or fell, with the full
> text diff. Weather nerds share deltas; this makes the delta the artifact.
>
> No accounts, no ads, free, open source. 68 offices. Fonts are subsetted and
> self-hosted; the whole site apart from fonts is ~50KB.
>
> Technical notes for HN: no framework, no build step — static files plus a
> few Vercel functions. Translations are per-issuance and CDN-cached, so AI
> cost is bounded by (offices × issuances), not traffic. Claude Haiku does the
> translation; a regex glossary path renders first so the page works (and
> makes sense) before/without the model.

## Timing

Post into a real weather moment — Atlantic hurricane peak is Aug–Sep. The
severe-weather posture (plain-English alert explanations, 2-minute polling
during Warnings) should be live first, since the launch moment and the feature
serve the same hours. Tue–Thu, 8–10am ET.

## Pre-launch checklist (owner actions)

- [ ] **AI Gateway spend cap** — Vercel dashboard → AI Gateway → set a hard
  monthly cap. Open action item since June 11. The per-issuance architecture
  bounds organic spend, but the cap is the backstop.
- [ ] **Vercel Blob provisioning** (optional but recommended before launch):
  dashboard → Storage → Blob → connect to the project. This lights up durable
  edition snapshots (`api/_snapshots.js`) so permalinks shared in HN comments
  still resolve after NWS's ~7-day retention deletes the product.
- [ ] Fresh hero screenshot for the README/OG after the changelog ships —
  the side-by-side spread with the ledger visible is the money shot.
- [ ] Verify unfurls in iMessage/Slack/X with a real office URL.
- [ ] Re-read the README as a stranger. The first sentence should describe
  the object, not the stack.

## What NOT to do

- Don't post before the changelog, raster OG cards, and SSR office pages are
  deployed — dead links and broken unfurls in the comments are unrecoverable.
- Don't frame around AI ("I built an AI that…") — the genre data says objects
  win, tools don't.
- Don't burn the repost on a quiet news week if a weather event is plausibly
  2–3 weeks out.
