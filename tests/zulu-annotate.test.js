import { describe, it, expect } from 'bun:test';
import { annotateZuluTimes, buildSystemPrompt } from '../api/translate.js';
import { FULL_ABBREVIATIONS } from '../docs/js/abbreviations.js';

// Sep 25 2026 prod: Haiku rendered LOT's "VCSH through 15Z" as "through 3 PM
// local time" (15Z = 10 AM CDT) and named the DPA airport "Chicago Midway".
// Zulu times are now converted deterministically before the model sees them.
describe('annotateZuluTimes', () => {
    const LOT_ISSUED = '2026-09-25T11:42:00+00:00';

    it('appends the office-local clock time to HHZ and HHMMZ tokens', () => {
        expect(annotateZuluTimes('VCSH through 15Z.', 'LOT', LOT_ISSUED)).toBe('VCSH through 15Z (10 AM CDT).');
        expect(annotateZuluTimes('after 0030Z', 'LOT', LOT_ISSUED)).toBe('after 0030Z (7:30 PM CDT)');
    });

    it('uses the office timezone and the issuance date for DST', () => {
        expect(annotateZuluTimes('by 06Z', 'HFO', LOT_ISSUED)).toBe('by 06Z (8 PM HST)');
        expect(annotateZuluTimes('by 15Z', 'LOT', '2026-01-10T11:42:00+00:00')).toBe('by 15Z (9 AM CST)');
    });

    it('leaves DDHHMMZ stamps, TAF ranges, invalid hours and already-annotated tokens alone', () => {
        const text = 'Issued 251200Z. Valid 2518/2618. 99Z. 15Z (10 AM CDT).';
        expect(annotateZuluTimes(text, 'LOT', LOT_ISSUED)).toBe(text);
    });

    it('is a no-op for an unknown office', () => {
        expect(annotateZuluTimes('through 15Z', 'ZZZ', LOT_ISSUED)).toBe('through 15Z');
    });
});

