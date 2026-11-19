// ─── shadcn edition: behavioral coverage ────────────────────────────
// Imports shadcn/src/lib modules directly (their imports are relative, not
// Vite-alias, precisely so this suite can load them). The code-identical
// forks are locked by tests/shadcn-parity.test.js; these tests cover the
// functions that intentionally differ from app.js (timezone as a parameter,
// segment-based annotation) plus the pure alert helpers.

import { describe, it, expect } from 'bun:test';

import {
    annotateSegments,
    extractTakeaway,
    parseSections,
    reorderSections,
    sectionDomId,
    synopsisTakeaway,
    translateToPlainEnglish,
} from '../shadcn/src/lib/afd.js';
import { GLOSSARY } from '../docs/js/glossary.js';
import { alertIsFromOffice, alertWindow, classifyAlertKind, findNearestOffice } from '../shadcn/src/lib/nws.js';
import { formatTranslationHTML } from '../shadcn/src/lib/ai.js';
import { formatInZone, formatIssueTime } from '../shadcn/src/lib/format.js';

const FIXTURE = await Bun.file(new URL('./fixtures/afd/lox-classic-synopsis.txt', import.meta.url)).text();

describe('parseSections (via the shadcn port)', () => {
    it('parses the LOX fixture into named sections', () => {
        const { sections } = parseSections(FIXTURE);
        const keys = sections.map(s => s.key);
        expect(keys).toContain('Synopsis');
        expect(keys).toContain('Short Term');
        expect(keys.length).toBeGreaterThanOrEqual(4);
        for (const s of sections) expect(s.text.length).toBeGreaterThan(0);
    });
});

describe('translateToPlainEnglish (tz as a parameter)', () => {
    it('expands abbreviations and bolds key figures', () => {
        const html = translateToPlainEnglish('Gusty wnds to 45 mph expected aftn.', 'America/Los_Angeles');
        expect(html).toContain('winds');
        expect(html).toContain('afternoon');
        expect(html).toContain('<strong>45 mph</strong>');
    });

    it('converts Zulu times using the given zone, not a global', () => {
        // 18Z is 1 PM in Chicago (CDT) and 11 AM in Los Angeles (PDT); assert
        // the two zones give different renderings of the same input.
        const chi = translateToPlainEnglish('Storms develop by 18Z.', 'America/Chicago');
        const lax = translateToPlainEnglish('Storms develop by 18Z.', 'America/Los_Angeles');
        expect(chi).not.toBe(lax);
        expect(chi).not.toContain('18Z');
    });

    it('escapes HTML from the source text', () => {
        const html = translateToPlainEnglish('Winds <script>alert(1)</script> increase.', 'America/Los_Angeles');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });
});

describe('annotateSegments', () => {
    it('segments reconstruct the original text exactly', () => {
        const text = 'Deep marine layer with weak onshore flow and low CAPE today.';
        const segments = annotateSegments(text);
        expect(segments.map(s => s.text).join('')).toBe(text);
    });

    it('marks known glossary terms with their RAW definitions (no HTML escaping)', () => {
        const segments = annotateSegments('CAPE values increase.');
        const jargon = segments.find(s => s.type === 'jargon' && s.text === 'CAPE');
        expect(jargon).toBeDefined();
        // React escapes on render; a pre-escaped tip would double-escape.
        expect(jargon.tip).toBe(GLOSSARY['CAPE']);
        expect(jargon.tip).not.toContain('&amp;');
    });

    it('prefers the longer term on overlapping matches', () => {
        // 'onshore flow' is a glossary key; 'onshore' alone must not split it.
        const segments = annotateSegments('Weak onshore flow tonight.');
        const jargonTexts = segments.filter(s => s.type === 'jargon').map(s => s.text);
        expect(jargonTexts).toContain('onshore flow');
    });
});

describe('extractTakeaway', () => {
    it('pulls the first sentences of the synopsis', () => {
        const { sections } = parseSections(FIXTURE);
        const takeaway = extractTakeaway(sections, 'America/Los_Angeles');
        expect(takeaway.toLowerCase()).toContain('onshore flow');
    });

    it('shows two real sentences when the synopsis opens with its issuance stamp', () => {
        // LOX, Nov 18 2026: the stamp used to fill one of the two slots.
        const html = extractTakeaway([{ key: 'Synopsis', text: '18/104 PM.\n\nCool, below normal temperatures will be ongoing through the week.\nA moderate to strong low pressure system will bring gusty winds.' }], 'America/Los_Angeles');
        expect(html).not.toContain('18/104');
        expect(html).toContain('Cool, below normal');
        expect(html).toContain('gusty winds');
    });
});

