# Plaincast

## Project Structure
```
docs/              Static frontend (served as outputDirectory)
  index.html       Markup (~360 loc)
  styles.css       All CSS
  js/app.js        Main app logic
  js/glossary.js   230+ term glossary
  js/offices.js    68 NWS office data
  js/abbreviations.js  109 abbreviation patterns
  js/diff.js       Forecast diff engine
  sw.js            Service worker
  manifest.json    PWA manifest
api/               Vercel serverless functions
  translate.js     AI translation (AI Gateway + Claude)
  feed.js          RSS per office
  og.js            Dynamic OG images
  conditions.js    Current weather + averages
tests/             Bun test suite (351 tests)
```

## Commands
- `bun test tests/` — run all tests
- `cd docs && python3 -m http.server 8765` — local dev (AI summaries need Vercel)

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
