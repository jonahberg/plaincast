// ─── Two sections never share a display key (Nov 18 2026) ───────────
// SECTION_NAMES maps both NEAR TERM and SHORT TERM to "Short Term". JAX, OUN
// and HUN wrote both that day, so the edition's translation set could never
// be complete (two sections, one map key) and one section's translation was
// dropped; on JAX the lost one, Near Term, carried the Flood Watch. Every
// parser copy now names a product's sections with sectionDisplayKeys: the
// section a name belongs to keeps it, any other takes its own header
// ("Near Term"), then an ordinal. A product without a repeat is unchanged, so
// stored translations keyed "Short Term" still match.

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseSections, reorderSections, sectionDisplayKeys } from '../shadcn/src/lib/afd.js';
import { parseSections as legacyParse } from './helpers.js';
import { translatableSections } from '../api/_translatable.js';
import { editionSections, buildSsrHtml } from '../api/office-page.js';
import { buildSectionIndex, findMatchingSection } from '../api/translate.js';

const live = (code) => JSON.parse(readFileSync(new URL(`./fixtures/afd/live-2026-11-18/${code}.json`, import.meta.url), 'utf8'));

describe('sectionDisplayKeys', () => {
    it('NEAR TERM beside SHORT TERM is "Near Term", in either order', () => {
        expect(sectionDisplayKeys(['NEAR TERM', 'SHORT TERM'])).toEqual(['Near Term', 'Short Term']);
        expect(sectionDisplayKeys(['SHORT TERM', 'NEAR TERM'])).toEqual(['Short Term', 'Near Term']);
    });

    it('a lone NEAR TERM or SHORT TERM keeps "Short Term" (stored translations still match)', () => {
        expect(sectionDisplayKeys(['SYNOPSIS', 'NEAR TERM', 'LONG TERM'])).toEqual(['Synopsis', 'Short Term', 'Long Term']);
        expect(sectionDisplayKeys(['SYNOPSIS', 'SHORT TERM', 'LONG TERM'])).toEqual(['Synopsis', 'Short Term', 'Long Term']);
    });

    it('other repeats: the name stays with its own header, then an ordinal', () => {
        expect(sectionDisplayKeys(['EXTENDED', 'LONG TERM'])).toEqual(['Extended', 'Long Term']);
        expect(sectionDisplayKeys(['AVIATION', 'AVIATION', 'AVIATION'])).toEqual(['Aviation', 'Aviation (2)', 'Aviation (3)']);
        expect(sectionDisplayKeys(['HYDROLOGY', 'HYDROLOGY'])).toEqual(['Hydrology', 'Hydrology (2)']);
    });

    it('is deterministic and leaves products without a repeat exactly as named before', () => {
        const raw = ['KEY MESSAGES', 'DISCUSSION', 'PRELIMINARY POINT TEMPS/POPS', 'WATCHES/WARNINGS/ADVISORIES'];
        expect(sectionDisplayKeys(raw)).toEqual(['Messages', 'Discussion', 'Preliminary point temps/pops', 'Active Alerts']);
        expect(sectionDisplayKeys([...raw])).toEqual(sectionDisplayKeys(raw));
    });
});

describe('real JAX, OUN and HUN (Nov 18 2026): both sections parse, translate and render', () => {
    for (const code of ['JAX', 'OUN', 'HUN']) {
        const { productText } = live(code);

        it(`${code}: the client and legacy parsers give Near Term and Short Term`, () => {
            for (const parse of [parseSections, legacyParse]) {
                const keys = parse(productText).sections.map(s => s.key);
                expect(keys.slice(0, 3)).toEqual(['Messages', 'Near Term', 'Short Term']);
                expect(new Set(keys).size).toBe(keys.length);
            }
        });

        it(`${code}: the edition selects both, under distinct keys (a set can be complete)`, () => {
            const keys = translatableSections(productText).map(s => s.key);
            expect(keys).toContain('Near Term');
            expect(keys).toContain('Short Term');
            expect(new Set(keys).size).toBe(keys.length);
        });

        it(`${code}: the single-section endpoint verifies each under its own label`, () => {
            const products = [{ sections: buildSectionIndex(productText) }];
            for (const s of parseSections(productText).sections.filter(x => x.key === 'Near Term' || x.key === 'Short Term')) {
                expect(findMatchingSection(s.text, products).sectionKey).toBe(s.key);
            }
        });

        it(`${code}: the server pages print both headings`, () => {
            const names = editionSections(productText).map(s => s.name);
            expect(names).toContain('Near Term');
            expect(names).toContain('Short Term');
            const html = buildSsrHtml(code, code, productText, null, '');
            expect(html).toContain('<h2 class="section-title">Near Term</h2>');
            expect(html).toContain('<h2 class="section-title">Short Term</h2>');
        });
    }

    it('JAX: the Near Term section, the one that was dropped, carries the Flood Watch', () => {
        const near = translatableSections(live('JAX').productText).find(s => s.key === 'Near Term');
        expect(near.text).toMatch(/Flood Watch/);
    });

    it('Near Term sorts with Short Term, not after every other section', () => {
        const sections = parseSections(live('JAX').productText).sections;
        const order = reorderSections(sections, 'JAX', false).map(s => s.key);
        expect(order.indexOf('Near Term')).toBeLessThan(order.indexOf('Long Term'));
        expect(order.indexOf('Near Term')).toBe(order.indexOf('Short Term') - 1);
    });

    it('an office with only one of the two is unchanged', () => {
        const only = live('LOT').productText;
        const before = parseSections(only).sections.map(s => s.key);
        expect(before).not.toContain('Near Term');
        const lox = parseSections(live('LOX').productText).sections.map(s => s.key);
        expect(lox).toContain('Short Term');
        expect(lox).not.toContain('Near Term');
    });
});
