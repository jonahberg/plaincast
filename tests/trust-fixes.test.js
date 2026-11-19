// Nov 11 2026 trust fixes, pure-function half (the handler half lives in
// api-translate-handler.test.js / api-translate-issuance.test.js, which own the
// process-global _utils.js mock and translate.js's module-scope AFD cache).
//
// Production, LOX Long Term issued 2026-11-12T04:55Z (Wed Nov 11, 8:55 PM PST):
//   - the model read the forecaster stamp "11/220 PM." as a date and wrote
//     "Sunday, November 22" (the real Sunday is November 15);
//   - it then leaked an aside about the source text to the reader;
//   - the no-AI glossary pass turned "a little pop up ridge" into
//     "a little chance of rain up ridge".
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildSystemPrompt, sanitizeTranslation, stripHeaderStamp } from '../api/translate.js';
import { extractSections, regexTranslate } from '../api/_afd-sections.js';
import { FULL_ABBREVIATIONS } from '../docs/js/abbreviations.js';
import { parseSections, translateToPlainEnglish } from '../shadcn/src/lib/afd.js';

const LOX = JSON.parse(readFileSync(new URL('./fixtures/afd/live-2026-11-11/LOX.json', import.meta.url), 'utf8'));
const LOX_ISSUED = LOX.issuanceTime; // 2026-11-12T04:55:00+00:00
const LONG_TERM = parseSections(LOX.productText).sections.find(s => s.key === 'Long Term').text;

// The exact bad production output for that section.
const BAD_PRODUCTION_OUTPUT = 'Sunday, November 22 should be a pleasant day as a small ridge of high pressure builds over the area, bringing **highs in the mid 60s to lower 70s**, which is very close to typical for this time of year. Note that the source text reads "11/220 PM," which appears to be the issuance time, and the forecast days are counted from Sunday.\n\nAnother storm system is expected to arrive **Monday**.';

const expandAll = (t) => FULL_ABBREVIATIONS.reduce((s, [re, rep]) => s.replace(re, rep), t);

describe('stripHeaderStamp (prompt assembly only)', () => {
    it('removes the leading "11/220 PM." stamp from the LOX Long Term section', () => {
        expect(LONG_TERM.startsWith('11/220 PM.')).toBe(true); // the fixture really carries it
        const stripped = stripHeaderStamp(LONG_TERM);
        expect(stripped).not.toContain('11/220');
        expect(stripped.startsWith('Sunday should be a pleasant day')).toBe(true);
    });

    it('handles the other LOX stamp shapes (03/428 PM., 11/459 PM., 1/1015 AM)', () => {
        expect(stripHeaderStamp('03/428 PM.\n\nRain returns Friday.')).toBe('Rain returns Friday.');
        expect(stripHeaderStamp('  11/459 PM.  A significant cooling trend.')).toBe('A significant cooling trend.');
        expect(stripHeaderStamp('1/1015 AM\nDry and mild.')).toBe('Dry and mild.');
    });

    it('leaves a section without a stamp byte-identical', () => {
        const text = 'Sunday should be a pleasant day as a little pop up ridge moves\nover the area.';
        expect(stripHeaderStamp(text)).toBe(text);
    });

    it('never touches a mid-text 11/220 (it could be real content)', () => {
        const text = 'Gusts were measured on 11/220 PM at the coast.\n11/220 PM. More text here.';
        expect(stripHeaderStamp(text)).toBe(text);
    });

    it('leaves Zulu stamps alone (annotateZuluTimes gives them a correct local time)', () => {
        const text = '12/0454Z.\n\nAt 0450Z at KLAX, the marine inversion was 600 feet.';
        expect(stripHeaderStamp(text)).toBe(text);
    });

    it('never empties a section that is only a stamp', () => {
        expect(stripHeaderStamp('11/220 PM.')).toBe('11/220 PM.');
    });

    it('does not change what the parsers extract (cache key + verification stay parity-locked)', () => {
        const server = extractSections(LOX.productText).find(s => s.key === 'LONG TERM');
        expect(server.text.startsWith('11/220 PM.')).toBe(true);
        expect(LONG_TERM.startsWith('11/220 PM.')).toBe(true);
    });
});