describe('time-zone labels (formatInZone)', () => {
    const at = new Date('2026-11-18T19:51:00Z');
    const opts = (timeZone) => ({ hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' });

    it('names Guam and American Samoa time as NWS does', () => {
        expect(formatInZone(at, opts('Pacific/Guam'))).toBe('5:51 AM ChST');
        expect(formatInZone(at, opts('Pacific/Pago_Pago'))).toBe('8:51 AM SST');
        expect(formatIssueTime(at, 'Pacific/Guam')).toBe('Thursday, November 19 at 5:51 AM ChST');
    });

    it('is toLocaleString everywhere else, and without a zone name', () => {
        for (const tz of ['America/Los_Angeles', 'America/Chicago', 'Pacific/Honolulu', 'America/Anchorage', 'America/Puerto_Rico']) {
            expect(formatInZone(at, opts(tz))).toBe(at.toLocaleString('en-US', opts(tz)));
        }
        const noName = { hour: 'numeric', timeZone: 'Pacific/Guam' };
        expect(formatInZone(at, noName)).toBe(at.toLocaleString('en-US', noName));
    });

    it('converts Zulu times in Guam text to ChST', () => {
        const html = translateToPlainEnglish('Showers increase after 12Z.', 'Pacific/Guam', '2026-11-18T19:51:00Z');
        expect(html).toContain('ChST');
        expect(html).not.toContain('GMT+10');
    });
});

// Real synopses (NWS AFDs, Nov 12–18 2026), verbatim.
describe('synopsisTakeaway (the synopsis fallback)', () => {
    const LOX_NOV18 = '18/104 PM.\n\nCool, below normal temperatures will be ongoing through the week.\nA moderate to strong low pressure system will bring gusty winds, \nwidespread rain, mountain snow, and a chance for thunderstorms \nWednesday into Thursday. There is a risk of significant impacts, \nincluding a flooding and the potential for wind related issues. \nVery large surf and high tides will continue, with ongoing surf \nand flooding hazards at the coast.';

    it('leads with the first hazard sentence when the opening one names none (LOX)', () => {
        expect(synopsisTakeaway(LOX_NOV18)).toBe(
            'A moderate to strong low pressure system will bring gusty winds, widespread rain, mountain snow, and a chance for thunderstorms Wednesday into Thursday. '
            + 'There is a risk of significant impacts, including a flooding and the potential for wind related issues.'
        );
    });

    it('keeps the opening two sentences when the opening one names a hazard', () => {
        const t = 'Strong gusty winds will develop over island mountain ranges today. Wind speeds will exceed advisory thresholds. Showers favor windward areas.';
        expect(synopsisTakeaway(t)).toBe('Strong gusty winds will develop over island mountain ranges today. Wind speeds will exceed advisory thresholds.');
    });

    it('keeps the opening two sentences when no early sentence names a hazard (HFO)', () => {
        const t = 'Another high pressure system just north of the Hawaiian Islands will drift southeast and weaken through Thursday. A stronger high builds in north of the state by Friday, briefly increasing trade wind speeds. Two passing upper level disturbances will keep wet trade wind weather in the forecast through the end of this week.';
        expect(synopsisTakeaway(t)).toBe('Another high pressure system just north of the Hawaiian Islands will drift southeast and weaken through Thursday. A stronger high builds in north of the state by Friday, briefly increasing trade wind speeds.');
    });

    it('does not lead with a hazard that is winding down or ruled out (LOX Nov 14)', () => {
        const t = '13/807 PM.\n\nMultiple periods of light to moderate rain is expected well into next week, with the first round ending by Saturday morning. There will be a break this weekend, with the next round set for around Monday, then the next around Thursday. The risk of significant impacts and flooding with any of these storms is low, with generally light to moderate rain.';
        expect(synopsisTakeaway(t)).toMatch(/^Multiple periods of light to moderate rain/);
    });

    it('starts one earlier when the hazard sentence leans on the one before (LOX Nov 15)', () => {
        const t = '14/509 PM.\n\nMultiple periods of light to moderate rain are expected this coming week. Dry conditions will prevail through Sunday, with the next round of wet conditions set for Sunday night into Monday night, followed by Wednesday night into Thursday night. The risk of significant impacts and flooding exists with the second storm system, as moderate to heavy rain will be possible. Temperatures will remain at or below normal.';
        expect(synopsisTakeaway(t)).toMatch(/^Dry conditions will prevail through Sunday.*The risk of significant impacts and flooding exists with the second storm system/);
    });

    it('keeps two sentences when the hazard sentence is the last one (SEW)', () => {
        const t = 'An upper level low drifting inland to the south will maintain light showers through tonight before high pressure brings drier conditions through early Saturday. Chances for precipitation increase Sunday and beyond, alongside breezy winds and chances for coastal flooding due to higher astronomical tides.';
        expect(synopsisTakeaway(t)).toBe(t);
    });

    it('looks only at the first three sentences', () => {
        const t = 'Dry today. Dry tomorrow. Dry Friday. Gusty winds next week.';
        expect(synopsisTakeaway(t)).toBe('Dry today. Dry tomorrow.');
    });

    it('keeps an inline "Key Messages:" list in the forecaster\'s order (MSO)', () => {
        const t = 'KEY MESSAGES:\n\n- Localized snow showers and valley rain/snow mix late tonight into\nThursday morning.\n\n- Colder temperatures, with areas of accumulating snow Friday into\nSaturday.';
        expect(synopsisTakeaway(t)).toMatch(/^KEY MESSAGES: - Localized snow showers/);
    });

    it('never splits a decimal or a number out of a sentence', () => {
        const t = 'Rain rates of 0.75 inches per hour are possible. Totals reach 1.5 inches. Drier next week.';
        expect(synopsisTakeaway(t)).toBe('Rain rates of 0.75 inches per hour are possible. Totals reach 1.5 inches.');
    });
});

describe('reorderSections + sectionDomId', () => {
    it('puts Active Alerts first only when alerts are live', () => {
        const sections = [
            { key: 'Synopsis', text: 'a' },
            { key: 'Active Alerts', text: 'High Surf Advisory.' },
        ];
        expect(reorderSections(sections, 'LOX', true)[0].key).toBe('Active Alerts');
        expect(reorderSections(sections, 'LOX', false).at(-1).key).toBe('Active Alerts');
    });

    it('mints URL-safe ids matching the vanilla scheme', () => {
        expect(sectionDomId('Active Alerts')).toBe('section-active-alerts');
        expect(sectionDomId('Fire Weather')).toBe('section-fire-weather');
    });
});

describe('alert helpers', () => {
    it('classifies unknown events as advisory (vanilla default)', () => {
        expect(classifyAlertKind('Air Quality Alert')).toBe('advisory');
        expect(classifyAlertKind('Red Flag Warning')).toBe('warning');
        expect(classifyAlertKind('Freeze Watch')).toBe('watch');
        expect(classifyAlertKind('Special Weather Statement')).toBe('statement');
    });

    it('distinguishes upcoming windows from in-effect ones', () => {
        const now = Date.UTC(2026, 8, 10, 18, 0);
        const future = alertWindow(
            { onset: '2026-09-11T02:00:00Z', ends: '2026-09-11T12:00:00Z' },
            'America/Los_Angeles', now);
        expect(future.upcoming).toBe(true);
        expect(future.label).toContain('→');
        const active = alertWindow(
            { onset: '2026-09-10T02:00:00Z', ends: '2026-09-11T12:00:00Z' },
            'America/Los_Angeles', now);
        expect(active.upcoming).toBe(false);
        expect(active.label.startsWith('until ')).toBe(true);
    });

    it('finds the nearest office by coordinates', () => {
        expect(findNearestOffice(34.05, -118.24)).toBe('LOX');   // Los Angeles
        expect(findNearestOffice(41.88, -87.63)).toBe('LOT');    // Chicago
    });

    it('finds the new offices too, Guam and Puerto Rico included', () => {
        expect(findNearestOffice(13.48, 144.79)).toBe('GUM');    // Hagåtña
        expect(findNearestOffice(18.47, -66.11)).toBe('SJU');    // San Juan
        expect(findNearestOffice(-14.28, -170.70)).toBe('PPG');  // Pago Pago
        expect(findNearestOffice(58.30, -134.42)).toBe('AJK');   // Juneau
        expect(findNearestOffice(42.65, -73.75)).toBe('ALY');    // Albany
    });
});

describe('alertIsFromOffice', () => {
    const alert = (wmo, senderName = '') => ({ senderName, parameters: wmo ? { WMOidentifier: [wmo] } : {} });

    it('matches on the issuing office in the WMO heading', () => {
        expect(alertIsFromOffice(alert('WWUS81 KOKX 181200', 'NWS Upton NY'), 'OKX')).toBe(true);
        expect(alertIsFromOffice(alert('WWUS81 KBOX 181200', 'NWS Boston/Norton MA'), 'OKX')).toBe(false);
        // Alaska zone-coded alerts (AWIPS NPWALU) still name PAFC as issuer.
        expect(alertIsFromOffice(alert('WWAK72 PAFC 181740', 'NWS Anchorage AK'), 'AFC')).toBe(true);
        expect(alertIsFromOffice(alert('WHGM70 PGUM 181200', 'NWS Tiyan GU'), 'GUM')).toBe(true);
    });

    it('falls back to the sender fragment when there is no heading', () => {
        expect(alertIsFromOffice(alert(null, 'NWS New York NY'), 'OKX')).toBe(true);
        expect(alertIsFromOffice(alert(null, 'NWS Boston/Norton MA'), 'OKX')).toBe(false);
    });
});

describe('formatTranslationHTML', () => {
    it('renders markdown bold and paragraphs, escaping the rest', () => {
        const html = formatTranslationHTML('**Windy** afternoon.\n\nCalmer <b>night</b>.');
        expect(html).toBe('<p><strong>Windy</strong> afternoon.</p><p>Calmer &lt;b&gt;night&lt;/b&gt;.</p>');
    });
});
