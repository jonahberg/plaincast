# 🌤️ Plaincast

**What the forecast actually says.**

**[→ plaincast.live](https://plaincast.live)** · **[☕ Support the Project](https://buymeacoffee.com/notjbg)** · **[💡 Suggest a Feature](https://github.com/notjbg/plaincast/issues)**

---

## What Is This?

Area Forecast Discussions (AFDs) are the real forecasts - written 3-4 times daily by National Weather Service meteorologists who actually read the models and interpret what they mean for your area. They're far deeper than any weather app, but they're written in dense meteorological shorthand that's nearly unreadable for normal people.

Plaincast uses Anthropic's Claude to summarize them into plain English, displayed side by side with the annotated original.

---

## Features

### 🤖 AI-Powered Summaries
Every forecast section is summarized by Claude (Haiku) into natural, readable prose. Not just abbreviation expansion - actual explanation of *why* weather is happening, what the models show, and what it means for you. Falls back to regex translation if the API is unavailable.

### 📖 Side-by-Side Layout
AI summary on the left, original AFD with jargon annotations on the right. Every highlighted term in the original has a hover tooltip (or tap on mobile) explaining what it means. 230+ term glossary covering synoptic meteorology, aviation, marine, pressure levels, model names, and airport codes, plus 109 abbreviation expansion patterns.

### ⚡ Key Takeaway
Bold 1-2 sentence summary at the top extracting what matters most from the Synopsis. Skip the details when you just need the headline.

### 📊 Forecaster Confidence
Visual indicator analyzing the AFD's language for certainty vs. uncertainty signals. Words like "high confidence" and "consistent" push it up; "uncertain", "tricky", and "wide range" push it down.

### ✏️ Bold Key Info
Days of the week, hazard terms, temperatures, rainfall amounts, and wind speeds are bolded for skimmability.

### 🗂️ Section Parsing
Synopsis, Discussion, Short Term, Long Term, Aviation, Marine, Beaches, Fire Weather, Key Messages, and Active Alerts all rendered as separate sections with pill-style jump navigation.

### ⚠️ Active Alerts
Current watches, warnings, and advisories formatted as a clean, color-coded bullet list with severity icons. Click any alert to see the full NWS detail in a modal.

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
│    ├─ /api/translate  (AI Gateway → Claude)     │
│    ├─ /api/feed       (RSS per office)          │
│    ├─ /api/og         (dynamic OG images)       │
│    └─ /api/conditions (current weather + avg)   │
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
- **Custom typography** - Fraunces display, Source Serif 4 body, DM Sans UI, JetBrains Mono for raw AFD
- **Light/dark mode** - Editorial design with warm cream backgrounds, dark mode with warm near-blacks
- **Mobile responsive** - Side-by-side stacks to vertical on screens under 768px
- **Accessible** - ARIA roles on modals and tooltips, focus trapping, keyboard navigation, severity icons
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

Built by [Jonah Berg](https://github.com/notjbg). Forecast data from the [National Weather Service](https://www.weather.gov). Summaries powered by [Claude](https://www.anthropic.com/claude/haiku).

---

## License

MIT - see [LICENSE](LICENSE) for details.
