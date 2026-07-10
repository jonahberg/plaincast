import { describe, it, expect } from 'bun:test';
// Confidence scoring now lives in the DOM-free docs/js/timeline.js module
// (single source of truth — app.js displayConfidence consumes the same
// exports). Import it directly rather than a stale helpers.js fork so this
// suite tracks the code that actually ships.
import { confidenceScore, confidenceWord } from '../docs/js/timeline.js';

describe('confidenceScore + confidenceWord', () => {
    it('should return high score for text with "high confidence" and "consistent"', () => {
        const text = 'Models show high confidence in the ridge building. Ensemble guidance is consistent with the operational runs.';
        const score = confidenceScore(text);

        expect(score).not.toBeNull();
        expect(score).toBeGreaterThan(70);
        expect(confidenceWord(score)).toBe('High');
    });

    it('should return low score for text with "uncertain", "wide range", "tricky"', () => {
        const text = 'The forecast remains uncertain with a wide range of solutions. This is a tricky pattern to forecast.';
        const score = confidenceScore(text);

        expect(score).not.toBeNull();
        expect(score).toBeLessThan(30);
        expect(confidenceWord(score)).toBe('Low');
    });

    it('should return null when no signal phrases are found', () => {
        const text = 'Temperatures will be in the mid 70s with sunny skies and light winds.';
        expect(confidenceScore(text)).toBeNull();
    });

    it('confidenceWord returns null for a null score (no invented reading)', () => {
        expect(confidenceWord(null)).toBeNull();
        expect(confidenceWord(undefined)).toBeNull();
    });

    it('should return mixed score for text with both certain and uncertain signals', () => {
        const text = 'High confidence in the short term forecast. However, the extended remains uncertain with spread in the ensembles.';
        const score = confidenceScore(text);

        expect(score).not.toBeNull();
        // Expected mixed score (20-80)
        expect(score).toBeGreaterThanOrEqual(20);
        expect(score).toBeLessThanOrEqual(80);
    });

    it('should weight explicit confidence statements higher', () => {
        // "high confidence" (weight 3) vs single "uncertain" (weight 2)
        const text = 'We have high confidence in this forecast. Timing is somewhat uncertain.';
        const score = confidenceScore(text);

        expect(score).not.toBeNull();
        // high confidence = 3, uncertain = 2, total = 5, certain = 3, score = 60%
        expect(score).toBeGreaterThanOrEqual(50);
    });

    it('should handle repeated uncertainty phrases', () => {
        const text = 'Low confidence in the extended. Uncertainty remains high. The pattern is uncertain and models disagree. Wide range of outcomes possible.';
        const score = confidenceScore(text);

        expect(score).not.toBeNull();
        // Heavy uncertainty text should score very low
        expect(score).toBeLessThan(15);
        expect(confidenceWord(score)).toBe('Low');
    });

    it('should handle repeated certainty phrases', () => {
        const text = 'High confidence in the forecast. Consistent model guidance. Good agreement between the ensembles. Increasing confidence in this outcome.';
        const score = confidenceScore(text);

        expect(score).not.toBeNull();
        // Heavy certainty text should score very high
        expect(score).toBeGreaterThan(90);
        expect(confidenceWord(score)).toBe('High');
    });

    it('should be case-insensitive', () => {
        const text = 'HIGH CONFIDENCE in the ridge. CONSISTENT guidance from models.';
        const score = confidenceScore(text);

        // Should match uppercase phrases
        expect(score).not.toBeNull();
        expect(score).toBeGreaterThan(70);
    });

    it('should detect "on track" as a certainty signal', () => {
        const text = 'The forecast remains on track for dry weather through midweek.';
        const score = confidenceScore(text);

        // "on track" should produce a positive score
        expect(score).not.toBeNull();
        expect(score).toBeGreaterThan(50);
    });

    it('confidenceWord thresholds map score bands to labels', () => {
        expect(confidenceWord(80)).toBe('High');
        expect(confidenceWord(75)).toBe('High');
        expect(confidenceWord(60)).toBe('Moderate');
        expect(confidenceWord(50)).toBe('Moderate');
        expect(confidenceWord(40)).toBe('Mixed');
        expect(confidenceWord(30)).toBe('Mixed');
        expect(confidenceWord(20)).toBe('Low');
        expect(confidenceWord(0)).toBe('Low');
    });
});
