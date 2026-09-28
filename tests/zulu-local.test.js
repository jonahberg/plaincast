// ─── Client-side Zulu fallback (Sep 28 2026 audit) ───────────────────
// The instant regex translation (shown before the AI arrives) converted only
// HHZ/HHMMZ: single-digit and range forms ("6-9Z", "15-18Z", "05-09z") were
// left raw or half-converted ("05-2 AM PDT"). zuluToLocal handles them, dates
// every time from the issuance (first occurrence at/after it), and must not
// touch aviation tokens. Forked verbatim into docs/js/app.js — the body is
// locked by tests/shadcn-parity.test.js.

import { describe, it, expect } from 'bun:test';
import { zuluToLocal, translateToPlainEnglish } from '../shadcn/src/lib/afd.js';

const LA = 'America/Los_Angeles';
const CHI = 'America/Chicago';
const ISSUED = '2026-09-25T11:42:00+00:00'; // PDT / CDT in effect

describe('zuluToLocal', () => {
    it('converts HHZ and HHMMZ', () => {
        expect(zuluToLocal('through 15Z', CHI, ISSUED)).toBe('through 10 AM CDT');
        expect(zuluToLocal('after 0030Z', CHI, ISSUED)).toBe('after 7:30 PM CDT');
    });

    it('converts single-digit hours', () => {
        expect(zuluToLocal('by 6Z', LA, ISSUED)).toBe('by 11 PM PDT');
        expect(zuluToLocal('by 6z', LA, ISSUED)).toBe('by 11 PM PDT');
    });

    it('converts both ends of a range and shares the zone', () => {
        expect(zuluToLocal('VCSH 15-18Z', CHI, ISSUED)).toBe('VCSH 10 AM–1 PM CDT');
        expect(zuluToLocal('MVFR 6-9Z', LA, ISSUED)).toBe('MVFR 11 PM–2 AM PDT');
        expect(zuluToLocal('fog 05-09z', LA, ISSUED)).toBe('fog 10 PM–2 AM PDT');
        expect(zuluToLocal('gusts 20z-22z', LA, ISSUED)).toBe('gusts 1 PM–3 PM PDT');
        expect(zuluToLocal('rain 22-03Z', CHI, ISSUED)).toBe('rain 5 PM–10 PM CDT');
    });

    it('never touches aviation tokens or DDHHMMZ stamps', () => {
        const text = 'Winds 27015G25KT P6SM FEW250 FL250 3SM VCSH. Issued 251200Z. Valid 2518/2618.';
        expect(zuluToLocal(text, LA, ISSUED)).toBe(text);
    });

    it('leaves invalid clock values and 3-digit tokens alone', () => {
        expect(zuluToLocal('99Z 015Z 2475Z 30-35Z', LA, ISSUED)).toBe('99Z 015Z 2475Z 30-35Z');
    });

    it('dates each time from the issuance (DST of the right day)', () => {
        // Issued Sat Nov 1 2026 20Z (CDT). 15Z has already passed that day, so
        // it is Sun Nov 2 15Z — after the fall-back — which is 9 AM CST.
        expect(zuluToLocal('by 15Z', CHI, '2026-11-01T20:00:00Z')).toBe('by 9 AM CST');
        // 21Z is later the same day: still CDT.
        expect(zuluToLocal('by 21Z', CHI, '2026-10-31T20:00:00Z')).toBe('by 4 PM CDT');
    });

    it('translateToPlainEnglish threads the issuance time through', () => {
        const html = translateToPlainEnglish('Showers taper 6-9Z.', LA, ISSUED);
        expect(html).toContain('11 PM–2 AM PDT');
        expect(html).not.toMatch(/\dZ\b/);
    });
});

describe('legacy client /api/conditions ledger', () => {
    it('no longer renders +null as "Now 0°"', async () => {
        const app = await Bun.file(new URL('../docs/js/app.js', import.meta.url)).text();
        expect(app).not.toContain('Number.isFinite(+data.temp)');
        expect(app).toContain('readingOrNull(data.temp)');
    });
});
