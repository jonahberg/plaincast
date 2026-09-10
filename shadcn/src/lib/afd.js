// ─── AFD parsing + plain-English translation ────────────────────────
// Ported from docs/js/app.js (the vanilla client). Pure functions only.
//
// FORK-DRIFT GUARD: parseSections, stripAIArtifacts, escapeHTML,
// stripNWSArtifacts, hasRealAlerts and reorderSections are code-identical
// to their docs/js/app.js originals and are locked by
// tests/shadcn-parity.test.js — edit them there and here together.
// translateToPlainEnglish and extractTakeaway intentionally differ (the
// timezone is a parameter instead of the app.js `currentOffice` global)
// and are covered behaviorally by tests/shadcn-afd.test.js instead.
//
// Imports are relative (not the @data alias) so the Bun test suite can
// load this module without Vite's resolver.

import { GLOSSARY, GLOSSARY_COMPILED } from '../../../docs/js/glossary.js';
import { FULL_ABBREVIATIONS } from '../../../docs/js/abbreviations.js';
import { SECTION_NAMES } from '../../../docs/js/offices.js';

export function parseSections(text) {
    // Remove header lines (product header, timestamps at very top)
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
        const headerMatch = line.match(/^\.(?!KEY MESSAGE \d)[A-Za-z]{3}\s+([A-Za-z0-9\s\/]+?)(?:\s*(?:\([^)]*\)|\/[^/]*\/))?\s*\.{2,3}/i)
            || line.match(/^\.(?!KEY MESSAGE \d)([A-Za-z0-9\s\/]+?)(?:\s*(?:\([^)]*\)|\/[^/]*\/))?\s*\.{2,3}/i);
        if (headerMatch) {
            if (currentKey) {
                sections.push({ key: currentKey, text: currentLines.join('\n').trim() });
            }
            const rawKey = headerMatch[1].trim();
            // Map to canonical name
            currentKey = SECTION_NAMES[rawKey] || rawKey.charAt(0) + rawKey.slice(1).toLowerCase();
            currentLines = [line.replace(headerMatch[0], '').trim()];
            continue;
        }
        // Check for $$ delimiter (end of section / forecaster signature)
        if (line.trim() === '$$') {
            if (currentKey) {
                sections.push({ key: currentKey, text: currentLines.join('\n').trim() });
                currentKey = null;
                currentLines = [];
            }
            continue;
        }
        // Forecaster line
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
        // Extract forecaster if embedded at end
        const fm = s.text.match(/\n\s*(?:Forecaster|FORECASTER)[:\s]*(.+)$/im);
        if (fm) {
            if (!forecaster) forecaster = fm[1].trim();
            s.text = s.text.replace(fm[0], '').trim();
        }
        // Strip bare forecaster signatures (short name on its own line at end of section)
        // Many NWS offices sign with just a name (e.g. "Doom", "Smith") before &&
        // Require a blank line before the name to avoid stripping wrapped forecast text
        const bareNameMatch = s.text.match(/\n\s*\n\s*([A-Za-z][A-Za-z .'-]{0,25})\s*$/);
        if (bareNameMatch) {
            const candidate = bareNameMatch[1].trim();
            // Must be short (≤3 words), not look like forecast content
            const words = candidate.split(/\s+/);
            if (words.length <= 3 && !/\d/.test(candidate) && candidate.length <= 20) {
                if (!forecaster) forecaster = candidate;
                s.text = s.text.replace(bareNameMatch[0], '').trim();
            }
        }
    }

    return { sections, forecaster };
}

export function stripAIArtifacts(text) {
    if (!text) return '';
    let t = text;
    t = t.replace(/^#{1,3}\s+.*$/gm, '');     // ## headers, ### sub-headers
    t = t.replace(/^---+\s*$/gm, '');           // --- horizontal rules
    t = t.replace(/^`{3}[^\n]*$/gm, '');                     // strip fenced code block delimiters, keep enclosed text
    t = t.replace(/`{1,3}([^`\n]*)`{1,3}/g, '$1');         // inline backticks, keep content
    t = t.replace(/^\s*(?:[Kk][Ee][Yy]\s+)?[Mm]essage\s+\d+[.:]\s*/gm, ''); // "KEY Message 1." / "Key message 1:"
    t = t.replace(/\n{3,}/g, '\n\n');            // collapse excess newlines from removed lines
    return t.trim();
}

export function escapeHTML(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function stripNWSArtifacts(text) {
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

const ALERT_PATTERN = /((?:High Wind (?:Watch|Warning)|Wind Advisory|Flood (?:Watch|Warning)|High Surf (?:Advisory|Warning)|Beach Hazards? Statement|Winter Storm (?:Watch|Warning)|Winter Weather Advisory|Small Craft Advisory|Gale Warning|Storm Warning|Red Flag Warning|Fire Weather Watch|Tornado (?:Watch|Warning)|Severe Thunderstorm (?:Watch|Warning)|Flash Flood (?:Watch|Warning)|Blizzard Warning|Ice Storm Warning|Freeze (?:Watch|Warning)|Frost Advisory|Dense Fog Advisory|Heat Advisory|Excessive Heat Warning|Extreme (?:Heat|Cold) Warning|Wind Chill (?:Watch|Warning|Advisory)|Tropical Storm (?:Watch|Warning)|Hurricane (?:Watch|Warning)|Rip Current Statement|Coastal Flood (?:Watch|Warning|Advisory|Statement))[^.]*\.?)/gi;

// True only when a watches/warnings section actually names an advisory.
export function hasRealAlerts(text) {
    if (!text) return false;
    return !!stripNWSArtifacts(text).match(ALERT_PATTERN);
}

// ─── Smart section ordering ──────────────────────────────────────
// Reorder sections based on context: alerts first when active,
// elevate Marine for coastal offices, Fire Weather for inland.
export function reorderSections(sections, office, hasAlerts) {
    const priority = {
        'Active Alerts': hasAlerts ? 0 : 99,
        'Synopsis': 1,
        'Messages': 1.5,
        'What has changed': 1.8,
        'Update': 1.9,
        'Short Term': 2,
        'Discussion': 2,
        'Long Term': 3,
    };

    // Coastal offices: elevate Marine
    const coastalOffices = new Set(['LOX','SGX','MTR','STO','EKA','SEW','PQR','MFR','OKX','BOX','PHI','MFL','JAX','TBW','CHS','HFO']);
    if (coastalOffices.has(office)) {
        priority['Marine'] = 3.5;
        priority['Beaches'] = 3.6;
    }

    // Mountain/fire offices: elevate Fire Weather
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

// URL-safe section element id (same scheme as the vanilla client).
export function sectionDomId(key) {
    return 'section-' + key.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

// Returns HTML (paragraphs, sub-headers, <strong> highlights). tz is the
// office IANA zone used for Zulu → local conversion (a parameter here; the
// vanilla client reads the `currentOffice` global instead).
export function translateToPlainEnglish(text, tz = 'America/Los_Angeles') {
    let t = text;

    t = t.replace(/\d{2}\/\d{3,4}\s*(?:AM|PM|Z)\.?\s*/gi, '');
    t = t.replace(/,?\s*see\s+the\s+[A-Z]{3,12}\s+(?:and\s+[A-Z]{3,12}\s+)?products?\s+for\s+more\s+details\.?/gi, '.');
    t = stripNWSArtifacts(t);
    t = t.replace(/\*{3}\s*([^*]+?)\s*\*{3}/g, '\n\n§§§$1§§§\n\n');
    t = t.replace(/\.(?:SHORT|LONG|NEAR)\s+TERM\s*\([^)]*\)\.\s*/gi, '');
    t = t.replace(/\.?\s*KEY\s+MESSAGE\s+\d+\s*\.{1,3}\s*/gi, '');
    t = t.replace(/\.{3,}/g, '. ');
    t = t.replace(/[ \t]{2,}/g, ' ');

    for (const [pat, rep] of FULL_ABBREVIATIONS) {
        t = t.replace(pat, rep);
    }

    // Zulu times → local (DST-aware); same fallback offset table as app.js
    // when the Intl zone lookup throws.
    t = t.replace(/\b(\d{2,4})Z\b/gi, (_, h) => {
        const utcHour = parseInt(h.length <= 2 ? h : h.substring(0, 2));
        const utcMin = h.length > 2 ? parseInt(h.substring(2)) : 0;
        const now = new Date();
        const utcDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour, utcMin));
        try {
            return utcDate.toLocaleString('en-US', { hour: 'numeric', minute: utcMin > 0 ? '2-digit' : undefined, timeZone: tz, timeZoneName: 'short' });
        } catch (e) {
            const stdOffsets = { 'America/New_York': -5, 'America/Detroit': -5, 'America/Indiana/Indianapolis': -5, 'America/Chicago': -6, 'America/Denver': -7, 'America/Phoenix': -7, 'America/Los_Angeles': -8, 'America/Anchorage': -9, 'Pacific/Honolulu': -10 };
            const offset = stdOffsets[tz] || -8;
            const localHr = (utcHour + offset + 24) % 24;
            const ampm = localHr >= 12 ? 'PM' : 'AM';
            const hr12 = localHr === 0 ? 12 : localHr > 12 ? localHr - 12 : localHr;
            return `${hr12} ${ampm}`;
        }
    });

    t = t.replace(/(\d{3})\s*dam\b/g, '$1-decameter');
    t = t.replace(/(\d{3,4})\s*mb\b/g, '$1 mb level');
    t = t.replace(/\b([A-Z]{5,})\b/g, (m) => {
        if (GLOSSARY[m]) return m;
        return m.charAt(0) + m.slice(1).toLowerCase();
    });
    t = t.replace(/^\.\s*/gm, '');
    t = t.trim();
    t = escapeHTML(t);

    // Bold pass: make key info skimmable (first occurrence only for words)
    const boldSeen = new Set();
    const boldFirst = (str, pattern) => str.replace(pattern, (m) => {
        const k = m.toLowerCase().trim();
        if (boldSeen.has(k)) return m;
        boldSeen.add(k);
        return `<strong>${m}</strong>`;
    });

    t = boldFirst(t, /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g);
    t = boldFirst(t, /\b(tonight|this morning|this afternoon|this evening|overnight|today)\b/gi);
    t = t.replace(/(\d{1,3})\s*(?:degrees?|°)\s*(?:F|fahrenheit)?/gi, '<strong>$1°</strong>');
    t = t.replace(/\b(\d{1,3})\s*(?:mph)\b/gi, '<strong>$1 mph</strong>');
    t = t.replace(/\b(\d+(?:\.\d+)?)\s*(?:to|-)\s*(\d+(?:\.\d+)?)\s*(inches?|")\b/gi,
        (_, a, b) => `<strong>${a}–${b}"</strong>`);
    t = t.replace(/\b(\d+(?:\.\d+)?)\s*(inches?|")\b/gi, '<strong>$1"</strong>');
    t = t.replace(/\b((?:a\s+)?half(?:\s+and\s+one)?\s+inch(?:\s+per\s+hour)?)\b/gi, '<strong>$1</strong>');
    t = boldFirst(t, /\b(severe thunderstorms?|flash flood(?:ing)?|debris flows?|damaging winds?|heavy (?:mountain )?snow|high surf|coastal flood(?:ing)?)\b/gi);
    t = boldFirst(t, /\b(small craft advisory|gale warning|winter storm (?:watch|warning)|flood watch|wind advisory|high wind watch|high surf advisory|beach hazards? statement)\b/gi);
    t = t.replace(/<strong><strong>/g, '<strong>');
    t = t.replace(/<\/strong><\/strong>/g, '</strong>');

    const blocks = t.split(/\n\s*\n+/).filter(b => b.trim());
    let html = '';
    for (const block of blocks) {
        const trimmed = block.trim();
        const subMatch = trimmed.match(/§§§\s*(.+?)\s*§§§\s*([\s\S]*)/);
        if (subMatch) {
            const title = subMatch[1].trim();
            const body = subMatch[2].trim();
            html += `<h3>${title}</h3>`;
            if (body) html += `<p>${body}</p>`;
        } else if (!trimmed.match(/^§§§/)) {
            html += `<p>${trimmed.replace(/\n/g, ' ')}</p>`;
        }
    }
    return html;
}

// Split raw AFD text into segments for React rendering with shadcn Tooltips:
// [{ type: 'text', text }, { type: 'jargon', text, tip }]. Replaces the
// HTML-string annotateText in app.js. `tip` is the RAW glossary definition
// (GLOSSARY_COMPILED.tipText is pre-HTML-escaped for the vanilla innerHTML
// path; React re-escapes, so using it here would double-escape).
export function annotateSegments(text) {
    const matches = [];
    for (const { key, regex } of GLOSSARY_COMPILED) {
        regex.lastIndex = 0;
        let m;
        while ((m = regex.exec(text)) !== null) {
            const start = m.index;
            const end = start + m[0].length;
            // Longest-key-first compile order: keep the first (longer) claim
            // on any overlapping span.
            if (!matches.some(x => start < x.end && end > x.start)) {
                matches.push({ start, end, text: m[0], tip: GLOSSARY[key] });
            }
        }
    }
    matches.sort((a, b) => a.start - b.start);

    const segments = [];
    let pos = 0;
    for (const m of matches) {
        if (m.start > pos) segments.push({ type: 'text', text: text.slice(pos, m.start) });
        segments.push({ type: 'jargon', text: m.text, tip: m.tip });
        pos = m.end;
    }
    if (pos < text.length) segments.push({ type: 'text', text: text.slice(pos) });
    return segments;
}

// Key takeaway: KEY MESSAGES verbatim, else first sentences of the synopsis.
export function extractTakeaway(sections, tz) {
    const messagesSection = sections.find(s => s.key === 'Messages');
    if (messagesSection) {
        const text = messagesSection.text.replace(/\.{2,}/g, '. ').replace(/\s+/g, ' ').trim();
        return stripAIArtifacts(translateToPlainEnglish(text, tz).replace(/<\/?p>/g, ''));
    }
    const synSection = sections.find(s => s.key === 'Synopsis')
        || sections.find(s => s.key === 'Discussion')
        || sections[0];
    if (!synSection) return '';
    let text = synSection.text.replace(/^Issued at \d.+?\d{4}\s*/i, '');
    text = text.replace(/\.{2,}/g, '. ').replace(/\s+/g, ' ').trim();
    const sentences = text.match(/[^.!?]+[.!?]+/g);
    if (!sentences) return text.substring(0, 200);
    const takeaway = sentences.slice(0, 2).join(' ').trim();
    return stripAIArtifacts(translateToPlainEnglish(takeaway, tz).replace(/<\/?p>/g, ''));
}
