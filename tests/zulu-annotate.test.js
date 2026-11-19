import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { annotateZuluTimes, buildSystemPrompt } from '../api/translate.js';
import { extractSections } from '../api/_afd-sections.js';
import { FULL_ABBREVIATIONS } from '../docs/js/abbreviations.js';

// Real products of Nov 18 2026 (api.weather.gov), trimmed to id/issuanceTime/productText.
const live = (office) => JSON.parse(readFileSync(new URL(`./fixtures/afd/live-2026-11-18/${office}.json`, import.meta.url), 'utf8'));
const liveSection = (office, key) => {
    const prod = live(office);
    return { text: extractSections(prod.productText).find(s => s.key === key).text, issuanceTime: prod.issuanceTime };
};

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
// Nov 18 2026: the clock time still comes from the first occurrence at or
// after issuance (minus 1 h), but a bare token no longer gets a weekday
// inferred from that rule (see the "weekday only when the text fixes the day"
// block below), so the expectations here carry the clock and zone only.
describe('annotateZuluTimes — ranges, rollover, DST (Sep 28 2026 audit)', () => {
    const LOT_MON_AM = '2026-09-28T11:36:00+00:00'; // Mon 6:36 AM CDT (real LOT AFD)

    it('annotates single-digit and ranged forms at both ends', () => {
        // Live LOT text: "in the 6-9Z timeframe" → 1-4 AM CDT.
        expect(annotateZuluTimes('in the 6-9Z timeframe', 'LOT', LOT_MON_AM)).toBe('in the 6-9Z (1-4 AM CDT) timeframe');
        expect(annotateZuluTimes('by 6Z', 'LOT', LOT_MON_AM)).toBe('by 6Z (1 AM CDT)');
        expect(annotateZuluTimes('between 15-18Z', 'LOT', LOT_MON_AM)).toBe('between 15-18Z (10 AM-1 PM CDT)');
        expect(annotateZuluTimes('0600-0900Z', 'LOT', LOT_MON_AM)).toBe('0600-0900Z (1-4 AM CDT)');
        // A range crossing local midnight gives both ends with their zone.
        expect(annotateZuluTimes('03-09Z', 'LOT', '2026-09-28T20:00:00Z')).toBe('03-09Z (10 PM CDT-4 AM CDT)');
        // A range crossing 00Z: the end is the first occurrence after the start.
        expect(annotateZuluTimes('20-06Z', 'MTR', '2026-09-28T12:22:00Z')).toBe('20-06Z (1-11 PM PDT)');
    });

    it('00Z in a Monday-afternoon issuance is 7 PM CDT, not Sunday\'s offset', () => {
        expect(annotateZuluTimes('by 00Z', 'LOT', '2026-09-28T20:00:00Z')).toBe('by 00Z (7 PM CDT)');
        expect(annotateZuluTimes('by 06Z', 'LOT', '2026-09-28T20:00:00Z')).toBe('by 06Z (1 AM CDT)');
    });

    it('resolves DST on the actual instant (issued Mar 7 23:30Z CST → Mar 8 12Z is CDT)', () => {
        expect(annotateZuluTimes('by 12Z', 'LOT', '2026-03-07T23:30:00Z')).toBe('by 12Z (7 AM CDT)');
        // 00Z is 30 min after issuance: still Saturday evening, still CST.
        expect(annotateZuluTimes('by 00Z', 'LOT', '2026-03-07T23:30:00Z')).toBe('by 00Z (6 PM CST)');
        expect(annotateZuluTimes('by 18Z', 'LOT', '2026-03-07T23:30:00Z')).toBe('by 18Z (1 PM CDT)');
    });

    it('HFO (no DST) and AFC (Alaska)', () => {
        expect(annotateZuluTimes('by 06Z', 'HFO', LOT_MON_AM)).toBe('by 06Z (8 PM HST)');
        expect(annotateZuluTimes('18-21Z', 'HFO', LOT_MON_AM)).toBe('18-21Z (8-11 AM HST)');
        expect(annotateZuluTimes('by 06Z', 'AFC', LOT_MON_AM)).toBe('by 06Z (10 PM AKDT)');
        expect(annotateZuluTimes('by 12Z', 'AFC', '2026-12-01T20:00:00Z')).toBe('by 12Z (3 AM AKST)');
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
        // The weekday written after a token names its UTC day (Nov 18 2026:
        // offices pin it too), and the annotation follows the weekday.
        expect(annotateZuluTimes('/12Z TAFS THROUGH 12Z TUESDAY/', 'BIS', '2026-09-28T15:21:00Z'))
            .toBe('/12Z (7 AM CDT) TAFS THROUGH 12Z TUESDAY (7 AM CDT Tue)/');
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

    // Nov 18 2026: a bare token carries no weekday, so "no weekday" can no
    // longer mean "the issuance's day" (that would date a Thursday 12Z as
    // Wednesday). The day comes from the text, or is not named.
    it('says a missing weekday leaves the day to the text, never the issuance day', () => {
        expect(system).not.toContain("no weekday means the issuance's local day");
        expect(system).toMatch(/With no weekday, the annotation does not say which day/);
        expect(system).toMatch(/if the text does not make the day clear, give the time without naming a day/);
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

// Opt-in options for the National Desk (Nov 2026). No office caller passes
// them; the tests above pin the office behaviour unchanged.
describe('annotateZuluTimes — explicit zone and weekday pins (National Desk)', () => {
    // Live SPC Day 1, 05:23Z Nov 12 2026 = 12:23 AM EST Thursday.
    const SPC_ISSUED = '2026-11-12T05:23:00+00:00';
    const EASTERN = { timeZone: 'America/New_York' };
    const PINNED = { timeZone: 'America/New_York', weekdayPins: true };

    it('annotates in an explicit zone with no office at all', () => {
        expect(annotateZuluTimes('after 21Z', null, SPC_ISSUED, EASTERN)).toBe('after 21Z (4 PM EST)');
        expect(annotateZuluTimes('after 21Z', null, SPC_ISSUED)).toBe('after 21Z'); // no zone: no-op, as before
    });

    it('the explicit zone wins over the office', () => {
        expect(annotateZuluTimes('by 06Z', 'HFO', SPC_ISSUED)).toBe('by 06Z (8 PM HST)');
        expect(annotateZuluTimes('by 06Z', 'HFO', SPC_ISSUED, EASTERN)).toBe('by 06Z (1 AM EST)');
    });

    it('without weekdayPins a trailing weekday is ignored, exactly as for offices', () => {
        expect(annotateZuluTimes('by 12Z Friday', null, SPC_ISSUED, EASTERN)).toBe('by 12Z (7 AM EST) Friday');
    });

    it('weekdayPins: SPC\'s "12Z Friday" is Friday\'s 12Z, annotated after the weekday', () => {
        expect(annotateZuluTimes('through the Atlantic Seaboard by 12Z Friday.', null, SPC_ISSUED, PINNED))
            .toBe('through the Atlantic Seaboard by 12Z Friday (7 AM EST Fri).');
        // 00Z Friday is Thursday evening in the East — the label says so
        expect(annotateZuluTimes('by 00Z Friday', null, SPC_ISSUED, PINNED)).toBe('by 00Z Friday (7 PM EST Thu)');
        expect(annotateZuluTimes('after 0300Z Sat', null, SPC_ISSUED, PINNED)).toBe('after 0300Z Sat (10 PM EST Fri)');
        // unpinned tokens behave as before
        expect(annotateZuluTimes('around 22z this evening', null, SPC_ISSUED, PINNED)).toBe('around 22z (5 PM EST) this evening');
    });

    it('weekdayPins leaves an already-annotated token alone', () => {
        const done = 'by 12Z Friday (7 AM EST Fri)';
        expect(annotateZuluTimes(done, null, SPC_ISSUED, PINNED)).toBe(done);
    });
});

// Nov 18 2026 (PR #48 measurement): a bare Zulu token BEFORE the issuance was
// given the next day's weekday, because the instant is the first occurrence at
// or after issuance minus 1 h. LOX (issued 21:42Z Wed): the observation "At
// 1717Z at KLAX" became "(9:17 AM PST Thu)" and the AI wrote "9:17 AM
// Thursday". HGX (issued 23:36Z Wed): the model runs "06z" / "12z" became
// "(12 AM CST Thu)" / "(6 AM CST Thu)" and the AI wrote "the 12 AM Thursday
// run of the GFS". Past and future references look alike, so a bare token now
// carries the clock time only; a weekday is printed only when the text fixes
// the day: a DD/ prefix, a full weekday name written right after the token,
// or a TAF cycle label. The clock and zone are unchanged.
describe('annotateZuluTimes — weekday only when the text fixes the day (Nov 18 2026)', () => {
    it('LOX Aviation: the 1717Z observation is 9:17 AM, with no weekday', () => {
        const { text, issuanceTime } = liveSection('LOX', 'AVIATION');
        expect(text).toContain('At 1717Z at KLAX'); // the fixture really carries it
        const out = annotateZuluTimes(text, 'LOX', issuanceTime);
        expect(out).toContain('At 1717Z (9:17 AM PST) at KLAX');
        // the DD/ stamp names its day (Nov 18 = the issuance day: no weekday needed)
        expect(out.startsWith('18/1736Z (9:36 AM PST).')).toBe(true);
        // future TAF times keep their clock, without an inferred weekday
        expect(out).toContain('Aft 06Z (10 PM PST)-12Z (4 AM PST) there is a');
        expect(out).toContain('From 12Z (4 AM PST) to 18Z (10 AM PST) there is');
        expect(out).not.toMatch(/(?:AM|PM) PST (?:Tue|Wed|Thu)\)/);
    });

    it('HGX Discussion: past model runs get no (wrong) weekday', () => {
        const { text, issuanceTime } = liveSection('HGX', 'DISCUSSION');
        const out = annotateZuluTimes(text, 'HGX', issuanceTime);
        expect(out).toContain('The 06z (12 AM CST) Deterministic GFS');
        expect(out).toContain('members from the 06z (12 AM CST) run');
        expect(out).toContain('The 12z (6 AM CST) run has backed off');
        expect(out).not.toMatch(/CST (?:Wed|Thu)\)/);
    });

    it('HGX Aviation: a TAF label stays current; "14Z Thursday" is pinned by its weekday', () => {
        const { text, issuanceTime } = liveSection('HGX', 'AVIATION');
        const out = annotateZuluTimes(text, 'HGX', issuanceTime);
        expect(out.startsWith('(00Z (6 PM CST) TAF Issuance)')).toBe(true);
        expect(out).toContain('between 09Z (3 AM CST)-14Z Thursday (8 AM CST Thu).');
    });

    it('BOU Fire Weather (section written 19:39Z, product 00:02Z): no next-day weekday', () => {
        const { text, issuanceTime } = liveSection('BOU', 'FIRE WEATHER');
        const out = annotateZuluTimes(text, 'BOU', issuanceTime);
        expect(out).toContain('between 23Z (4 PM MST) and\n01Z (6 PM MST).');
        expect(out).toContain('around 21Z (2 PM MST).');
        expect(out).not.toMatch(/MST (?:Wed|Thu)\)/);
    });

    it('LOT Aviation: future times keep the clock; the day comes from the text', () => {
        const { text, issuanceTime } = liveSection('LOT', 'AVIATION');
        const out = annotateZuluTimes(text, 'LOT', issuanceTime);
        expect(out).toContain('between 11-12z (5-6 AM CST)');
        expect(out).toContain('through 15z (9 AM CST)');
    });

    it('a DD/ prefix still names its day, past or future', () => {
        const LOX_WED = '2026-11-18T21:42:00+00:00'; // 1:42 PM PST Wed
        expect(annotateZuluTimes('the 17/12Z run', 'LOX', LOX_WED)).toBe('the 17/12Z (4 AM PST Tue) run');
        expect(annotateZuluTimes('Valid through 20/00Z.', 'LOX', LOX_WED)).toBe('Valid through 20/00Z (4 PM PST Thu).');
    });

    it('offices: a full weekday name after the token pins its UTC day', () => {
        const LOT_WED = '2026-11-18T23:20:00+00:00'; // 5:20 PM CST Wed
        // 00Z Friday is Thursday evening in Chicago (live BOU header: "/00Z TAFS through 00Z Friday/").
        expect(annotateZuluTimes('VFR through 00Z Friday.', 'LOT', LOT_WED)).toBe('VFR through 00Z Friday (6 PM CST Thu).');
        expect(annotateZuluTimes('by 12Z Thursday', 'LOT', LOT_WED)).toBe('by 12Z Thursday (6 AM CST Thu)');
        expect(annotateZuluTimes('until 12-18Z THURSDAY', 'LOT', LOT_WED)).toBe('until 12-18Z THURSDAY (6 AM-12 PM CST Thu)');
    });

    it('offices: no pin from an abbreviation ("sat" imagery) or a weekday with a part of day', () => {
        const LOT_WED = '2026-11-18T23:20:00+00:00';
        expect(annotateZuluTimes('the 18Z sat imagery', 'LOT', LOT_WED)).toBe('the 18Z (12 PM CST) sat imagery');
        // "06Z Friday night" means Friday night local (Saturday 06Z), not Friday 06Z:
        // the text names the day, so the annotation gives only the clock.
        expect(annotateZuluTimes('after 06Z Friday night', 'LOT', LOT_WED)).toBe('after 06Z (12 AM CST) Friday night');
        expect(annotateZuluTimes('by 12Z Friday morning', 'LOT', LOT_WED)).toBe('by 12Z (6 AM CST) Friday morning');
    });

    it('is idempotent on every new form', () => {
        const LOT_WED = '2026-11-18T23:20:00+00:00';
        for (const text of ['VFR through 00Z Friday.', 'after 06Z Friday night', 'between 09Z-14Z Thursday.', 'At 1717Z at KLAX']) {
            const once = annotateZuluTimes(text, 'LOT', LOT_WED);
            expect(annotateZuluTimes(once, 'LOT', LOT_WED)).toBe(once);
        }
    });

    it('the National Desk (explicit zone) keeps its earlier rule: its prompt still reads "no weekday means the issuance\'s day"', () => {
        // 3 PM EST Thu Nov 12: the next 12Z is Friday morning.
        expect(annotateZuluTimes('by 12Z', null, '2026-11-12T20:00:00Z', { timeZone: 'America/New_York', weekdayPins: true }))
            .toBe('by 12Z (7 AM EST Fri)');
    });
});
