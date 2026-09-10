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
    translateToPlainEnglish,
} from '../shadcn/src/lib/afd.js';
import { GLOSSARY } from '../docs/js/glossary.js';
import { alertWindow, classifyAlertKind, findNearestOffice } from '../shadcn/src/lib/nws.js';
import { formatTranslationHTML } from '../shadcn/src/lib/ai.js';

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
});

describe('formatTranslationHTML', () => {
    it('renders markdown bold and paragraphs, escaping the rest', () => {
        const html = formatTranslationHTML('**Windy** afternoon.\n\nCalmer <b>night</b>.');
        expect(html).toBe('<p><strong>Windy</strong> afternoon.</p><p>Calmer &lt;b&gt;night&lt;/b&gt;.</p>');
    });
});
