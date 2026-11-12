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

    it('window is office-local: -1..+10 days from Nov 11 PST, not the UTC Nov 12', () => {
        // Nov 22 really is a Sunday — it is rejected only because it is +11 days.
        expect(sanitizeTranslation('Saturday, November 21 looks dry.', ctx)).toBe('Saturday, November 21 looks dry.');
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
