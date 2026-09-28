import { describe, it, expect } from 'bun:test';
import { existsSync } from 'node:fs';

// A real render through @vercel/og (satori + resvg-wasm), not just the element
// tree. @vercel/og 1.0.2/1.0.3 shipped without the dist/hb.wasm they load, so
// every render threw ENOENT while every tree-level test still passed — this is
// the test that catches that class of break before it reaches the unfurls.
const { renderCardPng } = await import('../api/og.js?real');

describe('OG card render (real @vercel/og pipeline)', () => {
    it('renders a 1200x630 PNG with the Geist card fonts', async () => {
        const png = await renderCardPng({
            city: 'Chicago',
            dateline: 'Area Forecast Discussion · Mon, Sep 28, 6:36 AM CDT',
            takeaway: 'Dense fog again tonight, then widespread rain Wednesday.',
        });
        expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        expect(png.readUInt32BE(16)).toBe(1200); // IHDR width
        expect(png.readUInt32BE(20)).toBe(630);  // IHDR height
        expect(png.length).toBeGreaterThan(10_000); // not a blank canvas
    });

    it('ships the font subsets and their licence', () => {
        for (const f of ['geist-regular-card.ttf', 'geist-semibold-card.ttf', 'GEIST-LICENSE.txt']) {
            expect(existsSync(new URL(`../api/_og-fonts/${f}`, import.meta.url))).toBe(true);
        }
    });
});
