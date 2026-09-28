// Regenerates docs/og-image.png — the static card api/og.js 302s to when it
// cannot render (and the og:image of pages without an office) — with the same
// renderer and fonts as the live cards, so the two never drift apart.
// Run: bun scripts/build-og-fallback.mjs
import { writeFileSync } from 'node:fs';
import { renderCardPng } from '../api/og.js';

const png = await renderCardPng({
    city: 'What the forecast actually says',
    dateline: 'Area Forecast Discussions from all 68 NWS offices',
    takeaway: 'The reasoning behind your forecast, from the meteorologists who wrote it, translated into plain English.',
});
writeFileSync(new URL('../docs/og-image.png', import.meta.url), png);
console.log(`docs/og-image.png ${png.length} bytes`);
