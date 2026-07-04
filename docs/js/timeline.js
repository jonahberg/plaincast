// ─── Forecast Changelog timeline ─────────────────────────────────────
// Pure data layer for the reverse-chronological edition ledger: pairs
// consecutive AFD issuances, diffs them, and reads the forecaster's own
// confidence language. No DOM here — app.js renders, tests drive directly.
// parseSections/computeDiff are injected to avoid a circular app.js import.

// Weighted phrases: multi-word explicit confidence language scores higher
// than single common words that appear in nearly every forecast.
// (Single source of truth — app.js displayConfidence consumes these too.)
export const UNCERTAIN_PHRASES = [
    // Explicit confidence statements (weight 3)
    { pattern: 'low confidence', weight: 3 },
    { pattern: 'remain uncertain', weight: 3 },
    { pattern: 'low predictability', weight: 3 },
    { pattern: 'highly uncertain', weight: 3 },
    // Strong uncertainty signals (weight 2)
    { pattern: 'uncertainty', weight: 2 },
    { pattern: 'uncertain', weight: 2 },
    { pattern: 'unclear', weight: 2 },
    { pattern: 'can\'t rule out', weight: 2 },
    { pattern: 'cannot rule out', weight: 2 },
    { pattern: 'wide range', weight: 2 },
    { pattern: 'disagreement', weight: 2 },
    { pattern: 'inconsistent', weight: 2 },
    { pattern: 'diverge', weight: 2 },
    { pattern: 'tricky', weight: 2 },
    { pattern: 'questionable', weight: 2 },
    { pattern: 'iffy', weight: 2 },
    // Mild uncertainty (weight 1)
    { pattern: 'slight chance', weight: 1 },
    { pattern: 'challenging', weight: 1 },
    { pattern: 'complicated', weight: 1 },
    { pattern: 'depends on', weight: 1 },
    { pattern: 'perhaps', weight: 1 },
    { pattern: 'spread', weight: 1 },
];
export const CERTAIN_PHRASES = [
    // Explicit confidence statements (weight 3)
    { pattern: 'high confidence', weight: 3 },
    { pattern: 'increasing confidence', weight: 3 },
    { pattern: 'increasingly likely', weight: 3 },
    { pattern: 'remains on track', weight: 3 },
    { pattern: 'on track', weight: 2 },
    // Strong certainty signals (weight 2)
    { pattern: 'confident', weight: 2 },
    { pattern: 'good agreement', weight: 2 },
    { pattern: 'consensus', weight: 2 },
    { pattern: 'consistent', weight: 2 },
    { pattern: 'strong signal', weight: 2 },
    { pattern: 'well-defined', weight: 2 },
];

// Score 0 (all uncertain) … 100 (all certain); null when the text carries no
// confidence language at all (don't invent a reading the forecaster didn't give).
export function confidenceScore(fullText) {
    const t = String(fullText || '').toLowerCase();
    let uncertain = 0;
    let certain = 0;
    for (const { pattern, weight } of UNCERTAIN_PHRASES) {
        const m = t.match(new RegExp(pattern, 'gi'));
        if (m) uncertain += m.length * weight;
    }
    for (const { pattern, weight } of CERTAIN_PHRASES) {
        const m = t.match(new RegExp(pattern, 'gi'));
        if (m) certain += m.length * weight;
    }
    const total = uncertain + certain;
    if (total === 0) return null;
    return Math.round((certain / total) * 100);
}

export function confidenceWord(score) {
    if (score === null || score === undefined) return null;
    if (score >= 75) return 'High';
    if (score >= 50) return 'Moderate';
    if (score >= 30) return 'Mixed';
    return 'Low';
}

// Direction of confidence between two consecutive issuances, as plain words.
// A small wobble is "steady" — the phrase counting is too coarse for ±14.
export function confidenceDirection(prevScore, currScore) {
    if (prevScore === null || prevScore === undefined) return null;
    if (currScore === null || currScore === undefined) return null;
    const delta = currScore - prevScore;
    if (Math.abs(delta) < 15) return 'steady';
    return delta > 0 ? 'rising' : 'falling';
}

// products: [{id, time, text}] newest-first (as fetched from the NWS list).
// Returns one entry per consecutive pair, newest-first. Each entry describes
// what its issuance changed relative to the one before it.
export function buildTimelineEntries(products, { parseSections, computeDiff }) {
    const entries = [];
    for (let i = 0; i + 1 < products.length; i++) {
        const curr = products[i];
        if (typeof curr?.text !== 'string') continue;
        // Failed fetches sit as null placeholders (positional pagination);
        // pair with the nearest OLDER real product rather than losing entries.
        let j = i + 1;
        while (j < products.length && typeof products[j]?.text !== 'string') j++;
        if (j >= products.length) break;
        const prev = products[j];
        const currParsed = parseSections(curr.text);
        const prevParsed = parseSections(prev.text);
        const diffs = computeDiff(
            prevParsed.sections.map(s => ({ key: s.key, text: s.text })),
            currParsed.sections.map(s => ({ key: s.key, text: s.text }))
        );
        const changed = diffs.filter(d => d.status !== 'unchanged');
        const currScore = confidenceScore(curr.text);
        const prevScore = confidenceScore(prev.text);
        entries.push({
            id: curr.id,
            time: curr.time,
            prevId: prev.id,
            prevTime: prev.time,
            forecaster: currParsed.forecaster || '',
            changed,
            changedKeys: changed.map(d => d.key),
            confidence: {
                score: currScore,
                prevScore,
                word: confidenceWord(currScore),
                direction: confidenceDirection(prevScore, currScore),
            },
        });
    }
    return entries;
}
