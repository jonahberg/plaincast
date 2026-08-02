# 🌤️ Plaincast

**What the forecast actually says.**

**[→ plaincast.live](https://plaincast.live)** · **[☕ Support the Project](https://buymeacoffee.com/notjbg)** · **[💡 Suggest a Feature](https://github.com/jonahberg/plaincast/issues)**

---

## What Is This?

The National Weather Service writes a daily weather column for your city. Plaincast typesets and translates it.

Area Forecast Discussions (AFDs) are the real forecasts - written 3-4 times daily by NWS meteorologists who actually read the models and interpret what they mean for your area. They're far deeper than any weather app, but they're written in dense meteorological shorthand that's nearly unreadable for normal people.

Plaincast sets each edition like a fine print publication: plain-English translation beside the original facsimile, a jargon glossary, an almanac ledger, and a **forecast changelog** - every revision as a delta, because the interesting question is rarely "what's the forecast" and usually "what changed.

---

## Features

### 🤖 AI-Powered Summaries
Every forecast section is summarized by Claude (Haiku) into natural, readable prose. Not just abbreviation expansion - actual explanation of *why* weather is happening, what the models show, and what it means for you. Translations are computed once per issuance and served from the CDN, so AI cost is bounded by (offices × issuances), not traffic. Falls back to regex translation if the model is unavailable - the page works, and makes sense, before and without AI.

### 📖 Side-by-Side Layout
AI summary on the left, original AFD with jargon annotations on the right. Every highlighted term in the original has a hover tooltip (or tap on mobile) explaining what it means. 230+ term glossary covering synoptic meteorology, aviation, marine, pressure levels, model names, and airport codes, plus 109 abbreviation expansion patterns.

### ⚡ Key Takeaway
Bold 1-2 sentence summary at the top extracting what matters most from the Synopsis. Skip the details when you just need the headline.

### 📓 Forecast Changelog
Every retained issuance as a reverse-chronological ledger (`?view=changelog`): what each revision changed, a one-line AI summary of the delta, whether the forecasters' confidence rose or fell (read from their own language), and the full paragraph diff one fold away. Weather nerds share deltas - this makes the delta the artifact.

### 🔗 Edition Permalinks
Every issuance has a durable URL (`/o/LOX/?edition=<id>`). The history selector, the changelog ledger, RSS items, and the Share button all mint the same canonical form. With Vercel Blob provisioned, snapshots let permalinks outlive NWS's ~7-day product retention.

### 🚨 Alerts, Explained
Watches and warnings render as the **Hazard Ledger** - a severity-marked reference table, no emoji. Click any row and it expands inline with a calm plain-English explanation (server-side translation of the official text - what's happening, where, until when, what to do) above the verbatim alert. During severe posture the worst Severe/Extreme Warning is promoted to a Bulletin Slab headline above the ledger, and the page checks for new editions every 2 minutes instead of 10.

### 📊 Forecaster Confidence
Visual indicator analyzing the AFD's language for certainty vs. uncertainty signals. Words like "high confidence" and "consistent" push it up; "uncertain", "tricky", and "wide range" push it down.

### ✏️ Bold Key Info
Days of the week, hazard terms, temperatures, rainfall amounts, and wind speeds are bolded for skimmability.

### 🗂️ Section Parsing
Synopsis, Discussion, Short Term, Long Term, Aviation, Marine, Beaches, Fire Weather, Key Messages, and Active Alerts all rendered as separate sections with pill-style jump navigation.

### ⚠️ Active Alerts
Current watches, warnings, and advisories laid out as a hairline-ruled ledger with emoji-free severity marks (filled for warnings, hatched for watches, hollow outline for advisories, dashed for statements). Rows expand inline, and when enough alerts carry start/end times an optional "On the clock" timetable plots them against the hours ahead.

### 🏢 68 NWS Offices
Covering all US regions: Northeast (New York, Boston, Philadelphia, Washington DC, Pittsburgh, Buffalo, Raleigh, Charleston), Southeast (Atlanta, Miami, Jacksonville, Tampa Bay, Birmingham, Nashville, Morristown, Jackson), Midwest (Chicago, Detroit, Indianapolis, Cleveland, Cincinnati, Milwaukee, Grand Rapids, St. Louis, Kansas City, Des Moines), Northern Plains (Minneapolis, Duluth, Sioux Falls, Bismarck, Omaha, Grand Forks), South Central (Dallas/Fort Worth, Houston, San Antonio, Oklahoma City, Tulsa, Little Rock, New Orleans, Shreveport, Lake Charles), Rockies (Denver, Pueblo, Grand Junction, Salt Lake City, Boise, Billings, Missoula, Riverton), Southwest (Phoenix, Las Vegas, Tucson, Flagstaff, Albuquerque, El Paso), Pacific (Los Angeles, San Diego, San Francisco, Sacramento, Central CA, Eureka, Seattle, Portland, Medford, Spokane), and Alaska/Hawaii (Anchorage, Fairbanks, Honolulu).

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  docs/                                          │
│    ├─ index.html        (markup only, ~350 loc) │
│    ├─ styles.css        (all CSS)               │
│    ├─ js/app.js         (main app logic)        │
│    ├─ js/glossary.js    (230+ term glossary)    │
│    ├─ js/offices.js     (68 office data)        │
│    ├─ js/abbreviations.js (shared NWS abbrevs)  │
│    ├─ js/diff.js        (forecast diff engine)  │
│    ├─ sw.js             (service worker)        │
│    └─ manifest.json     (PWA manifest)          │
│                                                 │
│  NWS API (api.weather.gov)                      │
│    ├─ /products/types/AFD/locations/{office}     │
│    ├─ /products/{id}                            │
│    ├─ /alerts/active?area={state}               │
│    └─ /stations/{id}/observations/latest        │
│                                                 │
│  Vercel Serverless                              │
│    ├─ /api/translate-issuance (whole edition,   │
│    │      translated once, CDN-cached)          │
│    ├─ /api/translate    (per-section fallback)  │
│    ├─ /api/changelog    (what changed, per id)  │
│    ├─ /api/explain-alert (alert in plain terms) │
│    ├─ /api/office-page  (SSR office pages)      │
│    ├─ /api/feed         (delta RSS per office)  │
│    ├─ /api/og           (share cards)           │
│    └─ /api/conditions   (current weather + avg) │
│                                                 │
│  No framework. No build step. ES modules.       │
└─────────────────────────────────────────────────┘
```

---

## Technical Details

- **Modular vanilla app** - ES modules in `docs/js/`, no framework, no build step
- **Zero frontend dependencies** - Vanilla HTML/CSS/JS with ES module imports
- **NWS API** - Pulls directly from `api.weather.gov` (no API key needed)
- **AI summaries** - Claude Haiku via Vercel AI Gateway with OIDC auth
- **Forecast diff** - Paragraph-level comparison showing what changed between AFD versions
- **Custom typography** - Fraunces display, Source Serif 4 body, DM Sans UI, JetBrains Mono for raw AFD; self-hosted subsetted woff2 (~393KB total, real small caps and oldstyle figures)
- **Light/dark mode** - Editorial design with warm cream backgrounds, dark mode with warm near-blacks
- **Mobile responsive** - Side-by-side stacks to vertical on screens under 768px
- **Accessible** - ARIA roles on modals and tooltips, focus trapping, keyboard navigation, severity marks
- **DST-aware** - Zulu time conversion uses IANA timezones per office
- **SEO** - WebApplication + FAQPage schema, OG image, llms.txt, AI crawler friendly

---

## Run Locally

```bash
cd docs && python3 -m http.server 8765
# Open http://localhost:8765
# Note: AI summaries require the Vercel serverless function.
# Locally, sections will fall back to regex translation.
```

---

## Why?

Weather apps give you icons and numbers. AFDs give you the *reasoning* - why the models disagree, what the forecasters are watching, where the uncertainty is. That's the forecast that matters.

The problem is they look like this:

```
.SYNOPSIS...DEEP SW FLOW WILL CONT TO BRING PCPN TO THE AREA
THRU TUE. TEMPS WILL REMAIN BLO NORMAL. NEXT TROF MOV THRU WED...
```

Plaincast turns that into:

> A deep southwest flow is channeling moisture into Southern California through **Tuesday**, bringing steady rain to the coast and heavy snow to the mountains. Temperatures will stay **5-10 degrees below average**. The next trough moves through **Wednesday** with increasing winds.

---

## Documentation

- [DESIGN.md](DESIGN.md) — Design system (typography, color, spacing, components)
- [SPEC.md](SPEC.md) — Original product spec
- [TODOS.md](TODOS.md) — Planned features

---

## Credits

Built by [Jonah Berg](https://github.com/jonahberg). Forecast data from the [National Weather Service](https://www.weather.gov). Summaries powered by [Claude](https://www.anthropic.com/claude/haiku).

---

## License

MIT - see [LICENSE](LICENSE) for details.