// Sep 28 2026 audit: single-digit and ranged forms were skipped, and the
// instant was taken on the issuance's UTC date (so an afternoon "00Z" became
// LAST evening, and DST weekends got the old offset).
describe('annotateZuluTimes — ranges, rollover, DST (Sep 28 2026 audit)', () => {
    const LOT_MON_AM = '2026-09-28T11:36:00+00:00'; // Mon 6:36 AM CDT (real LOT AFD)

    it('annotates single-digit and ranged forms at both ends', () => {
        // Live LOT text: "in the 6-9Z timeframe" → Tue 1-4 AM CDT.
        expect(annotateZuluTimes('in the 6-9Z timeframe', 'LOT', LOT_MON_AM)).toBe('in the 6-9Z (1-4 AM CDT Tue) timeframe');
        expect(annotateZuluTimes('by 6Z', 'LOT', LOT_MON_AM)).toBe('by 6Z (1 AM CDT Tue)');
        expect(annotateZuluTimes('between 15-18Z', 'LOT', LOT_MON_AM)).toBe('between 15-18Z (10 AM-1 PM CDT)');
        expect(annotateZuluTimes('0600-0900Z', 'LOT', LOT_MON_AM)).toBe('0600-0900Z (1-4 AM CDT Tue)');
        // A range crossing local midnight names both days.
        expect(annotateZuluTimes('03-09Z', 'LOT', '2026-09-28T20:00:00Z')).toBe('03-09Z (10 PM CDT-4 AM CDT Tue)');
        // A range crossing 00Z: the end is the first occurrence after the start.
        expect(annotateZuluTimes('20-06Z', 'MTR', '2026-09-28T12:22:00Z')).toBe('20-06Z (1-11 PM PDT)');
    });

    it('00Z in a Monday-afternoon issuance is Monday 7 PM, not Sunday', () => {
        expect(annotateZuluTimes('by 00Z', 'LOT', '2026-09-28T20:00:00Z')).toBe('by 00Z (7 PM CDT)');
        // …and the weekday appears once the local date moves on.
        expect(annotateZuluTimes('by 06Z', 'LOT', '2026-09-28T20:00:00Z')).toBe('by 06Z (1 AM CDT Tue)');
    });

    it('resolves DST on the actual instant (issued Mar 7 23:30Z CST → Mar 8 12Z is CDT)', () => {
        expect(annotateZuluTimes('by 12Z', 'LOT', '2026-03-07T23:30:00Z')).toBe('by 12Z (7 AM CDT Sun)');
        // 00Z is 30 min after issuance: still Saturday evening, still CST.
        expect(annotateZuluTimes('by 00Z', 'LOT', '2026-03-07T23:30:00Z')).toBe('by 00Z (6 PM CST)');
        expect(annotateZuluTimes('by 18Z', 'LOT', '2026-03-07T23:30:00Z')).toBe('by 18Z (1 PM CDT Sun)');
    });

    it('HFO (no DST) and AFC (Alaska)', () => {
        expect(annotateZuluTimes('by 06Z', 'HFO', LOT_MON_AM)).toBe('by 06Z (8 PM HST)');
        expect(annotateZuluTimes('18-21Z', 'HFO', LOT_MON_AM)).toBe('18-21Z (8-11 AM HST)');
        expect(annotateZuluTimes('by 06Z', 'AFC', LOT_MON_AM)).toBe('by 06Z (10 PM AKDT)');
        expect(annotateZuluTimes('by 12Z', 'AFC', '2026-12-01T20:00:00Z')).toBe('by 12Z (3 AM AKST Wed)');
    });

    it('a DD/ prefix pins the UTC day (TAF valid times, model runs)', () => {
        expect(annotateZuluTimes('Valid through 29/12Z.', 'TWC', '2026-09-28T09:14:00Z')).toBe('Valid through 29/12Z (5 AM MST Tue).');
        expect(annotateZuluTimes('the 28/00Z HREF', 'TWC', '2026-09-28T09:14:00Z')).toBe('the 28/00Z (5 PM MST Sun) HREF');
        expect(annotateZuluTimes('between 29/12-18Z', 'TWC', '2026-09-28T09:14:00Z')).toBe('between 29/12-18Z (5-11 AM MST Tue)');
    });

    it('a reference up to 1 h before issuance stays today (aviation text is written first)', () => {
        // Live VEF, issued 1150Z: "Vicinity thunderstorms continue until 11Z".
        expect(annotateZuluTimes('until 11Z', 'VEF', '2026-09-28T11:50:00Z')).toBe('until 11Z (4 AM PDT)');
    });

    it('a TAF cycle label is the current cycle, not tomorrow\'s', () => {
        // Live IND, issued 1357Z: ".AVIATION (12Z TAF Issuance)..."
        expect(annotateZuluTimes('(12Z TAF Issuance)', 'IND', '2026-09-28T13:57:00Z')).toBe('(12Z (8 AM EDT) TAF Issuance)');
        expect(annotateZuluTimes('/12Z TAFS THROUGH 12Z TUESDAY/', 'BIS', '2026-09-28T15:21:00Z'))
            .toBe('/12Z (7 AM CDT) TAFS THROUGH 12Z (7 AM CDT Tue) TUESDAY/');
        // Afternoon issuance: the label is the UPCOMING 00Z cycle, not yesterday's.
        expect(annotateZuluTimes('.AVIATION /00Z TAFS/...', 'LOT', '2026-09-28T20:30:00Z'))
            .toBe('.AVIATION /00Z (7 PM CDT) TAFS/...');
        expect(annotateZuluTimes('.AVIATION /18Z TAFS/...', 'LOT', '2026-09-28T17:40:00Z'))
            .toBe('.AVIATION /18Z (1 PM CDT) TAFS/...');
    });

    it('never matches wind, visibility, flight-level, DDHHMMZ or TAF groups', () => {
        const text = '27015G25KT P6SM 3SM FL250 BKN025 281130Z 2818/2918 FM281800 TEMPO 2820/2824 1/2SM';
        expect(annotateZuluTimes(text, 'LOT', LOT_MON_AM)).toBe(text);
    });

    it('never leaves a narrow no-break space or a ":00" in the label', () => {
        const out = annotateZuluTimes('15Z 1530Z 0000Z 6-9Z', 'LOT', LOT_MON_AM);
        expect(out).not.toMatch(/[\u202f\u00a0]/);
        expect(out).not.toContain(':00');
        expect(out).toContain('1530Z (10:30 AM CDT)');
    });

    it('accepts lowercase z (≈30 of the live Sep 28 tokens: "12z", "14-15z")', () => {
        expect(annotateZuluTimes('the 12z guidance, 14-15z', 'LOT', LOT_MON_AM)).toBe('the 12z (7 AM CDT) guidance, 14-15z (9-10 AM CDT)');
    });

    it('is idempotent (already-annotated ranges are left alone)', () => {
        const once = annotateZuluTimes('in the 6-9Z timeframe', 'LOT', LOT_MON_AM);
        expect(annotateZuluTimes(once, 'LOT', LOT_MON_AM)).toBe(once);
    });
});

describe('translation prompt rules', () => {
    const system = buildSystemPrompt({ section: 'Aviation', office: 'LOT', issuanceTime: '2026-09-25T11:42:00+00:00' });

    it('tells the model to use the annotated local time, not its own conversion', () => {
        expect(system).toContain('never convert a Zulu time yourself');
    });

    it('documents the range + weekday format the annotator emits', () => {
        expect(system).toContain('"6-9Z (1-4 AM CDT Tue)"');
        expect(system).toContain('a weekday after the zone means that local day');
    });

    it('forbids renaming station identifiers', () => {
        expect(system).toContain('never replace one with an airport or city name');
    });
});

describe('regex fallback: flight-category abbreviations', () => {
    const expand = (t) => FULL_ABBREVIATIONS.reduce((s, [re, rep]) => s.replace(re, rep), t);

    it('does not double "conditions" ("VFR conditions" → one "conditions")', () => {
        expect(expand('VFR conditions are forecast')).toBe('good visual flying conditions are forecast');
        expect(expand('MVFR conditions possible')).toBe('marginal visual flying conditions possible');
        expect(expand('IFR expected')).toBe('instrument-only flying conditions expected');
    });
});
