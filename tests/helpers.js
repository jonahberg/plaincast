// ─── Test helpers: pure-function extractions from docs/js/app.js ────
// These replicate the logic without requiring a DOM environment.

import { SECTION_NAMES } from '../docs/js/offices.js';
import { GLOSSARY } from '../docs/js/glossary.js';
import { FULL_ABBREVIATIONS } from '../docs/js/abbreviations.js';

// ─── stripAIArtifacts ────────────────────────────────────────────────
// Strips markdown headers, horizontal rules, backticks, and NWS "KEY Message" prefixes.
export function stripAIArtifacts(text) {
    if (!text) return '';
    let t = text;
    t = t.replace(/^#{1,3}\s+.*$/gm, '');
    t = t.replace(/^---+\s*$/gm, '');
    t = t.replace(/^`{3}[^\n]*$/gm, '');
    t = t.replace(/`{1,3}([^`\n]*)`{1,3}/g, '$1');
    t = t.replace(/^\s*(?:[Kk][Ee][Yy]\s+)?[Mm]essage\s+\d+[.:]\s*/gm, '');
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
}

function escapeHTML(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── sectionDisplayKeys ─────────────────────────────────────────────
// Copied from docs/js/app.js (locked by tests/helpers-parity.test.js).
// Display keys for one product's section headers, in order, never two alike.
// A key is the SECTION_NAMES name, else the header in sentence case. Where
// sections would share one (JAX, OUN and HUN on Nov 18 2026: NEAR TERM and
// SHORT TERM are both "Short Term", so the edition's translation set could
// never be complete and one section's AI text was lost), the section the name
// belongs to keeps it (SHORT TERM keeps "Short Term"; else the first) and each
// other takes its own header in title case ("Near Term"), then an ordinal
// ("Aviation (2)"). A product without a repeat keeps exactly the keys it had,
// so stored translations keyed by them still match. The server imports the
// shadcn copy (api/_translatable.js); forked verbatim into docs/js/app.js and
// tests/helpers.js (parity-locked).
export function sectionDisplayKeys(rawKeys) {
    const name = (raw) => SECTION_NAMES[raw] || raw.charAt(0) + raw.slice(1).toLowerCase();
    const title = (raw) => raw.toLowerCase().replace(/(^|[\s\/(-])([a-z])/g, (m, before, c) => before + c.toUpperCase());
    const keys = rawKeys.map(name);
    const owner = new Map();
    keys.forEach((key, i) => {
        const prev = owner.get(key);
        if (prev === undefined || (title(rawKeys[prev]) !== key && title(rawKeys[i]) === key)) owner.set(key, i);
    });
    const used = new Set(owner.keys());
    return keys.map((key, i) => {
        if (owner.get(key) === i) return key;
        let own = title(rawKeys[i]);
        for (let n = 2; used.has(own); n++) own = `${title(rawKeys[i])} (${n})`;
        used.add(own);
        return own;
    });
}

// ─── parseSections ──────────────────────────────────────────────────
// Copied from docs/js/app.js — pure function, no DOM dependency.
export function parseSections(text) {
    const lines = text.split('\n');
    const sections = [];
    let currentKey = null;
    let currentLines = [];
    let forecaster = '';

    for (const line of lines) {
        // Check for section headers: .SYNOPSIS..., .SHORT TERM (TDY-TUE)..., .LOX WATCHES/WARNINGS/ADVISORIES...
        // Case-insensitive + digit-tolerant so mixed-case (".Previous Discussion...")
        // and digit-bearing (".OUTLOOK FOR 18Z FRIDAY...") headers become their own
        // sections instead of being merged into the previous one. The negative
        // lookahead keeps inline ".KEY MESSAGE 1..." pseudo-headers inside the body.
        // Try with office prefix first (3-letter like LOX, SGX)
        const headerMatch = line.match(/^\.(?!KEY MESSAGE \d)[A-Za-z]{3}\s+([A-Za-z0-9\s\/]+?)(?:\s*(?:\([^)]*\)|\/[^/]*\/|,\s*(?:Issued|Updated)\b[^.]*))?\s*\.{2,3}/i)
            || line.match(/^\.(?!KEY MESSAGE \d)([A-Za-z0-9\s\/]+?)(?:\s*(?:\([^)]*\)|\/[^/]*\/|,\s*(?:Issued|Updated)\b[^.]*))?\s*\.{2,3}/i);
        if (headerMatch) {
            if (currentKey) {
                sections.push({ key: currentKey, text: currentLines.join('\n').trim() });
            }
            // The raw header for now: display keys are given per product
            // at the end (sectionDisplayKeys), so no two sections share one.
            currentKey = headerMatch[1].trim();
            currentLines = [line.replace(headerMatch[0], '').trim()];
            continue;
        }
        // Check for $$ delimiter
        if (line.trim() === '$$') {
            if (currentKey) {
                sections.push({ key: currentKey, text: currentLines.join('\n').trim() });
                currentKey = null;
                currentLines = [];
            }
            continue;
        }
        // Skip && markers
        if (line.match(/^&&$/)) continue;
        if (currentKey) {
            currentLines.push(line);
        }
        // Try to find forecaster
        const fMatch = line.match(/^\.?(?:Forecaster|FORECASTER)[:\s]+(.+)/i);
        if (fMatch) forecaster = fMatch[1].trim();
    }
    if (currentKey) {
        sections.push({ key: currentKey, text: currentLines.join('\n').trim() });
    }

    // Clean up: remove forecaster lines from section text, remove trailing &&
    for (const s of sections) {
        s.text = s.text.replace(/&&\s*$/, '').replace(/^\s*&&\s*/gm, '').trim();
        const fm = s.text.match(/\n\s*(?:Forecaster|FORECASTER)[:\s]*(.+)$/im);
        if (fm) {
            if (!forecaster) forecaster = fm[1].trim();
            s.text = s.text.replace(fm[0], '').trim();
        }
        // Strip bare forecaster signatures (short name on its own line at end of section)
        // Require a blank line before the name to avoid stripping wrapped forecast text
        const bareNameMatch = s.text.match(/\n\s*\n\s*([A-Za-z][A-Za-z .'-]{0,25})\s*$/);
        if (bareNameMatch) {
            const candidate = bareNameMatch[1].trim();
            const words = candidate.split(/\s+/);
            if (words.length <= 3 && !/\d/.test(candidate) && candidate.length <= 20) {
                if (!forecaster) forecaster = candidate;
                s.text = s.text.replace(bareNameMatch[0], '').trim();
            }
        }
    }

    const keys = sectionDisplayKeys(sections.map(s => s.key));
    sections.forEach((s, i) => { s.key = keys[i]; });

    return { sections, forecaster };
}

// ─── synopsisTakeaway ───────────────────────────────────────────────
// Copied from docs/js/app.js (locked by tests/helpers-parity.test.js).
export function synopsisTakeaway(text) {
    const HAZARD = /\b(?:thunder\w*|t-?storms?|lightning|tornado\w*|waterspouts?|funnel clouds?|hail\w*|severe|storms?|flood\w*|inundation|(?:heavy|widespread|significant|excessive|torrential|soaking|prolonged) (?:\w+ )?(?:rain\w*|snow\w*|precipitation|showers|downpours)|inch(?:es)? of (?:new )?(?:rain|snow)|atmospheric rivers?|debris flows?|mud ?slides?|land ?slides?|rock ?slides?|burn scars?|avalanche\w*|blizzard\w*|whiteouts?|snow squalls?|(?:mountain|accumulating|lake[- ]effect|pass[- ]level|wet) snow\w*|snow(?:fall)? accumulations?|freeze|freezing (?:rain|drizzle|fog|spray|temperatures)|below freezing|sleet|ice|icy|gusty|gusts?|(?:strong|high|damaging) (?:\w+ )?winds?|damag\w*|(?:extreme|excessive|dangerous|record) heat|heat (?:advisory|warning|risk|index)|heat ?waves?|(?:very|dangerously|extremely) hot|(?:extreme|bitter(?:ly)?|dangerous(?:ly)?) cold|arctic (?:air|blast|outbreak)|wind chills?|frost|record(?:s|-breaking)?|(?:high|large|big|dangerous) (?:\w+ )?(?:surf|swells?|waves|breakers)|(?:hazardous|rough|high|steep|dangerous) seas|rip currents?|sneaker waves?|storm surge|king tides?|high tides?|gales?|hurricane\w*|tropical (?:storms?|depressions?|cyclones?)|typhoons?|dense fog|blowing (?:dust|snow)|dust storms?|haboobs?|smoke|air quality|fire\w*|red flag|warnings?|watch(?:es)?|advisor(?:y|ies)|hazard\w*|dangerous|life[- ]threatening|(?:significant|major|high) impacts?|high[- ]impact|impactful)\b/i;
    const FADING = /\b(?:diminish\w*|decreas\w*|taper\w*|weaken\w*|subsid\w*|eas(?:e|es|ing)|expir\w*|cancel\w*|below (?:advisory|warning)|no longer|no|not|unlikely|(?:is|are|remains?|stays?) low)\b/i;
    const LEANS_BACK = /^(?:this|these|that|those|it|its|they|their|additionally|otherwise|however|meanwhile|then|but|and|along with|in addition)\b|^(?:\S+\s+){0,3}of (?:these|those|this|that)\b|\b(?:also|as well)\b|\bthe (?:second|third|latter|former)\b/i;
    let t = String(text || '')
        .replace(/^\s*(?:\d{1,2}\/\d{3,4}\s*(?:AM|PM|Z)?\.?\s*)+/i, '')
        .replace(/^\s*Issued at \d.+?\d{4}\s*/i, '');
    t = t.replace(/\.{2,}/g, '. ').replace(/\s+/g, ' ').trim();
    const sentences = t.match(/\S[\s\S]*?[.!?]+(?=\s|$)/g);
    if (!sentences) return t.substring(0, 200);
    const names = s => HAZARD.test(s) && !FADING.test(s);
    let lead = 0;
    if (!/^key messages?\b/i.test(t) && !names(sentences[0])) {
        const i = sentences.slice(0, 3).findIndex(names);
        if (i > 0) {
            lead = i;
            if (lead === sentences.length - 1 || LEANS_BACK.test(sentences[lead])) lead--;
            if (lead > 0 && LEANS_BACK.test(sentences[lead])) lead = 0;
        }
    }
    return sentences.slice(lead, lead + 2).join(' ');
}

// ─── extractTakeaway ────────────────────────────────────────────────
// Simplified version: the synopsis fallback's sentences (synopsisTakeaway)
// without running full translation (which would need timezone state).
// Returns raw text for testing purposes.
// ─── takeawaySection ─────────────────────────────────────────────────
// Copied from docs/js/app.js (locked by tests/helpers-parity.test.js).
// The section the takeaway comes from: Key Messages, else the synopsis, the
// discussion or the first section. One rule for the page (extractTakeaway)
// and the server's lede for share cards and RSS (api/_afd-sections.js
// extractLede, which imports the shadcn copy). Forked verbatim into
// docs/js/app.js and tests/helpers.js (parity-locked).
export function takeawaySection(sections) {
    return sections.find(s => s.key === 'Messages')
        || sections.find(s => s.key === 'Synopsis')
        || sections.find(s => s.key === 'Discussion')
        || sections[0]
        || null;
}

export function extractTakeaway(sections) {
    const source = takeawaySection(sections);
    if (!source) return '';
    // Prefer KEY MESSAGES section when available
    if (source.key === 'Messages') {
        return source.text.replace(/\.{2,}/g, '. ').replace(/\s+/g, ' ').trim();
    }
    return synopsisTakeaway(source.text);
}

// ─── stripNWSArtifacts ──────────────────────────────────────────────
function stripNWSArtifacts(text) {
    let t = text;
    t = t.replace(/for\s+zones?\s+[\d\->]+/gi, '');
    t = t.replace(/\(See\s+[A-Za-z]+\)/gi, '');
    t = t.replace(/\(\s*\)/g, '');
    t = t.replace(/\bCA\s*\.{1,3}\s*/g, '');
    t = t.replace(/\bPZ\s*\.{1,3}\s*/g, '');
    t = t.replace(/\b(?:See\s+)?(?:Lax|Cfw|Srf|Npw|Mww|Wsw|Ffa)[a-z]{2,8}\b\.?/gi, '');
    t = t.replace(/\.\s*\.\s*/g, '. ');
    t = t.replace(/\s{2,}/g, ' ');
    return t.trim();
}

// ─── hasRealAlerts ──────────────────────────────────────────────────
// Copied from docs/js/app.js — true only when a watches/warnings body
// names a real advisory (not an empty "None." / "AZ...None." body).
const ALERT_PATTERN = /((?:High Wind (?:Watch|Warning)|Wind Advisory|Flood (?:Watch|Warning)|High Surf (?:Advisory|Warning)|Beach Hazards? Statement|Winter Storm (?:Watch|Warning)|Winter Weather Advisory|Small Craft Advisory|Gale Warning|Storm Warning|Red Flag Warning|Fire Weather Watch|Tornado (?:Watch|Warning)|Severe Thunderstorm (?:Watch|Warning)|Flash Flood (?:Watch|Warning)|Blizzard Warning|Ice Storm Warning|Freeze (?:Watch|Warning)|Frost Advisory|Dense Fog Advisory|Heat Advisory|Excessive Heat Warning|Extreme (?:Heat|Cold) Warning|Wind Chill (?:Watch|Warning|Advisory)|Tropical Storm (?:Watch|Warning)|Hurricane (?:Watch|Warning)|Rip Current Statement|Coastal Flood (?:Watch|Warning|Advisory|Statement))[^.]*\.?)/gi;
export function hasRealAlerts(text) {
    if (!text) return false;
    return !!stripNWSArtifacts(text).match(ALERT_PATTERN);
}

// ─── translateToPlainEnglish (pure subset) ──────────────────────────
// Applies abbreviation expansion and artifact stripping, but skips
// Zulu time conversion (timezone-dependent) and bold pass (DOM-like).
export function translateToPlainEnglish(text) {
    let t = text;

    // Remove NWS timestamps
    t = t.replace(/\d{2}\/\d{3,4}\s*(?:AM|PM|Z)\.?\s*/gi, '');

    // Remove product code references
    t = t.replace(/,?\s*see\s+the\s+[A-Z]{3,12}\s+(?:and\s+[A-Z]{3,12}\s+)?products?\s+for\s+more\s+details\.?/gi, '.');

    // Strip NWS artifacts
    t = stripNWSArtifacts(t);

    // Remove embedded sub-section headers
    t = t.replace(/\.(?:SHORT|LONG|NEAR)\s+TERM\s*\([^)]*\)\.\s*/gi, '');

    // Remove embedded ".KEY MESSAGE N..." pseudo-headers (real OKX/AKQ, with or
    // without the leading dot) so the regex column doesn't show "KEY MESSAGE 1"
    // label noise (mirrors the "Message N" strip in stripAIArtifacts). Require the
    // trailing "." delimiter so bare "key message 3" in prose is not consumed.
    t = t.replace(/\.?\s*KEY\s+MESSAGE\s+\d+\s*\.{1,3}\s*/gi, '');

    // Clean NWS formatting
    t = t.replace(/\.{3,}/g, '. ');
    t = t.replace(/[ \t]{2,}/g, ' ');

    // Expand abbreviations
    for (const [pat, rep] of FULL_ABBREVIATIONS) {
        t = t.replace(pat, rep);
    }

    // Clean up geopotential heights
    t = t.replace(/(\d{3})\s*dam\b/g, '$1-decameter');

    // Clean up pressure level references
    t = t.replace(/(\d{3,4})\s*mb\b/g, '$1 mb level');

    // Convert long ALL CAPS stretches to sentence case (skip known glossary terms)
    t = t.replace(/\b([A-Z]{5,})\b/g, (m) => {
        if (GLOSSARY[m]) return m;
        return m.charAt(0) + m.slice(1).toLowerCase();
    });

    // Clean artifacts from stripped content
    t = t.replace(/^\.\s*/gm, '');
    t = t.trim();

    return escapeHTML(t);
}

// ─── normalizeZuluForTest ───────────────────────────────────────────
// Test-only mirror of app.js's Zulu-time normalization (~app.js:234). The real
// app.js replacement is timezone/DOM-dependent (toLocaleString + currentOffice),
// so translateToPlainEnglish above deliberately skips it. This mirror keeps the
// exact regex — /\b(\d{2,4})Z\b/gi (FIX 5 added the `i`) — but uses a fixed UTC
// offset so the assertion is deterministic across CI timezones. Its only job is
// to prove the pattern matches lowercase 'z' from live aviation text.
export function normalizeZuluForTest(text, offsetHours = -7) {
    return text.replace(/\b(\d{2,4})Z\b/gi, (_, h) => {
        const utcHour = parseInt(h.length <= 2 ? h : h.substring(0, 2));
        const utcMin = h.length > 2 ? parseInt(h.substring(2)) : 0;
        const local = ((utcHour + offsetHours) % 24 + 24) % 24;
        const ampm = local >= 12 ? 'PM' : 'AM';
        let h12 = local % 12;
        if (h12 === 0) h12 = 12;
        return utcMin > 0 ? `${h12}:${String(utcMin).padStart(2, '0')} ${ampm}` : `${h12} ${ampm}`;
    });
}

// ─── computeConfidence ──────────────────────────────────────────────
// Extracted scoring logic from displayConfidence() in app.js.
// Returns { score, label } or null if no signal phrases found.
export function computeConfidence(text) {
    const t = text.toLowerCase();

    const uncertainPhrases = [
        { pattern: 'low confidence', weight: 3 },
        { pattern: 'remain uncertain', weight: 3 },
        { pattern: 'low predictability', weight: 3 },
        { pattern: 'highly uncertain', weight: 3 },
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
        { pattern: 'slight chance', weight: 1 },
        { pattern: 'challenging', weight: 1 },
        { pattern: 'complicated', weight: 1 },
        { pattern: 'depends on', weight: 1 },
        { pattern: 'perhaps', weight: 1 },
        { pattern: 'spread', weight: 1 },
    ];
    const certainPhrases = [
        { pattern: 'high confidence', weight: 3 },
        { pattern: 'increasing confidence', weight: 3 },
        { pattern: 'increasingly likely', weight: 3 },
        { pattern: 'remains on track', weight: 3 },
        { pattern: 'on track', weight: 2 },
        { pattern: 'confident', weight: 2 },
        { pattern: 'good agreement', weight: 2 },
        { pattern: 'consensus', weight: 2 },
        { pattern: 'consistent', weight: 2 },
        { pattern: 'strong signal', weight: 2 },
        { pattern: 'well-defined', weight: 2 },
    ];

    let uncertainScore = 0;
    let certainScore = 0;
    for (const { pattern, weight } of uncertainPhrases) {
        const m = t.match(new RegExp(pattern, 'gi'));
        if (m) uncertainScore += m.length * weight;
    }
    for (const { pattern, weight } of certainPhrases) {
        const m = t.match(new RegExp(pattern, 'gi'));
        if (m) certainScore += m.length * weight;
    }

    const total = uncertainScore + certainScore;
    if (total === 0) return null;

    const score = Math.round((certainScore / total) * 100);

    let label;
    if (score >= 75) label = 'High';
    else if (score >= 50) label = 'Moderate';
    else if (score >= 30) label = 'Mixed';
    else label = 'Low';

    return { score, label };
}

// ─── reorderSections ──────────────────────────────────────────────
// Copied from docs/js/app.js — pure function, no DOM dependency.
export function reorderSections(sections, office, hasAlerts) {
    const priority = {
        'Active Alerts': hasAlerts ? 0 : 99,
        'Synopsis': 1,
        'Messages': 1.5,
        'What has changed': 1.8,
        'Update': 1.9,
        'Near Term': 2,
        'Short Term': 2,
        'Discussion': 2,
        'Long Term': 3,
    };
    const coastalOffices = new Set(['LOX','SGX','MTR','STO','EKA','SEW','PQR','MFR','OKX','BOX','PHI','MFL','JAX','TBW','CHS','HFO']);
    if (coastalOffices.has(office)) {
        priority['Marine'] = 3.5;
        priority['Beaches'] = 3.6;
    }
    const fireOffices = new Set(['PSR','VEF','TWC','FGZ','BOU','BOI','MSO','RIW','LOX','SGX']);
    if (fireOffices.has(office)) {
        priority['Fire Weather'] = 3.5;
    }
    return [...sections].sort((a, b) => {
        const pa = priority[a.key] ?? 50;
        const pb = priority[b.key] ?? 50;
        return pa - pb;
    });
}
