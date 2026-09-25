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

describe('translation prompt rules', () => {
    const system = buildSystemPrompt({ section: 'Aviation', office: 'LOT', issuanceTime: '2026-09-25T11:42:00+00:00' });

    it('tells the model to use the annotated local time, not its own conversion', () => {
        expect(system).toContain('never convert a Zulu time yourself');
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