// Nov 18 2026 (PR #48 measurement): most offices open a section with an
// "Issued at 528 PM CST Wed Nov 18 2026" line, and the model restated it
// ("This aviation forecast, issued Wednesday evening, November 18, 2026, at
// 5:28 PM Central time, warns..."). It leaves the PROMPT only, like the LOX
// stamp; a qualifier line above it ("(00Z TAF Issuance)") is content and stays.
describe('stripHeaderStamp — "Issued at" / "Updated at" header lines', () => {
    const live = (office) => JSON.parse(readFileSync(new URL(`./fixtures/afd/live-2026-11-18/${office}.json`, import.meta.url), 'utf8'));
    const section = (office, key) => extractSections(live(office).productText).find(s => s.key === key).text;

    it('removes a leading "Issued at" line (HGX Marine, LOT Discussion, BOU Fire Weather)', () => {
        const marine = section('HGX', 'MARINE');
        expect(marine.startsWith('Issued at 1201 PM CST Wed Nov 18 2026\n\nNortheast winds near 20 knots')).toBe(true);
        expect(stripHeaderStamp(marine).startsWith('Northeast winds near 20 knots')).toBe(true);
        expect(stripHeaderStamp(section('LOT', 'DISCUSSION')).startsWith('A strong low-level wind field')).toBe(true);
        expect(stripHeaderStamp(section('BOU', 'FIRE WEATHER')).startsWith('The Red Flag Warning will remain')).toBe(true);
    });

    it('keeps the qualifier line above it (HGX Aviation, MFL Aviation and Short Term)', () => {
        const hgx = section('HGX', 'AVIATION');
        expect(hgx.startsWith('(00Z TAF Issuance)\nIssued at 528 PM CST Wed Nov 18 2026\n\nConditions will')).toBe(true);
        expect(stripHeaderStamp(hgx).startsWith('(00Z TAF Issuance)\nConditions will gradually deteriorate')).toBe(true);
        expect(stripHeaderStamp(section('MFL', 'AVIATION')).startsWith('(00Z TAFS)\nShowers continue across')).toBe(true);
        expect(stripHeaderStamp(section('MFL', 'SHORT TERM')).startsWith('(Rest of today through Thursday)\nCoastal convergence')).toBe(true);
        expect(stripHeaderStamp(section('MFL', 'LONG TERM')).startsWith('(Thursday night through Tuesday)\nOn Friday, global models')).toBe(true);
    });

    it('removes the same-shaped "Updated at" line (MFL Key Messages)', () => {
        const messages = section('MFL', 'KEY MESSAGES');
        expect(messages.startsWith('Updated at 635 PM EST Wed Nov 18 2026\n\n')).toBe(true);
        const out = stripHeaderStamp(messages);
        expect(out).not.toContain('Updated at');
        expect(out.trimStart().startsWith('- There is an increased threat of urban flooding')).toBe(true);
    });

    it('changes nothing else in the section', () => {
        const hgx = section('HGX', 'AVIATION');
        expect(stripHeaderStamp(hgx)).toBe(hgx.replace('Issued at 528 PM CST Wed Nov 18 2026\n\n', ''));
        const marine = section('HGX', 'MARINE');
        expect(stripHeaderStamp(marine)).toBe(marine.replace('Issued at 1201 PM CST Wed Nov 18 2026\n\n', ''));
    });

    it('handles other zones, 3- and 4-digit times and upper case', () => {
        expect(stripHeaderStamp('Issued at 1232 AM EST Wed Nov 18 2026\n\nStrong winds.')).toBe('Strong winds.');
        expect(stripHeaderStamp('Issued at 905 AM AKST Thu Dec 3 2026\nSnow tonight.')).toBe('Snow tonight.');
        expect(stripHeaderStamp('Issued at 410 PM ChST Fri Nov 20 2026\n\nTrade winds.')).toBe('Trade winds.');
        expect(stripHeaderStamp('ISSUED AT 528 PM CST WED NOV 18 2026\n\nFOG LATE.')).toBe('FOG LATE.');
    });

    it('accepts the form without "at" (MKX Update, Sep 28 2026)', () => {
        const mkx = JSON.parse(readFileSync(new URL('./fixtures/afd/live-2026-09-28/MKX.json', import.meta.url), 'utf8'));
        const update = extractSections(mkx.productText).find(s => s.key === 'UPDATE').text;
        expect(update.startsWith('Issued 545 AM CDT Mon Sep 28 2026\n\nPatchy fog')).toBe(true);
        expect(stripHeaderStamp(update).startsWith('Patchy fog')).toBe(true);
        // "Updated to discuss ..." (OKX What has changed) is content, not a header.
        const okx = 'Updated to discuss the potential for a coastal storm Sunday \ninto Monday.';
        expect(stripHeaderStamp(okx)).toBe(okx);
    });

    it('leaves a mid-text or differently shaped "Issued at" alone', () => {
        for (const text of [
            'Fog tonight.\nIssued at 528 PM CST Wed Nov 18 2026\n\nMore fog.',
            'Issued at 5 PM, the Flood Watch covers all zones through Thursday.',
            'Issued at 528 PM CST, the advisory runs through Thursday.',
            '(00Z TAF Issuance)\nVFR through the period.',
        ]) {
            expect(stripHeaderStamp(text)).toBe(text);
        }
    });

    it('never empties a section that is only the header line', () => {
        const only = 'Issued at 528 PM CST Wed Nov 18 2026';
        expect(stripHeaderStamp(only)).toBe(only);
    });

    it('still strips the LOX stamp, and leaves the LOX Zulu stamp (annotated instead)', () => {
        expect(stripHeaderStamp('18/104 PM.\n\nCool, below normal temperatures.')).toBe('Cool, below normal temperatures.');
        const aviation = section('LOX', 'AVIATION');
        expect(stripHeaderStamp(aviation)).toBe(aviation); // "18/1736Z." (see the Zulu-stamp test above)
    });
});

