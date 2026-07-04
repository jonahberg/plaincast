import { describe, it, expect } from 'bun:test';
import {
    confidenceScore,
    confidenceWord,
    confidenceDirection,
    buildTimelineEntries,
} from '../docs/js/timeline.js';
import { computeDiff } from '../docs/js/diff.js';
import { parseSections } from './helpers.js';

// parseSections here is the DOM-free copy in helpers.js — the same injection
// seam app.js uses with its own parser.
const deps = { parseSections, computeDiff };

describe('confidenceScore', () => {
    it('returns null when the text has no confidence language', () => {
        expect(confidenceScore('Sunny skies. Highs near 80. Light winds.')).toBeNull();
    });
    it('scores explicit high-confidence language toward 100', () => {
        const s = confidenceScore('High confidence in the warming trend. Models show good agreement.');
        expect(s).toBeGreaterThanOrEqual(75);
    });
    it('scores explicit uncertainty toward 0', () => {
        const s = confidenceScore('Low confidence. The pattern remains highly uncertain with model disagreement.');
        expect(s).toBeLessThan(30);
    });
    it('handles empty and non-string input', () => {
        expect(confidenceScore('')).toBeNull();
        expect(confidenceScore(null)).toBeNull();
        expect(confidenceScore(undefined)).toBeNull();
    });
});

describe('confidenceWord', () => {
    it('maps scores to the four ink words', () => {
        expect(confidenceWord(90)).toBe('High');
        expect(confidenceWord(60)).toBe('Moderate');
        expect(confidenceWord(35)).toBe('Mixed');
        expect(confidenceWord(10)).toBe('Low');
    });
    it('passes null through', () => {
        expect(confidenceWord(null)).toBeNull();
    });
});

describe('confidenceDirection', () => {
    it('reads small wobbles as steady', () => {
        expect(confidenceDirection(50, 60)).toBe('steady');
        expect(confidenceDirection(50, 41)).toBe('steady');
    });
    it('detects rising and falling confidence', () => {
        expect(confidenceDirection(30, 70)).toBe('rising');
        expect(confidenceDirection(70, 30)).toBe('falling');
    });
    it('returns null when either issuance had no confidence language', () => {
        expect(confidenceDirection(null, 50)).toBeNull();
        expect(confidenceDirection(50, null)).toBeNull();
    });
});

const OLD_AFD = `000
FXUS66 KLOX 240825
AFDLOX

.SYNOPSIS...High pressure keeps the region dry and mild through midweek. Confidence is high in the overall pattern with good agreement among the models.

&&

.SHORT TERM...Dry conditions continue tonight with patchy fog developing along the coast after midnight and clearing by mid morning.

&&

.AVIATION...VFR conditions expected through the period at all terminals.

SMITH

$$`;

const NEW_AFD = `000
FXUS66 KLOX 241825
AFDLOX

.SYNOPSIS...A cold front now arrives Thursday bringing showers and cooler temperatures. There is still uncertainty in the timing and the models diverge on rainfall amounts.

&&

.SHORT TERM...Dry conditions continue tonight with patchy fog developing along the coast after midnight and clearing by mid morning.

&&

.AVIATION...VFR conditions expected through the period at all terminals.

JONES

$$`;

describe('buildTimelineEntries', () => {
    const products = [
        { id: 'new-1', time: new Date('2026-03-24T18:25:00Z'), text: NEW_AFD },
        { id: 'old-1', time: new Date('2026-03-24T08:25:00Z'), text: OLD_AFD },
    ];

    it('pairs consecutive issuances newest-first', () => {
        const entries = buildTimelineEntries(products, deps);
        expect(entries.length).toBe(1);
        expect(entries[0].id).toBe('new-1');
        expect(entries[0].prevId).toBe('old-1');
    });

    it('reports which sections changed and which did not', () => {
        const [entry] = buildTimelineEntries(products, deps);
        expect(entry.changedKeys).toContain('Synopsis');
        expect(entry.changedKeys).not.toContain('Aviation');
        expect(entry.changedKeys).not.toContain('Short Term');
    });

    it('reads the forecaster byline from the new issuance', () => {
        const [entry] = buildTimelineEntries(products, deps);
        expect(entry.forecaster.toUpperCase()).toContain('JONES');
    });

    it('detects falling confidence between the certain old text and hedgy new text', () => {
        const [entry] = buildTimelineEntries(products, deps);
        expect(entry.confidence.direction).toBe('falling');
        expect(entry.confidence.word).toBeTruthy();
    });

    it('yields an empty-change entry for identical consecutive texts', () => {
        const same = [
            { id: 'a', time: new Date('2026-03-24T18:25:00Z'), text: OLD_AFD },
            { id: 'b', time: new Date('2026-03-24T08:25:00Z'), text: OLD_AFD },
        ];
        const [entry] = buildTimelineEntries(same, deps);
        expect(entry.changedKeys.length).toBe(0);
    });

    it('returns no entries for fewer than two products', () => {
        expect(buildTimelineEntries([products[0]], deps).length).toBe(0);
        expect(buildTimelineEntries([], deps).length).toBe(0);
    });

    it('skips malformed products rather than throwing', () => {
        const withJunk = [products[0], { id: 'x', time: new Date(), text: null }, products[1]];
        expect(() => buildTimelineEntries(withJunk, deps)).not.toThrow();
    });
});