describe('sanitizeTranslation — weekday/date pairs', () => {
    const ctx = { office: 'LOX', issuanceTime: LOX_ISSUED };

    it('keeps a valid pair (Sunday, November 15 for a Wed Nov 11 PST issuance)', () => {
        const text = 'Sunday, November 15 should be a pleasant day.';
        expect(sanitizeTranslation(text, ctx)).toBe(text);
    });

    it('drops an invalid date but keeps the weekday', () => {
        expect(sanitizeTranslation('Sunday, November 22 should be a pleasant day.', ctx))
            .toBe('Sunday should be a pleasant day.');
        // Wrong weekday for an in-window date.
        expect(sanitizeTranslation('Rain arrives Monday November 15 in the evening.', ctx))
            .toBe('Rain arrives Monday in the evening.');
    });

    it('window is office-local: -1..+8 days from Nov 11 PST, not the UTC Nov 12', () => {
        // Nov 22 really is a Sunday — it is rejected because it is outside the window.
        expect(sanitizeTranslation('Thursday, November 19 looks dry.', ctx)).toBe('Thursday, November 19 looks dry.');
        expect(sanitizeTranslation('Friday, November 20 looks dry.', ctx)).toBe('Friday looks dry.');
        expect(sanitizeTranslation('Sunday, November 22 looks dry.', ctx)).toBe('Sunday looks dry.');
        // One day before the local issuance date is still in the window.
        expect(sanitizeTranslation('Tuesday, November 10 was warm.', ctx)).toBe('Tuesday, November 10 was warm.');
        expect(sanitizeTranslation('Monday, November 9 was warm.', ctx)).toBe('Monday was warm.');
    });

    it('keeps markdown bold intact', () => {
        expect(sanitizeTranslation('**Sunday, November 22** should be pleasant.', ctx)).toBe('**Sunday** should be pleasant.');
        expect(sanitizeTranslation('**Sunday**, November 22 should be pleasant.', ctx)).toBe('**Sunday** should be pleasant.');
        expect(sanitizeTranslation('Sunday, **November 22** should be pleasant.', ctx)).toBe('Sunday should be pleasant.');
        expect(sanitizeTranslation('**Sunday, November 15** should be pleasant.', ctx)).toBe('**Sunday, November 15** should be pleasant.');
    });

    it('handles ordinals, abbreviated months and a trailing year', () => {
        expect(sanitizeTranslation('Sunday, November 15th is dry.', ctx)).toBe('Sunday, November 15th is dry.');
        expect(sanitizeTranslation('Sunday, Nov. 22nd is dry.', ctx)).toBe('Sunday is dry.');
        expect(sanitizeTranslation('Sunday Nov 15 is dry.', ctx)).toBe('Sunday Nov 15 is dry.');
        expect(sanitizeTranslation('Sunday, November 22, 2026 is dry.', ctx)).toBe('Sunday is dry.');
        expect(sanitizeTranslation('Sunday, November 15, 2026 is dry.', ctx)).toBe('Sunday, November 15, 2026 is dry.');
        expect(sanitizeTranslation('Sunday, November 15, 2025 is dry.', ctx)).toBe('Sunday is dry.');
    });

    it('is valid across the Dec -> Jan year rollover (Jan 1 2027 is a Friday)', () => {
        const dec30 = { office: 'LOX', issuanceTime: '2026-12-30T20:00:00Z' }; // Wed Dec 30 PST
        expect(sanitizeTranslation('Friday, January 1 brings rain.', dec30)).toBe('Friday, January 1 brings rain.');
        expect(sanitizeTranslation('Saturday, January 1 brings rain.', dec30)).toBe('Saturday brings rain.');
    });

    it('does not read "may" the verb as a month', () => {
        const text = 'Monday may 2 inches of rain fall? No: Monday may see showers.';
        expect(sanitizeTranslation(text, ctx)).toBe(text);
    });
});

// Nov 18 2026, live on LOX: the checker cut ranges in half. "Wednesday into
// Thursday, November 18 and 19" lost "November 18" (18 is not a Thursday) and
// left "Wednesday into Thursday and 19"; "November 18–19" left "Thursday–19".
// A date expression that runs on as a range or list is one unit now.
describe('sanitizeTranslation — date ranges and lists', () => {
    // 1:42 PM PST Wed Nov 18 2026 (Nov 19 is a Thursday). Window: Nov 17..26.
    const ctx = { office: 'LOX', issuanceTime: '2026-11-18T21:42:00+00:00' };
    const nov28 = { office: 'LOX', issuanceTime: '2026-11-28T20:00:00Z' }; // Sat Nov 28; Nov 30 is a Monday
    const dec30 = { office: 'LOX', issuanceTime: '2026-12-30T20:00:00Z' }; // Wed Dec 30; Dec 31 is a Thursday
    // A day number left hanging after a weekday: "Thursday and 19", "Thursday–19".
    const ORPHAN_RE = /\b(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\**(?:,?\s+(?:and|or|to|through|into)\s+|\s*[–—/-]\s*)\**\d{1,2}\b/;

    it('keeps the four live LOX strings as written (all consistent with their weekdays)', () => {
        for (const text of [
            'thunderstorms from Wednesday into Thursday, November 18 and 19. This storm',
            '**Wednesday into Thursday, November 18 and 19**.',
            'thunderstorms Wednesday and Thursday, November 18–19.',
            'rain on Thursday, November 19.',
        ]) {
            expect(sanitizeTranslation(text, ctx)).toBe(text);
        }
    });

    it('keeps a range under one weekday when its first date is that weekday', () => {
        for (const text of [
            'Thursday, November 19–20 looks wet.',
            'Thursday, November 19-20 looks wet.',
            'Thursday, November 19 through 21 looks wet.',
            'Thursday, November 19 to 20 looks wet.',
            'Thursday, November 19/20 looks wet.',
            'Thursday, November 19 and 20 looks wet.',
            'Thursday, November 19 or 20 looks wet.',
            'Thursday, Nov. 19–20 looks wet.',
            'Thursday, November 19th and 20th looks wet.',
            'Thursday, November 19, 20 and 21 looks wet.',
            // only the first date has a weekday; a later end is not checked
            // against the window (Nov 30 is +12 days)
            'Thursday, November 19 through 30 looks wet.',
            '**Thursday, November 19–20** looks wet.',
            '**Thursday**, November 19–20 looks wet.',
            'Thursday, **November 19–20** looks wet.',
        ]) {
            expect(sanitizeTranslation(text, ctx)).toBe(text);
        }
    });

    it('keeps a range under two weekdays when the dates line up with both', () => {
        for (const text of [
            'Rain Wednesday into Thursday, November 18 and 19.',
            'Rain Wednesday–Thursday, November 18–19.',
            'Rain Wednesday night into Thursday, November 18–19.',
            '**Wednesday** into **Thursday**, November 18 and 19.',
            // HGX Messages shape (the stored text lost "November 23"): both
            // weekdays bold, "late"/"early" between them.
            'Wetter conditions are likely from late **Monday** through early **Wednesday**, November 23 to 25.',
            'Dry Wednesday, Thursday and Friday, November 18, 19 and 20.',
        ]) {
            expect(sanitizeTranslation(text, ctx)).toBe(text);
        }
    });

    it('keeps cross-month and cross-year ranges', () => {
        expect(sanitizeTranslation('Rain Monday, November 30 through December 1.', nov28)).toBe('Rain Monday, November 30 through December 1.');
        expect(sanitizeTranslation('Rain Monday into Tuesday, November 30 and December 1.', nov28)).toBe('Rain Monday into Tuesday, November 30 and December 1.');
        expect(sanitizeTranslation('Rain Monday, Nov. 30–Dec. 1.', nov28)).toBe('Rain Monday, Nov. 30–Dec. 1.');
        expect(sanitizeTranslation('Rain Thursday, December 31 through January 1.', dec30)).toBe('Rain Thursday, December 31 through January 1.');
        expect(sanitizeTranslation('Rain Thursday, December 31, 2026 through January 1, 2027.', dec30))
            .toBe('Rain Thursday, December 31, 2026 through January 1, 2027.');
    });

    it('removes the whole expression when the dates do not match the weekdays', () => {
        const cases = [
            // shifted a day against "Wednesday into Thursday"
            ['thunderstorms from Wednesday into Thursday, November 19 and 20. This storm', 'thunderstorms from Wednesday into Thursday. This storm'],
            ['Rain Wednesday into Thursday, November 18 and 20.', 'Rain Wednesday into Thursday.'],
            ['thunderstorms Wednesday and Thursday, November 19–20.', 'thunderstorms Wednesday and Thursday.'],
            ['Rain late **Monday** through early **Wednesday**, November 22 to 24.', 'Rain late **Monday** through early **Wednesday**.'],
            // one weekday, wrong first date
            ['Friday, November 19–20 looks dry.', 'Friday looks dry.'],
            ['Thursday, November 18-19 looks dry.', 'Thursday looks dry.'],
            ['Thursday, November 18 through 19 looks dry.', 'Thursday looks dry.'],
            ['Thursday, November 18/19 looks dry.', 'Thursday looks dry.'],
            ['Rain Thursday, November 18 and 19, then clearing.', 'Rain Thursday, then clearing.'],
            // first date outside the -1..+8 day window (Nov 30 for a Nov 18 issuance)
            ['Rain Monday, November 30 through December 1.', 'Rain Monday.'],
            // a dash touching two days that run backwards, ending the clause,
            // is still a (bad) range
            ['Rain Thursday, November 19–18.', 'Rain Thursday.'],
            ['Rain Thursday, November 19/18, then dry.', 'Rain Thursday, then dry.'],
            // spaced dashes are ranges too when the clause ends after the day
            ['Rain Friday, November 19 – 20.', 'Rain Friday.'],
            // a weekday joined through a comma: neither reading fits
            ['Showers end Tuesday, and Thursday, November 18 through 21, stay dry.', 'Showers end Tuesday, and Thursday, stay dry.'],
        ];
        for (const [input, want] of cases) {
            expect(sanitizeTranslation(input, ctx)).toBe(want);
        }
        // cross-month and cross-year with the wrong weekday
        expect(sanitizeTranslation('Rain Tuesday, November 30 through December 1.', nov28)).toBe('Rain Tuesday.');
        expect(sanitizeTranslation('Rain Friday, December 31 through January 1.', dec30)).toBe('Rain Friday.');
        // there is no November 31
        expect(sanitizeTranslation('Rain Monday, November 30–31.', nov28)).toBe('Rain Monday.');
    });

    it('keeps the bold markers balanced when it removes a range', () => {
        expect(sanitizeTranslation('**Wednesday into Thursday, November 19 and 20**.', ctx)).toBe('**Wednesday into Thursday**.');
        expect(sanitizeTranslation('**Friday, November 19–20** looks dry.', ctx)).toBe('**Friday** looks dry.');
        expect(sanitizeTranslation('**Friday**, November 19–20 looks dry.', ctx)).toBe('**Friday** looks dry.');
        expect(sanitizeTranslation('Friday, **November 19–20** looks dry.', ctx)).toBe('Friday looks dry.');
        expect(sanitizeTranslation('**Friday**, **November 19–20** looks dry.', ctx)).toBe('**Friday** looks dry.');
        expect(sanitizeTranslation('**Friday, November 19** and **20** look dry.', ctx)).toBe('**Friday** look dry.');
        expect(sanitizeTranslation('Friday, **November 19**–20 looks dry.', ctx)).toBe('Friday looks dry.');
        // Bold that opens on the date and closes past it cannot be split
        // cleanly; left as written (the old checker never matched it either).
        const open = 'Rain Friday, **November 19 and 20 bring storms**.';
        expect(sanitizeTranslation(open, ctx)).toBe(open);
    });

    it('never leaves a day-number fragment behind', () => {
        const inputs = [];
        for (const pre of ['', 'Wednesday into ', 'Tuesday and ', 'late **Monday** through early ']) {
            for (const wd of ['Thursday', 'Friday', 'Saturday']) {
                for (const date of ['November 18 and 19', 'November 18–19', 'November 18-19', 'November 18 through 20',
                    'November 18 to 19', 'November 18/19', 'November 18 or 19', 'November 27 and 28', 'November 18, 19 and 20']) {
                    inputs.push(`Rain ${pre}${wd}, ${date}. Dry after.`, `**Rain ${pre}${wd}, ${date}**. Dry after.`);
                }
            }
        }
        for (const text of inputs) {
            const out = sanitizeTranslation(text, ctx);
            expect(out).not.toMatch(ORPHAN_RE);
            expect((out.match(/\*\*/g) || []).length % 2).toBe(0);
            expect(sanitizeTranslation(out, ctx)).toBe(out); // idempotent
        }
    });

    it('does not take a quantity or a clock time after the date for a second day', () => {
        // In-window date: nothing to change.
        for (const text of [
            'Gusts Friday, November 20 to 25 mph.',
            'Rain arrives Thursday, November 19 and 1 to 2 inches are possible.',
            'Showers Thursday, November 19 to 10 PM.',
            'Rain Thursday, November 19 and 3 more days of showers.',
            'Rain Thursday, November 19 and 20 percent chances after.',
        ]) {
            expect(sanitizeTranslation(text, ctx)).toBe(text);
        }
        // Wrong weekday: only the date goes, exactly as before ranges were understood.
        expect(sanitizeTranslation('Gusts Saturday, November 20 to 25 mph.', ctx)).toBe('Gusts Saturday to 25 mph.');
        expect(sanitizeTranslation('Rain arrives Friday, November 19 and 1 to 2 inches are possible.', ctx))
            .toBe('Rain arrives Friday and 1 to 2 inches are possible.');
        expect(sanitizeTranslation('Showers Friday, November 19 to 10 PM.', ctx)).toBe('Showers Friday to 10 PM.');
        expect(sanitizeTranslation('Showers Friday, November 19 to 10:30.', ctx)).toBe('Showers Friday to 10:30.');
        // "and 3" cannot be a later November day than the 19th: not a list.
        expect(sanitizeTranslation('Rain Friday, November 19 and 3 more days of showers.', ctx)).toBe('Rain Friday and 3 more days of showers.');
    });

    it('reads a dash or "and" before a count as prose, never deleting the number', () => {
        // In-window first date: nothing to change.
        for (const text of [
            'Rain arrives Thursday, November 19 — 2 rounds of storms are expected.',
            'Rain Thursday, November 19 - 6 hours of steady rain.',
            'Rain **Thursday, November 19** — 12-hour totals near an inch.',
            'Rain Thursday, November 19—24 hours of rain.',
            'Rain Thursday, November 19 — 24-hour totals near an inch.',
            'Rain Wednesday into Thursday, November 19 and 24 hours of showers.',
            'Thursday, November 19 – 20 looks wet.',
        ]) {
            expect(sanitizeTranslation(text, ctx)).toBe(text);
        }
        // Wrong weekday: only the first date goes; the count stays.
        expect(sanitizeTranslation('Rain arrives Friday, November 19 — 2 rounds of storms are expected.', ctx))
            .toBe('Rain arrives Friday — 2 rounds of storms are expected.');
        expect(sanitizeTranslation('Rain Friday, November 19 — 24 hours of rain.', ctx)).toBe('Rain Friday — 24 hours of rain.');
        expect(sanitizeTranslation('Rain Friday, November 19 — 24-hour totals near an inch.', ctx)).toBe('Rain Friday — 24-hour totals near an inch.');
    });

    it('accepts a weekday run joined through a comma, or the run after the comma', () => {
        for (const text of [
            'Showers end Wednesday, and Thursday, November 19 through 21, stay dry.',
            'Dry Wednesday, Thursday and Friday, November 18, 19 and 20.',
        ]) {
            expect(sanitizeTranslation(text, ctx)).toBe(text);
        }
    });

    it('records the limits: a backwards "and" list or a range before a quantity is read as one date', () => {
        // Days that do not run forward are read as not a date, so the number
        // is never removed; with a wrong first date that leaves "and 18".
        expect(sanitizeTranslation('Rain Thursday, November 19 and 18.', ctx)).toBe('Rain Thursday, November 19 and 18.');
        expect(sanitizeTranslation('Rain Friday, November 19 and 18.', ctx)).toBe('Rain Friday and 18.');
        // "20 to 25 mph" reads as a quantity, not as the end of a range.
        expect(sanitizeTranslation('Gusts Friday, November 19 and 20 to 25 mph.', ctx)).toBe('Gusts Friday and 20 to 25 mph.');
    });

    it('leaves separate weekday/date pairs and plain prose alone', () => {
        const text = 'Rain Wednesday, November 18 and Thursday, November 19, then dry Friday, November 20.';
        expect(sanitizeTranslation(text, ctx)).toBe(text);
        expect(sanitizeTranslation('Rain Wednesday, November 18 and Friday, November 19.', ctx)).toBe('Rain Wednesday, November 18 and Friday.');
        const prose = 'Rain **Wednesday** into **Thursday**, with **1 to 2 inches** and gusts to **50 mph** by 10 PM.';
        expect(sanitizeTranslation(prose, ctx)).toBe(prose);
    });

    it('drops a range after "today": only weekdays are checked, and today is not one', () => {
        // Recorded behaviour, not a goal: "today" is not resolved to a weekday,
        // so the range is read against Thursday alone (18 is not a Thursday).
        expect(sanitizeTranslation('Rain today into Thursday, November 18 and 19.', ctx)).toBe('Rain today into Thursday.');
    });
});

describe('sanitizeTranslation — asides about the source', () => {
    const ctx = { office: 'LOX', issuanceTime: LOX_ISSUED };

    it('fixes the exact bad production output', () => {
        const out = sanitizeTranslation(BAD_PRODUCTION_OUTPUT, ctx);
        expect(out).not.toContain('November 22');
        expect(out).not.toContain('source text');
        expect(out).toContain('Sunday should be a pleasant day');
        expect(out).toContain('Another storm system is expected to arrive **Monday**.');
        expect(out).toBe('Sunday should be a pleasant day as a small ridge of high pressure builds over the area, bringing **highs in the mid 60s to lower 70s**, which is very close to typical for this time of year.\n\nAnother storm system is expected to arrive **Monday**.');
    });

    it('removes other source/instruction asides', () => {
        const cases = [
            'Rain ends Friday. Note: the original text reads "03/428 PM," a timestamp. Highs warm Saturday.',
            'Rain ends Friday. The original text reads like a list of times. Highs warm Saturday.',
            'Rain ends Friday. Per these instructions, I kept the wording plain. Highs warm Saturday.',
            'Rain ends Friday. As an AI, I cannot verify the exact timing. Highs warm Saturday.',
            'Rain ends Friday. The stamp at the top appears to be the issuance time. Highs warm Saturday.',
        ];
        for (const text of cases) {
            expect(sanitizeTranslation(text, ctx)).toBe('Rain ends Friday. Highs warm Saturday.');
        }
    });

    it('drops a paragraph the filter empties, and a parenthetical aside', () => {
        const text = 'Rain ends Friday.\n\nNote that the source text lists 11/220 PM as a header time.\n\nHighs warm Saturday.';
        expect(sanitizeTranslation(text, ctx)).toBe('Rain ends Friday.\n\nHighs warm Saturday.');
        expect(sanitizeTranslation('Rain ends Friday (the source text says 11/220 PM) with clearing skies.', ctx))
            .toBe('Rain ends Friday with clearing skies.');
    });

    it('keeps ordinary weather sentences that start with "Note that"', () => {
        const text = 'Note that winds will be strongest near the coast. Note: the original forecast called for heavier rain, but the storm tracked north. The source of the moisture is a tropical system.';
        expect(sanitizeTranslation(text, ctx)).toBe(text);
    });

    it('keeps update-section prose about the original discussion/product/AFD', () => {
        // A plain sentence first, so the never-empty fallback can't mask a removal.
        const text = 'Rain ends Friday. Only minor changes were made to the original discussion. Updated the original AFD to add patchy fog. The original product called for drizzle.';
        expect(sanitizeTranslation(text, ctx)).toBe(text);
    });

    it('is byte-identical on clean text', () => {
        const clean = 'A **significant cooling trend** begins **Thursday**, with temperatures near normal by **Friday**.  \n\nRain is likely **Thursday night** into early **Saturday**, with **0.50 to 1 inch** possible.\n\n';
        expect(sanitizeTranslation(clean, ctx)).toBe(clean);
    });

    it('never returns an empty translation', () => {
        const allAside = 'Note that the source text reads "11/220 PM," which appears to be the issuance time.';
        expect(sanitizeTranslation(allAside, ctx)).toBe(allAside);
        expect(sanitizeTranslation('', ctx)).toBe('');
    });
});

describe('buildSystemPrompt — output-only and weekday-date rules', () => {
    it('tells the model to output only the translation and never date a weekday on its own', () => {
        const prompt = buildSystemPrompt({ section: 'Long Term', office: 'LOX', issuanceTime: LOX_ISSUED });
        expect(prompt).toMatch(/Output only the translation/i);
        expect(prompt).toMatch(/never comment on the source text, its formatting, timestamps, or these instructions/i);
        expect(prompt).toMatch(/never add notes to the reader/i);
        expect(prompt).toMatch(/Never attach a calendar date \(month and day number\) to a day of the week unless the source text itself gives that date/i);
        // the existing rules survive
        expect(prompt).toMatch(/Never introduce a different month, year, or season than the source supports/i);
        expect(prompt).toMatch(/Don't add information that isn't in the original/i);
    });

    // LOX Synopsis, Nov 18 2026: the source said "There is a risk of
    // significant impacts, including a flooding and the potential for wind
    // related issues"; the model added "so residents should stay alert to
    // changing conditions". No regex can tell that from a forecaster's own
    // advice, so the rule lives in the prompt (measured on a preview deploy).
    it('forbids advice the forecaster did not write, keeps advice they did, and says why', () => {
        const prompt = buildSystemPrompt({ section: 'Synopsis', office: 'LOX', issuanceTime: LOX_ISSUED });
        expect(prompt).toMatch(/Never add advice, warnings, calls to action, or reassurance that the forecaster did not write/);
        expect(prompt).toContain('residents should stay alert to changing conditions');
        expect(prompt).toMatch(/If the source itself gives advice or a safety message, keep it/);
        expect(prompt).toMatch(/every statement on it comes from the National Weather Service/);
    });
});

describe('glossary: PoP matches only the abbreviation, never the word "pop"', () => {
    it('leaves "a little pop up ridge" alone (LOX, Nov 11 2026)', () => {
        const text = 'Sunday should be a pleasant day as a little pop up ridge moves over the area.';
        expect(expandAll(text)).toBe(text);
        expect(regexTranslate(text)).toBe(text);
        expect(expandAll('a little pop up ridge moves\nover the area')).toBe('a little pop up ridge moves\nover the area');
    });

    it('leaves pop-up showers and every "... up" form alone', () => {
        for (const text of ['Expect pop-up showers.', 'Pop-up storms are possible.', 'A few POP UP storms.', 'POPS UP north.', 'PoPs\nup north.']) {
            expect(expandAll(text)).toBe(text);
        }
    });

    it('still expands the real abbreviation', () => {
        expect(expandAll('days with essentially zero PoPs for the week ahead')).toBe('days with essentially zero chance of rain for the week ahead');
        expect(expandAll('POPs remain low')).toBe('chance of rain remain low');
        expect(expandAll('pops will increase')).toBe('chance of rain will increase');
        // "up to" after the abbreviation is a quantity, not "pop-up".
        expect(expandAll('PoPs up to 40 percent')).toBe('chance of rain up to 40 percent');
        expect(expandAll('a 30 percent PoP')).toBe('a 30 percent chance of rain');
        expect(expandAll('POP of 40 percent')).toBe('chance of rain of 40 percent');
        expect(expandAll('Pops rise Friday')).toBe('chance of rain rise Friday');
        expect(expandAll('.PRELIMINARY POINT TEMPS/POPS...')).toBe('.PRELIMINARY POINT temperatures/chance of rain...');
    });

    it('reaches the shadcn client fallback translator (the one readers see)', () => {
        const html = translateToPlainEnglish(LONG_TERM, 'America/Los_Angeles', LOX_ISSUED);
        expect(html).toContain('pop up ridge');
        expect(html).not.toContain('chance of rain up ridge');
    });
});

// The National Desk dates its window in US Eastern with no office (Nov 2026).
describe('sanitizeTranslation — explicit time zone', () => {
    // 05:23Z Nov 12 = Thu Nov 12 in the East but still Wed Nov 11 in Honolulu.
    const ISSUED = '2026-11-12T05:23:00+00:00';
    it('uses the zone it is given, with no office', () => {
        // Nov 20 2026 is a Friday: day +8 from Thu Nov 12 (inside the window),
        // day +9 from Wed Nov 11 (outside it).
        const text = 'Drier air arrives Friday, November 20.';
        expect(sanitizeTranslation(text, { issuanceTime: ISSUED, timeZone: 'America/New_York' })).toBe(text);
        expect(sanitizeTranslation(text, { office: 'HFO', issuanceTime: ISSUED })).toBe('Drier air arrives Friday.');
        expect(sanitizeTranslation(text, { office: 'HFO', issuanceTime: ISSUED, timeZone: 'America/New_York' })).toBe(text);
    });
    it('still drops impossible pairs and asides', () => {
        const out = sanitizeTranslation('Storms build today. Note that the source text uses abbreviations. Clearing by Sunday, November 22.',
            { issuanceTime: ISSUED, timeZone: 'America/New_York' });
        expect(out).toBe('Storms build today. Clearing by Sunday.');
    });
});

// Nov 18 2026 (PR #48 measurement on a preview deploy): sentences about the
// document or the calendar rose from 4 of 21 sections to 11 of 33. The output
// filter removes only sentences that are ENTIRELY narration (no forecast
// content), matched as a whole sentence; a sentence that mixes narration with
// forecast content is left for the prompt to prevent.
describe('sanitizeTranslation — sentences only about the document or the calendar', () => {
    const HGX = { office: 'HGX', issuanceTime: '2026-11-18T23:36:00+00:00' };
    const OKX = { office: 'OKX', issuanceTime: '2026-11-18T23:42:00+00:00' };

    it('removes the issue-time sentence that opens HGX Marine (real output)', () => {
        const rest = 'A **Small Craft Advisory** is in effect for offshore waters 20 to 60 nautical miles out, through late **Thursday** night. Northeast winds near **20 knots** and seas of **5 to 8 feet** are expected over the Gulf waters through Thursday.\n\nConditions are forecast to improve as the week goes on.';
        const text = 'This marine forecast was issued at 12:01 PM on Wednesday, November 18, 2026, by the National Weather Service office in Houston/Galveston. ' + rest;
        expect(sanitizeTranslation(text, HGX)).toBe(rest);
    });

    it('removes calendar reasoning: OKX What has changed and Messages, HGX Messages (real outputs)', () => {
        const changed = 'The forecast office has updated its outlook to highlight the possibility of a coastal storm affecting the area from Sunday into Monday.';
        expect(sanitizeTranslation(changed + ' Sunday would fall on November 22 and Monday on November 23, based on the issue date of Wednesday, November 18.', OKX))
            .toBe(changed);
        const messages = 'The weather looks mostly sunny and dry through Saturday, with temperatures running above what is typical for this time of year. Since this forecast was issued on Wednesday, November 18, that stretch covers the rest of this week and into the weekend.\n\nConditions could change by Sunday, when a coastal low pressure system may approach the area.';
        expect(sanitizeTranslation(messages, OKX)).toBe('The weather looks mostly sunny and dry through Saturday, with temperatures running above what is typical for this time of year.\n\nConditions could change by Sunday, when a coastal low pressure system may approach the area.');
        const hgx = 'Dry weather is expected to hold through the rest of the work week, with temperatures gradually warming up as the days go on. Since today is Wednesday, November 18, the work week runs through Friday, November 20.\n\nA weak cold front arrives on **Sunday**.';
        expect(sanitizeTranslation(hgx, { office: 'HGX', issuanceTime: '2026-11-18T18:18:00+00:00' }))
            .toBe('Dry weather is expected to hold through the rest of the work week, with temperatures gradually warming up as the days go on.\n\nA weak cold front arrives on **Sunday**.');
    });

    it('removes other pure issue-time sentences (zones, offices, bold, "updated")', () => {
        for (const sentence of [
            'This area forecast discussion was issued at 3:05 AM Pacific time on Thursday, November 19, 2026.',
            'The forecast was updated at 9:15 PM CST.',
            '**This aviation forecast** was issued at 5:28 PM Central Standard Time on **Wednesday**.',
            'This discussion from the Los Angeles/Oxnard office was issued Wednesday afternoon.',
            'The update was issued at 12:01 PM by the NWS office in Peachtree City (FFC).',
        ]) {
            expect(sanitizeTranslation(`Rain ends Friday. ${sentence} Highs warm Saturday.`, HGX)).toBe('Rain ends Friday. Highs warm Saturday.');
        }
    });

    it('leaves every sentence that also carries forecast content (the prompt handles those)', () => {
        for (const sentence of [
            // narration + content in one sentence (real Nov 18 outputs)
            'This aviation forecast, issued Wednesday evening, November 18, 2026, at 5:28 PM Central time, warns that flying conditions will get worse tonight.',
            'This hydrology outlook from the National Weather Service Seattle office, issued Wednesday, November 18, 2026, anticipates that rivers in the area will stay within their banks through next Wednesday, November 25.',
            'This aviation discussion from the Los Angeles/Oxnard office covers a stormy stretch for Thursday, November 19, and into Friday.',
            'Since this forecast was issued on Wednesday, November 18, the work week refers to the days ahead, and the warming trend means each day should be a bit milder than the last.',
            'Since this is a forecast for the week starting from Wednesday, November 18, the warmth will be noticeable compared with what is typical for this time of year.',
            'They are highly confident that gusty south to west winds and light rain, which the forecast abbreviates as light rain showers, will begin this afternoon and continue through the period.',
            // the TAF cycle it covers is header content; left for the prompt
            'This aviation forecast was issued at 6:35 PM Eastern on Wednesday, November 18, 2026, and it covers the 00Z terminal forecasts, which correspond to 7 PM Eastern.',
            // table legends key the numbers that remain; left for the prompt
            'The columns show, for each location, the high and low temperatures for the first two periods, followed by the chance of precipitation for those same periods.',
            // forecast content that mentions the NWS, issuing or updating
            'The National Weather Service in Miami has issued a Small Craft Advisory for all local waters of South Florida, which remains in effect through Thursday night, November 19.',
            'Because those high elevations are remote and the impacts are expected to be limited, no snow-related products will be issued.',
            'Check the local National Weather Service office and the National Hurricane Center for updates through the weekend.',
            'The National Weather Service does not expect severe weather that would require trained spotters to go out and report conditions, so no spotter activation is planned for now.',
            'Spotters are encouraged to report any significant weather or impacts to the National Weather Service following standard procedures.',
            'For Harry Reid International Airport, the forecast package issued for 10 AM Pacific time on Thursday, November 19, calls for easterly winds under **10 knots** into early afternoon.',
            'As of 1:24 PM Wednesday, the main message is that a weather system could bring rain and gusty winds to central North Carolina this weekend, though how much impact it has is still very uncertain.',
            'The forecast office has updated its outlook to highlight the possibility of a coastal storm affecting the area from Sunday into Monday.',
            'The forecast was updated to add patchy fog.',
            'This update was issued to account for the Flood Watch.',
            'Since today is Wednesday, the work week brings dry weather.',
        ]) {
            const text = `Rain ends Friday. ${sentence} Highs warm Saturday.`;
            expect(sanitizeTranslation(text, HGX)).toBe(text);
        }
    });

    it('still never returns an empty translation', () => {
        const only = 'This marine forecast was issued at 12:01 PM on Wednesday, November 18, 2026.';
        expect(sanitizeTranslation(only, HGX)).toBe(only);
    });
});
