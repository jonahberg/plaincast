// ─── Plaincast App (ES Module) ───────────────────────────────────────
import { GLOSSARY, GLOSSARY_COMPILED } from './glossary.js';
import { OFFICE_TIMEZONES, OFFICE_COORDS, OFFICE_STATES, OFFICE_SENDER, OFFICE_NAMES, SECTION_NAMES } from './offices.js';
import { FULL_ABBREVIATIONS } from './abbreviations.js';
import { computeDiff, renderDiffHTML } from './diff.js';

let currentOffice = 'LOX';
let fetchGeneration = 0; // race condition guard for rapid office switching
let issueTimeDate = null; // for auto-updating "X ago"
let issuePrefix = ''; // "Issued 4:02 AM PDT" — stable half of the issue-time line
let viewingHistorical = false; // true while reading an archived edition (skip diff/changelog)
let currentTranslationObserver = null; // IntersectionObserver for lazy AI translation

// Fetch live alerts and return map of event name → alert URL
async function fetchAlerts(office) {
    const state = OFFICE_STATES[office];
    if (!state) return {};
    try {
        const res = await fetch(`https://api.weather.gov/alerts/active?area=${state}`, {
            headers: { 'User-Agent': 'Plaincast/1.0 (plaincast.live)' }
        });
        if (!res.ok) return {};
        const data = await res.json();
        const senderMatch = OFFICE_SENDER[office] || '';
        const alertMap = {};
        for (const f of (data.features || [])) {
            const p = f.properties;
            // Match alerts from this office
            if (senderMatch && !(p.senderName || '').includes(senderMatch)) continue;
            const event = p.event;
            const alertData = {
                headline: p.headline || event,
                description: p.description || '',
                instruction: p.instruction || '',
                severity: p.severity || '',
                expires: p.expires || '',
                areaDesc: p.areaDesc || ''
            };
            // Store as array to handle multiple alerts of the same type
            if (!alertMap[event]) {
                alertMap[event] = [alertData];
            } else {
                alertMap[event].push(alertData);
            }
        }
        return alertMap;
    } catch(e) { console.debug('Alert fetch failed', e); return {}; }
}

let currentAlerts = {};

// ─── Section parsing ───────────────────────────────────────────────
function parseSections(text) {
    // Remove header lines (product header, timestamps at very top)
    const lines = text.split('\n');
    const sections = [];
    let currentKey = null;
    let currentLines = [];
    let forecaster = '';

    for (const line of lines) {
        // Check for section headers: .SYNOPSIS..., .SHORT TERM (TDY-TUE)..., .LOX WATCHES/WARNINGS/ADVISORIES...
        // Try with office prefix first (3-letter like LOX, SGX)
        const headerMatch = line.match(/^\.[A-Z]{3}\s+([A-Z\s\/]+?)(?:\s*(?:\([^)]*\)|\/[^/]*\/))?\s*\.{2,3}/)
            || line.match(/^\.([A-Z\s\/]+?)(?:\s*(?:\([^)]*\)|\/[^/]*\/))?\s*\.{2,3}/);
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

// ─── AI artifact stripping ──────────────────────────────────────────
// Strips markdown headers, horizontal rules, backticks, and NWS "KEY Message" prefixes
// from AI translation output. Applied to ALL output paths (AI + regex + takeaway).
function stripAIArtifacts(text) {
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

function escapeHTML(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text) {
    return escapeHTML(text).replace(/"/g, '&quot;');
}

// ─── Plain English translation ─────────────────────────────────────
// Shared NWS artifact cleanup used by both translation and alert formatting
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

function translateToPlainEnglish(text) {
    let t = text;

    // Remove NWS timestamps like "15/913 AM.", "15/935 AM.", "15/1801Z.", "15/1002 AM."
    t = t.replace(/\d{2}\/\d{3,4}\s*(?:AM|PM|Z)\.?\s*/gi, '');

    // Remove NWS product code references and "see the CFWLOX..." sentences
    t = t.replace(/,?\s*see\s+the\s+[A-Z]{3,12}\s+(?:and\s+[A-Z]{3,12}\s+)?products?\s+for\s+more\s+details\.?/gi, '.');

    // Strip shared NWS artifacts
    t = stripNWSArtifacts(t);

    // Convert ***Header*** to sub-section markers (before collapsing whitespace)
    t = t.replace(/\*{3}\s*([^*]+?)\s*\*{3}/g, '\n\n§§§$1§§§\n\n');

    // Remove embedded sub-section headers like ".SHORT TERM (TDY-TUE)..." that leak through
    t = t.replace(/\.(?:SHORT|LONG|NEAR)\s+TERM\s*\([^)]*\)\.\s*/gi, '');

    // Remove NWS formatting artifacts
    t = t.replace(/\.{3,}/g, '. ');
    // Collapse runs of spaces (but preserve newlines for paragraph splitting)
    t = t.replace(/[ \t]{2,}/g, ' ');

    // Expand abbreviations using imported FULL_ABBREVIATIONS
    for (const [pat, rep] of FULL_ABBREVIATIONS) {
        t = t.replace(pat, rep);
    }

    // Convert Zulu time references: 18Z → local time (DST-aware)
    t = t.replace(/\b(\d{2,4})Z\b/g, (_, h) => {
        const utcHour = parseInt(h.length <= 2 ? h : h.substring(0, 2));
        const utcMin = h.length > 2 ? parseInt(h.substring(2)) : 0;
        // Create a UTC date for today to get proper DST offset
        const now = new Date();
        const utcDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour, utcMin));
        // Use the office timezone if available, fallback to America/Los_Angeles
        const tz = OFFICE_TIMEZONES[currentOffice] || 'America/Los_Angeles';
        try {
            const local = utcDate.toLocaleString('en-US', { hour: 'numeric', minute: utcMin > 0 ? '2-digit' : undefined, timeZone: tz, timeZoneName: 'short' });
            return local;
        } catch(e) {
            console.debug('Timezone conversion failed', e);
            // Fallback: use IANA zone to determine standard offset
            const stdOffsets = { 'America/New_York': -5, 'America/Detroit': -5, 'America/Indiana/Indianapolis': -5, 'America/Chicago': -6, 'America/Denver': -7, 'America/Phoenix': -7, 'America/Los_Angeles': -8, 'America/Anchorage': -9, 'Pacific/Honolulu': -10 };
            const offset = stdOffsets[tz] || -8;
            let localHr = (utcHour + offset + 24) % 24;
            const ampm = localHr >= 12 ? 'PM' : 'AM';
            const hr12 = localHr === 0 ? 12 : localHr > 12 ? localHr - 12 : localHr;
            return `${hr12} ${ampm}`;
        }
    });

    // Clean up geopotential heights: "541 dam" → "a 541-dam"
    t = t.replace(/(\d{3})\s*dam\b/g, '$1-decameter');

    // Clean up pressure level references
    t = t.replace(/(\d{3,4})\s*mb\b/g, '$1 mb level');

    // Convert long ALL CAPS stretches (5+ chars) to sentence case (skip known terms)
    t = t.replace(/\b([A-Z]{5,})\b/g, (m) => {
        if (GLOSSARY[m]) return m;
        return m.charAt(0) + m.slice(1).toLowerCase();
    });

    // "ern" catch-all removed — too aggressive, collides with English words

    // Clean up artifacts from stripped content
    t = t.replace(/^\.\s*/gm, '');
    t = t.trim();
    t = escapeHTML(t);

    // ─── Bold pass: make key info skimmable ─────────────────────────
    // Helper: bold only first occurrence of each match
    const boldSeen = new Set();
    const boldFirst = (str, pattern) => {
        return str.replace(pattern, (m) => {
            const k = m.toLowerCase().trim();
            if (boldSeen.has(k)) return m;
            boldSeen.add(k);
            return `<strong>${m}</strong>`;
        });
    };

    // Days of week — first occurrence only
    t = boldFirst(t, /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g);
    // Timeframes — first occurrence only
    t = boldFirst(t, /\b(tonight|this morning|this afternoon|this evening|overnight|today)\b/gi);

    // Temperatures
    t = t.replace(/(\d{1,3})\s*(?:degrees?|°)\s*(?:F|fahrenheit)?/gi, '<strong>$1°</strong>');
    // Wind speeds
    t = t.replace(/\b(\d{1,3})\s*(?:mph)\b/gi, '<strong>$1 mph</strong>');

    // Rainfall/snow ranges: "4 to 8 inches", "1-2.5 inches" (not ft — skip ceiling heights)
    t = t.replace(/\b(\d+(?:\.\d+)?)\s*(?:to|-)\s*(\d+(?:\.\d+)?)\s*(inches?|")\b/gi,
        (_, a, b) => `<strong>${a}–${b}"</strong>`);
    // Single number + inches
    t = t.replace(/\b(\d+(?:\.\d+)?)\s*(inches?|")\b/gi, '<strong>$1"</strong>');
    // Worded amounts
    t = t.replace(/\b((?:a\s+)?half(?:\s+and\s+one)?\s+inch(?:\s+per\s+hour)?)\b/gi, '<strong>$1</strong>');

    // Hazard terms — first occurrence only
    t = boldFirst(t, /\b(severe thunderstorms?|flash flood(?:ing)?|debris flows?|damaging winds?|heavy (?:mountain )?snow|high surf|coastal flood(?:ing)?)\b/gi);
    // Alert types — first occurrence only
    t = boldFirst(t, /\b(small craft advisory|gale warning|winter storm (?:watch|warning)|flood watch|wind advisory|high wind watch|high surf advisory|beach hazards? statement)\b/gi);

    // Clean up any double-bolded from overlapping matches
    t = t.replace(/<strong><strong>/g, '<strong>');
    t = t.replace(/<\/strong><\/strong>/g, '</strong>');

    // Split into blocks on double newlines
    const blocks = t.split(/\n\s*\n+/).filter(b => b.trim());

    let html = '';
    for (const block of blocks) {
        const trimmed = block.trim();
        // Check for sub-section header marker
        const subMatch = trimmed.match(/§§§\s*(.+?)\s*§§§\s*([\s\S]*)/);
        if (subMatch) {
            const title = subMatch[1].trim();
            const body = subMatch[2].trim();
            html += `<h3 class="sub-header">${title}</h3>`;
            if (body) html += `<p>${body}</p>`;
        } else if (!trimmed.match(/^§§§/)) {
            // Skip orphaned markers, render normal paragraphs
            html += `<p>${trimmed.replace(/\n/g, ' ')}</p>`;
        }
    }
    return html;
}

// ─── Annotated text with jargon highlights ──────────────────────────
function annotateText(text) {
    // Escape HTML
    let t = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Use placeholder tokens to prevent nested replacement
    const placeholders = [];
    let jargonId = 0;
    for (const { key, regex, tipText } of GLOSSARY_COMPILED) {
        regex.lastIndex = 0; // reset stateful regex
        t = t.replace(regex, (match) => {
            const idx = placeholders.length;
            const tipId = `jargon-tip-${jargonId++}`;
            placeholders.push(`<span class="jargon" tabindex="0" aria-describedby="${tipId}">${match}<span class="tip" role="tooltip" id="${tipId}">${tipText}</span></span>`);
            return `\x00JARGON${idx}\x00`;
        });
    }

    // Replace placeholders with actual HTML
    for (let i = 0; i < placeholders.length; i++) {
        t = t.replace(`\x00JARGON${i}\x00`, placeholders[i]);
    }

    return t;
}

// ─── Key Takeaway extraction ────────────────────────────────────────
function extractTakeaway(sections) {
    // Prefer KEY MESSAGES section (used by many NWS offices like LOT)
    const messagesSection = sections.find(s => s.key === 'Messages');
    if (messagesSection) {
        const text = messagesSection.text.replace(/\.{2,}/g, '. ').replace(/\s+/g, ' ').trim();
        // KEY MESSAGES are already concise bullet points — use them directly
        return stripAIArtifacts(translateToPlainEnglish(text).replace(/<\/?p>/g, ''));
    }
    // Fall back to synopsis or discussion, or first section
    const synSection = sections.find(s => s.key === 'Synopsis')
        || sections.find(s => s.key === 'Discussion')
        || sections[0];
    if (!synSection) return '';
    // Strip leading "Issued at..." timestamps that some offices embed in DISCUSSION
    let text = synSection.text.replace(/^Issued at \d.+?\d{4}\s*/i, '');
    text = text.replace(/\.{2,}/g, '. ').replace(/\s+/g, ' ').trim();
    const sentences = text.match(/[^.!?]+[.!?]+/g);
    if (!sentences) return text.substring(0, 200);
    const takeaway = sentences.slice(0, 2).join(' ').trim();
    // Quick cleanup
    return stripAIArtifacts(translateToPlainEnglish(takeaway).replace(/<\/?p>/g, ''));
}

// ─── Confidence indicator ────────────────────────────────────────────
// Visually-hidden live region announcer for screen readers (see #sr-status).
function announce(msg) {
    const el = document.getElementById('sr-status');
    if (el) el.textContent = msg;
}

// Lightweight failure telemetry via Vercel Web Analytics (no-op if not loaded),
// so the owner can see which offices/sections actually fail in the dashboard.
function track(name, data) {
    try { if (window.va) window.va('event', { name, data: data || {} }); } catch (e) { /* never break the page */ }
}

function displayConfidence(fullText) {
    const container = document.getElementById('confidence-container');
    const bar = document.getElementById('confidence-bar');
    const text = document.getElementById('confidence-text');
    const t = fullText.toLowerCase();

    // Weighted phrases: multi-word explicit confidence language scores higher
    // than single common words that appear in nearly every forecast
    const uncertainPhrases = [
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
    const certainPhrases = [
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
    if (total === 0) { container.style.display = 'none'; return; }

    // Score: 0 (all uncertain) to 100 (all certain)
    const score = Math.round((certainScore / total) * 100);

    // The bar fill is a graphical object (3:1 suffices), but the text label
    // needs 4.5:1 — so the label gets a theme-aware .conf-* class (styles.css)
    // instead of the saturated bar color, which failed contrast in one theme.
    let label, barColor;
    if (score >= 75) { label = 'High'; barColor = '#16a34a'; }
    else if (score >= 50) { label = 'Moderate'; barColor = '#0F766E'; }
    else if (score >= 30) { label = 'Mixed'; barColor = '#d97706'; }
    else { label = 'Low'; barColor = '#dc2626'; }

    bar.style.width = `${score}%`;
    bar.style.background = barColor;
    bar.setAttribute('role', 'meter');
    bar.setAttribute('aria-valuenow', score);
    bar.setAttribute('aria-valuemin', 0);
    bar.setAttribute('aria-valuemax', 100);
    bar.setAttribute('aria-label', `Forecaster confidence: ${label}`);
    bar.title = `Confidence score: ${score}%`;
    text.textContent = label;
    text.className = 'confidence-text conf-' + label.toLowerCase();
    text.style.color = ''; // contrast-safe color comes from the .conf-* class
    container.style.display = '';
}

// ─── Format Active Alerts as a clean list ───────────────────────────
// Alert modal — data store keyed by index (avoids inline JSON / XSS)
const ALERT_DATA = {};
let alertIdx = 0;
let lastModalFocus = null; // restore focus to the opener when a modal closes

function showAlertModal(data) {
    lastModalFocus = document.activeElement;
    const overlay = document.getElementById('alert-modal-overlay');
    document.getElementById('alert-modal-title').textContent = data.headline;
    const meta = [];
    if (data.severity) meta.push(data.severity);
    if (data.areaDesc) meta.push(data.areaDesc);
    if (data.expires) {
        try { meta.push('Expires ' + new Date(data.expires).toLocaleString()); } catch(e) { console.debug('Date parse error', e); }
    }
    document.getElementById('alert-modal-meta').textContent = meta.join(' · ');
    let body = data.description || '';
    if (data.instruction) body += '\n\n' + data.instruction;
    document.getElementById('alert-modal-body').textContent = body;
    overlay.classList.add('open');
    // Focus trap: move focus into modal
    document.getElementById('alert-modal-close').focus();
}

function closeAlertModal() {
    document.getElementById('alert-modal-overlay').classList.remove('open');
    if (lastModalFocus && lastModalFocus.focus) lastModalFocus.focus();
    lastModalFocus = null;
}

document.addEventListener('DOMContentLoaded', () => {
    const overlay = document.getElementById('alert-modal-overlay');
    if (!overlay) return;
    document.getElementById('alert-modal-close').addEventListener('click', closeAlertModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAlertModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAlertModal(); });

    // Focus trap within modal
    overlay.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const focusable = overlay.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    // Event delegation for alert links (avoids inline onclick / XSS)
    document.addEventListener('click', (e) => {
        const link = e.target.closest('[data-alert-idx]');
        if (link) showAlertModal(ALERT_DATA[link.dataset.alertIdx]);
    });

    // Jargon tooltip tap-to-toggle for mobile with bounds checking
    document.addEventListener('click', (e) => {
        const jargon = e.target.closest('.jargon');
        // Close all other open tooltips and reset their styles
        document.querySelectorAll('.jargon.tip-open').forEach(el => {
            if (el !== jargon) {
                el.classList.remove('tip-open');
                const tip = el.querySelector('.tip');
                if (tip) { tip.style.left = ''; tip.style.right = ''; tip.style.transform = ''; tip.classList.remove('tip-below'); }
            }
        });
        if (jargon) {
            jargon.classList.toggle('tip-open');
            if (jargon.classList.contains('tip-open')) {
                const tip = jargon.querySelector('.tip');
                if (tip) {
                    // Reset position first
                    tip.style.left = ''; tip.style.right = ''; tip.style.transform = ''; tip.classList.remove('tip-below');
                    const rect = tip.getBoundingClientRect();
                    // Fix horizontal overflow
                    if (rect.left < 8) { tip.style.left = '0'; tip.style.transform = 'none'; }
                    else if (rect.right > window.innerWidth - 8) { tip.style.left = 'auto'; tip.style.right = '0'; tip.style.transform = 'none'; }
                    // Flip below if overflowing top
                    if (rect.top < 0) { tip.classList.add('tip-below'); }
                }
            }
        }
    });

    // Mobile view toggle (Summary / Original + Annotations)
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-view]');
        if (!btn) return;
        const section = btn.closest('.forecast-section');
        if (!section) return;
        const columns = section.querySelector('.columns');
        const view = btn.dataset.view;
        // Update button states
        section.querySelectorAll('[data-view]').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        // Update column visibility
        columns.classList.remove('show-plain', 'show-original');
        columns.classList.add(view === 'plain' ? 'show-plain' : 'show-original');
    });
});

// Known NWS alert types — used both to format advisories and to tell a real
// watches/warnings body from an empty "None." (or "AZ...None. CA...None.") one.
const ALERT_PATTERN = /((?:High Wind (?:Watch|Warning)|Wind Advisory|Flood (?:Watch|Warning)|High Surf (?:Advisory|Warning)|Beach Hazards? Statement|Winter Storm (?:Watch|Warning)|Winter Weather Advisory|Small Craft Advisory|Gale Warning|Storm Warning|Red Flag Warning|Fire Weather Watch|Tornado (?:Watch|Warning)|Severe Thunderstorm (?:Watch|Warning)|Flash Flood (?:Watch|Warning)|Blizzard Warning|Ice Storm Warning|Freeze (?:Watch|Warning)|Frost Advisory|Dense Fog Advisory|Heat Advisory|Excessive Heat Warning|Extreme (?:Heat|Cold) Warning|Wind Chill (?:Watch|Warning|Advisory)|Tropical Storm (?:Watch|Warning)|Hurricane (?:Watch|Warning)|Rip Current Statement|Coastal Flood (?:Watch|Warning|Advisory|Statement))[^.]*\.?)/gi;

// True only when a watches/warnings section actually names an advisory.
function hasRealAlerts(text) {
    if (!text) return false;
    return !!stripNWSArtifacts(text).match(ALERT_PATTERN);
}

function formatAlerts(text, alertMap) {
    // Strip NWS artifacts and format as list items
    let t = stripNWSArtifacts(text);

    const matches = t.match(ALERT_PATTERN);
    if (!matches || matches.length === 0) {
        return `<p>${escapeHTML(t)}</p>`;
    }

    const items = matches.map(m => {
        let item = m.trim().replace(/\.\s*$/, '').replace(/^\.\s*/, '').trim();
        item = item.charAt(0).toUpperCase() + item.slice(1);
        const safeItem = escapeHTML(item);
        // Classify by severity
        let cls = 'alert-advisory';
        if (/warning/i.test(item)) cls = 'alert-warning';
        else if (/watch/i.test(item)) cls = 'alert-watch';
        else if (/statement/i.test(item)) cls = 'alert-statement';
        // Severity icon for accessibility (not color-only)
        const icon = /warning/i.test(item) ? '⚠️ ' : /watch/i.test(item) ? '👁️ ' : /statement/i.test(item) ? 'ℹ️ ' : '🔹 ';
        // Try to find matching alert details (alertMap values are arrays)
        let alertEntries = null;
        if (alertMap) {
            for (const [event, entries] of Object.entries(alertMap)) {
                if (item.toLowerCase().includes(event.toLowerCase())) { alertEntries = entries; break; }
            }
        }
        let content;
        if (alertEntries && alertEntries.length === 1) {
            const idx = alertIdx++;
            ALERT_DATA[idx] = alertEntries[0];
            content = `<button class="alert-link" data-alert-idx="${idx}" aria-label="View details: ${escapeAttr(item)}">${icon}${safeItem}</button>`;
        } else if (alertEntries && alertEntries.length > 1) {
            // Multiple alerts of same type — show each with area info
            content = alertEntries.map(ad => {
                const idx = alertIdx++;
                ALERT_DATA[idx] = ad;
                const area = ad.areaDesc ? ` (${ad.areaDesc.split(';')[0].trim()})` : '';
                return `<button class="alert-link" data-alert-idx="${idx}" aria-label="View details: ${escapeAttr(item + area)}">${icon}${safeItem}${escapeHTML(area)}</button>`;
            }).join('');
        } else {
            content = `${icon}${safeItem}`;
        }
        return `<li class="${cls}">${content}</li>`;
    });

    return `<ul class="alert-list">${items.join('')}</ul>`;
}

// ─── AI Translation ─────────────────────────────────────────────────
const aiCache = new Map();
const AI_CACHE_MAX = 100;

async function fetchAITranslation(text, section, office, issuanceTime) {
    const key = `${office}|${section}|${issuanceTime || ''}|${text}`;
    if (aiCache.has(key)) return aiCache.get(key);

    const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, section, office, issuanceTime })
    });
    if (!res.ok) throw new Error('Translation failed');
    const data = await res.json();
    let safe = stripAIArtifacts(data.translation)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let html = safe
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .split(/\n\s*\n+/)
        .filter(b => b.trim())
        .map(b => `<p>${b.trim().replace(/\n/g, ' ')}</p>`)
        .join('');
    if (aiCache.size >= AI_CACHE_MAX) {
        aiCache.delete(aiCache.keys().next().value);
    }
    aiCache.set(key, html);
    return html;
}

// ─── Smart section ordering ──────────────────────────────────────
// Reorder sections based on context: alerts first when active,
// elevate Marine for coastal offices, Fire Weather for inland.
function reorderSections(sections, office, hasAlerts) {
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

// ─── Render ─────────────────────────────────────────────────────────
function render(sections, productContext = {}) {
    const sectionsEl = document.getElementById('sections');
    const navEl = document.getElementById('section-nav');
    const takeawayContainer = document.getElementById('takeaway-container');
    const takeawayText = document.getElementById('takeaway-text');

    // Key takeaway
    const takeaway = extractTakeaway(sections);
    if (takeaway) {
        takeawayText.innerHTML = takeaway;
        takeawayContainer.style.display = '';
    }

    // Section nav — sanitize IDs for URL safety
    const safeId = (key) => key.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    // An "Active Alerts" section whose body is just "None." is hidden (and dropped
    // from the nav) until live alerts arrive — otherwise quiet offices get a
    // meaningless "Active Alerts — None." card pinned to the top.
    const isEmptyAlerts = (s) => s.key === 'Active Alerts'
        && !hasRealAlerts(s.text) && Object.keys(currentAlerts).length === 0;
    navEl.innerHTML = sections.filter(s => !isEmptyAlerts(s)).map(s =>
        `<a href="#section-${safeId(s.key)}" aria-label="Jump to ${s.key} section">${s.key}</a>`
    ).join('');

    // The first *narrative* section carries the drop-cap "lede" treatment — never a
    // bulleted Messages/alerts block (whose first glyph is a list numeral).
    const NARRATIVE = ['Synopsis', 'Discussion', 'Short Term', 'Near Term', 'Long Term', 'Update'];
    const ledeKey = (sections.find(s => NARRATIVE.includes(s.key)) || {}).key;

    // Render sections with regex translation first (instant), then upgrade with AI lazily
    sectionsEl.innerHTML = sections.map(s => {
        let plainHtml;
        const hiddenAttr = isEmptyAlerts(s) ? ' style="display:none"' : '';
        const ledeCls = s.key === ledeKey ? ' lede-section' : '';
        if (s.key === 'Active Alerts') {
            plainHtml = formatAlerts(s.text, currentAlerts);
        } else {
            // Show regex translation immediately with AI loading indicator
            const regexHtml = translateToPlainEnglish(s.text);
            plainHtml = regexHtml
                + '<div class="ai-loading-label"><span class="ai-loading"></span> Summarizing…</div>';
        }
        return `
        <div class="forecast-section${ledeCls}"${hiddenAttr} id="section-${safeId(s.key)}" data-section-key="${s.key}">
            <h2 class="section-title">${s.key}</h2>
            <div class="ai-toggle">
                <button class="ai-toggle-btn active" data-view="plain" aria-pressed="true">In plain English</button>
                <button class="ai-toggle-btn" data-view="original" aria-pressed="false">The original</button>
            </div>
            <div class="columns show-plain">
                <div>
                    <div class="col-label">In plain English</div>
                    <div class="plain-col">${plainHtml}</div>
                </div>
                <div>
                    <div class="col-label">The original · verbatim</div>
                    <div class="annotated-col">${annotateText(s.text)}</div>
                </div>
            </div>
        </div>`;
    }).join('');

    // Lazy AI translation via IntersectionObserver with lifecycle cleanup
    const renderGen = fetchGeneration;
    const inFlight = new Set();

    if (currentTranslationObserver) {
        currentTranslationObserver.disconnect();
        currentTranslationObserver = null;
    }

    const toTranslate = sections.filter(s => s.key !== 'Active Alerts');

    async function upgradeSection(s) {
        const sectionId = safeId(s.key);
        if (inFlight.has(sectionId)) return;
        inFlight.add(sectionId);
        if (renderGen !== fetchGeneration) return;

        const el = document.getElementById('section-' + sectionId);
        if (!el) return;
        const plainCol = el.querySelector('.plain-col');

        try {
            const html = await fetchAITranslation(s.text, s.key, currentOffice, productContext.issuanceTime);
            if (renderGen !== fetchGeneration) return;

            // Crossfade: lock height, fade out, swap content, fade in
            const currentHeight = plainCol.offsetHeight;
            plainCol.style.minHeight = currentHeight + 'px';
            plainCol.style.opacity = '0';

            setTimeout(() => {
                if (renderGen !== fetchGeneration) return;
                plainCol.innerHTML = html;
                plainCol.style.opacity = '1';
                // Credit Claude only once its translation is actually on screen —
                // the regex gloss shown before (or instead, on AI failure) isn't its work.
                const colLabel = el.querySelector('.col-label');
                if (colLabel) colLabel.innerHTML = 'In plain English · via <a href="https://www.anthropic.com/claude/haiku" target="_blank" rel="noopener noreferrer">Claude</a>';
                setTimeout(() => { plainCol.style.minHeight = ''; }, 250);
            }, 200);
        } catch (err) {
            if (renderGen !== fetchGeneration) return;
            console.debug('AI translation failed for', s.key, err);
            track('ai-translate-fail', { office: currentOffice, section: s.key });
            const loadingLabel = plainCol.querySelector('.ai-loading-label');
            if (loadingLabel) loadingLabel.remove();
        }
    }

    // IntersectionObserver: translate sections as they scroll into view
    if ('IntersectionObserver' in window) {
        currentTranslationObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const sectionKey = entry.target.dataset.sectionKey;
                const section = toTranslate.find(s => s.key === sectionKey);
                if (section) {
                    upgradeSection(section);
                    currentTranslationObserver.unobserve(entry.target);
                }
            }
        }, { rootMargin: '200px' });

        for (const s of toTranslate) {
            const el = document.getElementById('section-' + safeId(s.key));
            if (el) currentTranslationObserver.observe(el);
        }
    } else {
        // Fallback for browsers without IntersectionObserver
        for (const s of toTranslate) upgradeSection(s);
    }
}

// ─── Helpers ────────────────────────────────────────────────────────
function timeAgo(date) {
    const diffMs = Date.now() - date;
    const diffMins = Math.round(diffMs / 60000);
    const diffHours = Math.round(diffMs / 3600000);
    if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    const days = Math.round(diffHours / 24);
    return `${days} day${days !== 1 ? 's' : ''} ago`;
}

// ─── Masthead helpers ───────────────────────────────────────────────
function localHour(date, tz) {
    try {
        return parseInt(date.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: tz }), 10) % 24;
    } catch (e) { return date.getHours(); }
}

// NWS issues AFDs roughly 4×/day; name the edition by local issuance hour.
function editionName(hour) {
    if (hour >= 3 && hour < 9) return 'Morning';
    if (hour >= 9 && hour < 14) return 'Midday';
    if (hour >= 14 && hour < 20) return 'Evening';
    return 'Late';
}

// ─── Living sky: time-of-day phase from the city's current local time ───
function skyPhase(date, tz) {
    const h = localHour(date, tz);
    if (h < 5)  return 'night';
    if (h < 7)  return 'dawn';
    if (h < 10) return 'morning';
    if (h < 16) return 'midday';
    if (h < 18) return 'golden';
    if (h < 20) return 'dusk';
    return 'night';
}
function applySky(office) {
    const tz = OFFICE_TIMEZONES[office] || 'America/Los_Angeles';
    document.documentElement.dataset.phase = skyPhase(new Date(), tz);
}
// Re-evaluate the sky every 5 minutes (the CSS 1.8s transition crossfades it).
setInterval(() => applySky(currentOffice), 5 * 60 * 1000);

// Map an NWS observation phrase to one of our atmosphere conditions.
function mapCondition(desc) {
    const d = (desc || '').toLowerCase();
    if (/(fog|mist|haze|smoke)/.test(d)) return 'fog';
    if (/(snow|sleet|ice|wintry|flurr)/.test(d)) return 'snow';
    if (/(rain|shower|drizzle|thunder|storm)/.test(d)) return 'rain';
    if (/(cloud|overcast)/.test(d)) return 'clouds';
    return 'clear';
}

// ─── Almanac: sun + moon ────────────────────────────────────────────
// Sunrise/sunset via the SunCalc algorithm (Vladimir Agafonkin, BSD-2).
function sunTimes(lat, lng, date) {
    const rad = Math.PI / 180, dayMs = 86400000, J1970 = 2440588, J2000 = 2451545;
    const toDays = d => d.valueOf() / dayMs - 0.5 + J1970 - J2000;
    const solarMeanAnomaly = d => rad * (357.5291 + 0.98560028 * d);
    const eclipticLongitude = M => M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
    const declination = L => Math.asin(Math.sin(L) * Math.sin(rad * 23.4397));
    const fromJulian = j => new Date((j + 0.5 - J1970) * dayMs);
    const d = toDays(date), lw = rad * -lng, phi = rad * lat;
    const n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
    const ds = 0.0009 + (lw) / (2 * Math.PI) + n;
    const M = solarMeanAnomaly(ds), L = eclipticLongitude(M);
    const dec = declination(L);
    const Jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    const h0 = rad * -0.833;
    const cosH = (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
    if (cosH > 1 || cosH < -1) return null; // polar day / night
    const w = Math.acos(cosH);
    const dsSet = 0.0009 + (w + lw) / (2 * Math.PI) + n;
    const Jset = J2000 + dsSet + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    return { sunrise: fromJulian(Jnoon - (Jset - Jnoon)), sunset: fromJulian(Jset) };
}
// Moon phase from a fixed reference new moon (pure date math).
function moonPhase(date) {
    const synodic = 29.530588853;
    const ref = Date.UTC(2000, 0, 6, 18, 14);
    const p = ((((date.valueOf() - ref) / 86400000) % synodic) + synodic) % synodic / synodic;
    const idx = Math.round(p * 8) % 8;
    const names = ['New', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
    return { name: names[idx], phase: p };
}

// A small two-tone moon disc: a shadowed body with the lit limb on the correct
// side (N. hemisphere — waxing lit right, waning lit left). Legible at ~16px.
function moonSVG(p) {
    const R = 7, C = 8;
    const cosA = Math.cos(2 * Math.PI * p);   // p0:+1 (new) · p.5:-1 (full)
    const rx = R * Math.abs(cosA);
    const waxing = p < 0.5;
    const outerSweep = waxing ? 1 : 0;
    const innerSweep = cosA < 0 ? outerSweep : (waxing ? 0 : 1);
    const lit = `M${C},${C - R} A${R},${R} 0 0 ${outerSweep} ${C},${C + R} A${rx},${R} 0 0 ${innerSweep} ${C},${C - R} Z`;
    return `<svg class="moon-glyph" viewBox="0 0 16 16" aria-hidden="true">`
        + `<circle class="moon-disc" cx="${C}" cy="${C}" r="${R}"/>`
        + `<path class="moon-lit" d="${lit}"/></svg>`;
}

function ledgerCell(dt, dd) { return `<div class="ledger-cell"><dt>${dt}</dt><dd>${dd}</dd></div>`; }

// The hairline-ruled almanac ledger. Sun + moon are known immediately; live
// conditions (Now / Normal high) are prepended async, only once they resolve.
function renderLedger(office) {
    const el = document.getElementById('ledger');
    if (!el) return;
    const tz = OFFICE_TIMEZONES[office] || 'America/Los_Angeles';
    const cells = [];
    const coords = OFFICE_COORDS[office];
    if (coords) {
        const s = sunTimes(coords[0], coords[1], new Date());
        if (s) {
            const fmt = d => d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
            const mins = Math.round((s.sunset - s.sunrise) / 60000);
            cells.push(ledgerCell('Sunrise', fmt(s.sunrise)));
            cells.push(ledgerCell('Sunset', fmt(s.sunset)));
            if (mins > 0 && mins < 1440) cells.push(ledgerCell('Daylight', `${Math.floor(mins / 60)}h ${mins % 60}m`));
        }
    }
    const m = moonPhase(new Date());
    cells.push(ledgerCell('Moon', `${moonSVG(m.phase)} ${m.name}`));
    el.innerHTML = cells.join('');
}

// ─── Fetch AFD ──────────────────────────────────────────────────────
async function fetchAFD(office) {
    currentOffice = office;
    viewingHistorical = false; // a fresh load is always the latest edition
    delete document.documentElement.dataset.condition; // neutral sky until new conditions resolve
    const thisGen = ++fetchGeneration;
    const sectionsEl = document.getElementById('sections');
    sectionsEl.innerHTML = `
    <div class="skeleton">
        <div class="skeleton-takeaway"></div>
        <div class="skeleton-confidence"></div>
        <div class="skeleton-section"><div class="skeleton-title"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div><div class="skeleton-line"></div></div>
        <div class="skeleton-section"><div class="skeleton-title"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>
        <div class="skeleton-section"><div class="skeleton-title"></div><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>
    </div>`;
    // Reset alert state for new fetch
    alertIdx = 0;
    for (const k of Object.keys(ALERT_DATA)) delete ALERT_DATA[k];

    // Update footer office name
    const footerOffice = document.getElementById('footer-office');
    if (footerOffice) footerOffice.textContent = office;
    announce(`Loading the ${OFFICE_NAMES[office] || office} forecast`);

    // Check cache first (15 min TTL)
    let cached = null;
    try {
        cached = sessionStorage.getItem(`afd-${office}`);
    } catch(e) {
        console.debug('AFD cache read failed', e);
    }
    if (cached) {
        try {
            const { time, prodData } = JSON.parse(cached);
            if (Date.now() - time < 15 * 60 * 1000) {
                if (thisGen === fetchGeneration) renderAFD(prodData, office);
                return;
            }
        } catch(e) { console.debug('Cache parse error, refetching', e); }
    }

    try {
        const listRes = await fetch(`https://api.weather.gov/products/types/AFD/locations/${office}`, {
            headers: { 'User-Agent': 'Plaincast/1.0 (plaincast.live)' }
        });
        if (!listRes.ok) throw new Error(`API error: ${listRes.status} ${listRes.statusText}`);
        if (thisGen !== fetchGeneration) return; // stale request
        const listData = await listRes.json();
        const latest = listData['@graph']?.[0];
        if (!latest) throw new Error('No AFD found for this office');

        const prodUrl = latest['@id'] || `https://api.weather.gov/products/${latest.id}`;
        const prodRes = await fetch(prodUrl, {
            headers: { 'User-Agent': 'Plaincast/1.0 (plaincast.live)' }
        });
        if (!prodRes.ok) throw new Error(`Product fetch error: ${prodRes.status}`);
        if (thisGen !== fetchGeneration) return; // stale request
        const prodData = await prodRes.json();

        try {
            sessionStorage.setItem(`afd-${office}`, JSON.stringify({
                time: Date.now(),
                prodData
            }));
        } catch(e) {
            console.debug('AFD cache write failed', e);
        }

        if (thisGen === fetchGeneration) renderAFD(prodData, office);

    } catch (err) {
        if (thisGen !== fetchGeneration) return;
        // Try stale cache as fallback
        if (cached) {
            try {
                const { prodData } = JSON.parse(cached);
                renderAFD(prodData, office);
                return;
            } catch(e) { console.debug('Stale cache fallback failed', e); }
        }
        sectionsEl.textContent = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'loading';
        errDiv.setAttribute('role', 'alert');
        const msg = document.createElement('div');
        msg.style.cssText = 'font-family:var(--font-ui)';
        msg.textContent = 'Couldn\u2019t load forecast. Check your connection and try again.';
        errDiv.appendChild(msg);
        const retryBtn = document.createElement('button');
        retryBtn.style.cssText = 'margin-top:1rem;font-family:var(--font-ui);font-size:0.85rem;padding:0.35rem 1rem;border-radius:999px;border:1px solid var(--teal);background:none;color:var(--teal);cursor:pointer';
        retryBtn.textContent = 'Retry';
        retryBtn.addEventListener('click', () => fetchAFD(office));
        errDiv.appendChild(retryBtn);
        const detail = document.createElement('div');
        detail.style.cssText = 'font-family:var(--font-ui);font-size:0.7rem;color:var(--text-muted);margin-top:0.5rem';
        detail.textContent = err.message;
        errDiv.appendChild(detail);
        sectionsEl.appendChild(errDiv);
        console.error(err);
        track('afd-fetch-fail', { office });
    }
}

// ─── afterRender callback array (replaces monkey-patching) ──────────
const afterRender = [];

async function renderAFD(prodData, office) {
    const sectionsEl = document.getElementById('sections');

    // Update raw link
    const rawUrl = prodData['@id'] || `https://api.weather.gov/products/${prodData.id}`;
    document.getElementById('raw-link').href = rawUrl;

    // Parse issue time with office timezone
    const tz = OFFICE_TIMEZONES[office] || 'America/Los_Angeles';
    const issueTime = new Date(prodData.issuanceTime);
    issueTimeDate = issueTime;
    applySky(office);

    // Parse sections (also yields the forecaster signature, used for the byline)
    const { sections, forecaster } = parseSections(prodData.productText);

    // ── Masthead: folio lines + a terse, authoritative dateline ──
    const edition = editionName(localHour(issueTime, tz));
    const cityEl = document.getElementById('dateline-city');
    if (cityEl) cityEl.textContent = OFFICE_NAMES[office] || office;
    const dlDate = document.getElementById('dateline-date');
    if (dlDate) dlDate.textContent = 'Area Forecast Discussion';
    const dlEd = document.getElementById('dateline-edition');
    if (dlEd) dlEd.textContent = `${edition} Edition`;

    const folioDate = document.getElementById('folio-date');
    if (folioDate) folioDate.textContent =
        issueTime.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: tz });
    const folioOffice = document.getElementById('folio-office');
    if (folioOffice) folioOffice.textContent = `NWS ${office}`;

    // "Issued <time> · <ago>" lives in the lede meta line, beside confidence.
    issuePrefix = `Issued ${issueTime.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' })}`;
    document.getElementById('issue-time').textContent = `${issuePrefix} · ${timeAgo(issueTime)}`;

    // Byline — the forecaster, in their own newsroom
    const bylineEl = document.getElementById('byline');
    if (bylineEl) {
        const desk = OFFICE_SENDER[office] || OFFICE_NAMES[office] || office;
        bylineEl.innerHTML = forecaster
            ? `By <span class="byline-name">${escapeHTML(forecaster)}</span> · National Weather Service, ${escapeHTML(desk)}`
            : `National Weather Service, ${escapeHTML(desk)}`;
    }

    // Almanac ledger (sun + moon now; live conditions arrive async via afterRender)
    renderLedger(office);

    if (sections.length === 0) {
        sectionsEl.innerHTML = '<div class="loading">Could not parse forecast sections.</div>';
        track('afd-parse-empty', { office });
        return;
    }

    // Smart section ordering: alerts first when active, coastal/fire context
    const hasAlerts = sections.some(s => s.key === 'Active Alerts' && hasRealAlerts(s.text));
    const orderedSections = reorderSections(sections, office, hasAlerts);

    // Extract and display confidence
    displayConfidence(prodData.productText);

    // Fetch live alerts for linking (non-blocking — render first, update after)
    currentAlerts = {};
    render(orderedSections, { issuanceTime: prodData.issuanceTime });

    // Then fetch alerts and re-render the alerts section with links
    fetchAlerts(office).then(alertMap => {
        currentAlerts = alertMap;
        // Re-render just the alerts section if we got links
        if (Object.keys(alertMap).length > 0) {
            const alertSection = orderedSections.find(s => s.key === 'Active Alerts');
            if (alertSection) {
                const el = document.getElementById('section-active-alerts');
                if (el) {
                    el.style.display = ''; // un-hide if it was a "None." body now superseded by live alerts
                    const plainCol = el.querySelector('.plain-col');
                    if (plainCol) plainCol.innerHTML = formatAlerts(alertSection.text, alertMap);
                }
            }
        }
    });

    announce(`${OFFICE_NAMES[office] || office} forecast loaded`);

    // Run afterRender callbacks (pass orderedSections for diff engine)
    for (const cb of afterRender) cb(prodData, office, orderedSections);
}

// ─── Geolocation: find nearest office ───────────────────────────────
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function findNearestOffice(lat, lon) {
    let nearest = 'LOX', minDist = Infinity;
    for (const [code, [oLat, oLon]] of Object.entries(OFFICE_COORDS)) {
        const d = haversineDistance(lat, lon, oLat, oLon);
        if (d < minDist) { minDist = d; nearest = code; }
    }
    return nearest;
}

// ─── Init ───────────────────────────────────────────────────────────
const officeSelect = document.getElementById('office-select');

// Office priority: ?office= > /o/<CODE>/ path > localStorage > geolocation > LOX
const urlParams = new URLSearchParams(window.location.search);
const urlOffice = urlParams.get('office')?.toUpperCase();
const pathMatch = window.location.pathname.match(/\/o\/([A-Za-z]{3})\/?$/);
const pathOffice = pathMatch ? pathMatch[1].toUpperCase() : null;
const savedOffice = (() => { try { return localStorage.getItem('plaincast-office'); } catch(e) { return null; } })();
const hasOption = (o) => o && officeSelect.querySelector(`option[value="${o}"]`);
let initialOffice = 'LOX';

if (hasOption(urlOffice)) {
    initialOffice = urlOffice;
} else if (hasOption(pathOffice)) {
    initialOffice = pathOffice; // per-office SEO landing page (/o/OKX/)
} else if (hasOption(savedOffice)) {
    initialOffice = savedOffice;
}
officeSelect.value = initialOffice;

function updateTitle(office) {
    const opt = officeSelect.querySelector(`option[value="${office}"]`);
    const name = opt ? opt.textContent.replace(/\s*\([^)]+\)/, '') : office;
    // Match the baked per-office SEO <title> (scripts/build-offices.mjs) so the
    // JS-rendered title agrees with what static crawlers see.
    document.title = `${name} NWS Forecast in Plain English · Plaincast`;
}

function selectOffice(office, updateUrl) {
    officeSelect.value = office;
    applySky(office); // instant sky change while the new forecast loads
    if (updateUrl !== false) {
        const url = new URL(window.location);
        url.searchParams.set('office', office);
        history.pushState({}, '', url);
    }
    try { localStorage.setItem('plaincast-office', office); } catch(e) { /* quota */ }
    updateTitle(office);
    // Update RSS auto-discovery link
    const rssLink = document.getElementById('rss-link');
    if (rssLink) rssLink.href = `/api/feed?office=${office}`;
    fetchAFD(office);
}

officeSelect.addEventListener('change', () => selectOffice(officeSelect.value));

// Handle browser back/forward
window.addEventListener('popstate', () => {
    const params = new URLSearchParams(window.location.search);
    const office = params.get('office')?.toUpperCase();
    if (office && officeSelect.querySelector(`option[value="${office}"]`)) {
        selectOffice(office, false);
    }
});

// Load initial office
updateTitle(initialOffice);
fetchAFD(initialOffice);

// Geolocation: auto-detect after initial load (non-blocking)
if (!urlOffice && !pathOffice && !savedOffice && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const detected = findNearestOffice(pos.coords.latitude, pos.coords.longitude);
            if (detected !== initialOffice) {
                selectOffice(detected);
                announce(`Showing ${OFFICE_NAMES[detected] || detected}, your nearest office`);
                const issueEl = document.getElementById('issue-time');
                if (issueEl) {
                    const flash = document.createElement('span');
                    flash.textContent = ' 📍 Detected';
                    flash.style.cssText = 'color:var(--teal);font-size:0.8rem;transition:opacity 1s';
                    issueEl.appendChild(flash);
                    setTimeout(() => { flash.style.opacity = '0'; }, 2000);
                    setTimeout(() => flash.remove(), 3000);
                }
            }
        },
        () => { /* denied or error — silent fallback */ },
        { timeout: 5000, maximumAge: 300000 }
    );
}

// ─── Service worker registration ────────────────────────────────────
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* no-op */ });
}

// ─── Theme toggle ───────────────────────────────────────────────────
(function() {
    const toggle = document.getElementById('theme-toggle');
    function isDark() { return document.documentElement.classList.contains('dark'); }
    function updateIcon() {
        var sun = document.getElementById('theme-icon-sun');
        var moon = document.getElementById('theme-icon-moon');
        if (sun && moon) {
            sun.style.display = isDark() ? 'none' : 'block';
            moon.style.display = isDark() ? 'block' : 'none';
        }
    }
    updateIcon();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    toggle.addEventListener('click', () => {
        const dark = !isDark();
        document.documentElement.classList.toggle('dark', dark);
        // If toggling back to match system preference, clear override so we follow the OS again
        if (dark === mq.matches) {
            localStorage.removeItem('theme');
        } else {
            localStorage.setItem('theme', dark ? 'dark' : 'light');
        }
        updateIcon();
    });
    // Follow system preference changes when no manual override is stored
    mq.addEventListener('change', (e) => {
        if (!localStorage.getItem('theme')) {
            document.documentElement.classList.toggle('dark', e.matches);
            updateIcon();
        }
    });
})();

// Auto-update "X minutes ago" every 60 seconds (preserve forecaster attribution)
setInterval(() => {
    if (!issueTimeDate) return;
    const el = document.getElementById('issue-time');
    if (el && issuePrefix) el.textContent = `${issuePrefix} · ${timeAgo(issueTimeDate)}`;
}, 60000);

// ─── Share button ───────────────────────────────────────────────────
document.getElementById('share-btn').addEventListener('click', async () => {
    const url = window.location.href;
    if (navigator.share) {
        try { await navigator.share({ title: document.title, url }); return; } catch(e) { /* cancelled */ }
    }
    try {
        await navigator.clipboard.writeText(url);
        const toast = document.getElementById('share-toast');
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2000);
    } catch(e) {
        // Fallback: select the URL in the address bar (no dialog)
        window.getSelection()?.removeAllRanges();
    }
});

// ─── Auto-refresh polling (10 min, visibility-aware) ────────────────
let lastProductId = null;
let refreshTimer = null;

function startRefreshPolling() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(async () => {
        if (document.hidden) return;
        try {
            const res = await fetch(`https://api.weather.gov/products/types/AFD/locations/${currentOffice}`, {
                headers: { 'User-Agent': 'Plaincast/1.0 (plaincast.live)' }
            });
            if (!res.ok) return;
            const data = await res.json();
            const latest = data['@graph']?.[0];
            if (latest && lastProductId && latest.id !== lastProductId) {
                document.getElementById('refresh-banner').style.display = '';
            }
        } catch(e) { /* silent retry next cycle */ }
    }, 10 * 60 * 1000);
}

// Track current product ID for refresh detection (via afterRender callback)
afterRender.push((prodData, office) => { if (viewingHistorical) return; lastProductId = prodData.id; });

// Load history after each render (via afterRender callback)
afterRender.push((prodData, office) => { fetchHistoryList(office).then(items => { historyList = items; renderHistorySelector(items, prodData.id); }); });

// Live conditions feed the almanac ledger + the atmosphere's condition tint
afterRender.push(async (prodData, office) => {
    try {
        const res = await fetch(`/api/conditions?office=${office}`);
        if (!res.ok) return;
        const data = await res.json();
        if (office !== currentOffice) return; // user switched offices mid-fetch
        if (data.condition) document.documentElement.dataset.condition = mapCondition(data.condition);
        const ledger = document.getElementById('ledger');
        if (!ledger || ledger.querySelector('.ledger-now')) return; // already prepended
        let cells = '';
        if (Number.isFinite(+data.temp)) cells += `<div class="ledger-cell ledger-now"><dt>Now</dt><dd>${+data.temp}°</dd></div>`;
        if (Number.isFinite(+data.normal)) cells += ledgerCell('Normal high', `${+data.normal}°`);
        if (cells) ledger.insertAdjacentHTML('afterbegin', cells);
    } catch (e) {
        // Silent — the ledger simply omits live conditions
    }
});

// ─── Forecast Changelog ─────────────────────────────────────────────
// One quiet, editorial "what changed since the last issuance" line under the
// Key Takeaway — shown to everyone (the server diffs the latest two AFDs and
// summarizes the delta once per issuance). The session-based per-section diff
// below stays as the detailed, expandable view.
function sinceText(iso) {
    if (!iso) return 'the last update';
    try {
        const tz = OFFICE_TIMEZONES[currentOffice] || 'America/Los_Angeles';
        const t = new Date(iso).toLocaleString('en-US', { hour: 'numeric', timeZone: tz });
        return `the ${t} update`;
    } catch (e) { return 'the last update'; }
}

function renderChangelog(text, since) {
    let el = document.getElementById('changelog-line');
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
        el = document.createElement('div');
        el.id = 'changelog-line';
        el.className = 'changelog-line';
        el.setAttribute('role', 'note');
        const takeaway = document.getElementById('takeaway-container');
        if (takeaway) takeaway.insertAdjacentElement('afterend', el);
    }
    el.innerHTML = `<span class="changelog-label">Since ${escapeHTML(sinceText(since))}</span> ${escapeHTML(text)}`;
    el.style.display = '';
}

afterRender.push(async (prodData, office) => {
    const stale = document.getElementById('changelog-line');
    if (stale) stale.remove(); // clear the prior office's line while loading
    if (viewingHistorical) return; // the "what changed" note belongs to the latest edition
    try {
        const res = await fetch(`/api/changelog?office=${office}`);
        if (!res.ok) return;
        const data = await res.json();
        if (office !== currentOffice) return; // user switched offices mid-fetch
        renderChangelog(data && data.changelog, data && data.since);
    } catch (e) { /* silent — the line just doesn't show */ }
});

// Forecast diff: compare current vs previous AFD
afterRender.push((prodData, office, sections) => {
    if (!sections) return;
    if (viewingHistorical) return; // don't diff or re-baseline against an archived edition
    const storageKey = `afd-${office}-previous-sections`;
    const safeId = (key) => key.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

    try {
        const prevRaw = sessionStorage.getItem(storageKey);
        const previousSections = prevRaw ? JSON.parse(prevRaw) : null;

        if (previousSections) {
            const diffResults = computeDiff(previousSections, sections);
            const changedCount = diffResults.filter(d => d.status !== 'unchanged').length;

            if (changedCount > 0) {
                // Add diff toggle to each changed section
                for (const diff of diffResults) {
                    if (diff.status === 'unchanged') continue;
                    const sectionEl = document.getElementById(`section-${safeId(diff.key)}`);
                    if (!sectionEl) continue;
                    const titleEl = sectionEl.querySelector('.section-title');
                    if (!titleEl || titleEl.querySelector('.diff-toggle')) continue;

                    const btn = document.createElement('button');
                    btn.className = 'diff-toggle';
                    btn.innerHTML = `<span class="diff-badge">${diff.status === 'added' ? 'new' : '\u0394'}</span> What changed`;
                    btn.setAttribute('aria-pressed', 'false');
                    titleEl.appendChild(btn);

                    const plainCol = sectionEl.querySelector('.plain-col');
                    let originalHTML = plainCol ? plainCol.innerHTML : '';

                    btn.addEventListener('click', () => {
                        const active = btn.classList.toggle('active');
                        btn.setAttribute('aria-pressed', String(active));
                        if (active && plainCol) {
                            originalHTML = plainCol.innerHTML;
                            plainCol.innerHTML = renderDiffHTML(diff);
                        } else if (plainCol) {
                            plainCol.innerHTML = originalHTML;
                        }
                    });
                }
            }
        } else {
            // First visit — no previous data to compare
        }

        // Store current sections for next comparison
        const toStore = sections.map(s => ({ key: s.key, text: s.text }));
        sessionStorage.setItem(storageKey, JSON.stringify(toStore));
    } catch (e) {
        console.debug('Diff engine error:', e);
    }
});

document.getElementById('refresh-load')?.addEventListener('click', () => {
    document.getElementById('refresh-banner').style.display = 'none';
    // Clear cache so fetchAFD doesn't serve stale data
    sessionStorage.removeItem(`afd-${currentOffice}`);
    fetchAFD(currentOffice);
});
document.getElementById('refresh-dismiss')?.addEventListener('click', () => {
    document.getElementById('refresh-banner').style.display = 'none';
});

startRefreshPolling();

// ─── Offline detection ──────────────────────────────────────────────
window.addEventListener('offline', () => {
    document.getElementById('offline-banner').style.display = '';
});
window.addEventListener('online', () => {
    document.getElementById('offline-banner').style.display = 'none';
});
if (!navigator.onLine) {
    document.getElementById('offline-banner').style.display = '';
}

// ─── Keyboard shortcuts ────────────────────────────────────────────
const kbdOverlay = document.getElementById('kbd-overlay');
let lastKbdFocus = null;
function openKbd() {
    if (!kbdOverlay) return;
    lastKbdFocus = document.activeElement;
    kbdOverlay.classList.add('open');
    document.getElementById('kbd-close')?.focus();
}
function closeKbd() {
    if (!kbdOverlay) return;
    kbdOverlay.classList.remove('open');
    if (lastKbdFocus && lastKbdFocus.focus) lastKbdFocus.focus();
    lastKbdFocus = null;
}
document.getElementById('kbd-hint')?.addEventListener('click', openKbd);
document.getElementById('kbd-close')?.addEventListener('click', closeKbd);
kbdOverlay?.addEventListener('click', (e) => { if (e.target === kbdOverlay) closeKbd(); });
// Trap Tab within the keyboard-shortcuts overlay while it is open
kbdOverlay?.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !kbdOverlay.classList.contains('open')) return;
    const f = kbdOverlay.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const sectionEls = document.querySelectorAll('.forecast-section');
    if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        const scrollY = window.scrollY + 100;
        let target = null;
        const arr = Array.from(sectionEls);
        if (e.key === 'j') {
            target = arr.find(s => s.offsetTop > scrollY);
        } else {
            for (let i = arr.length - 1; i >= 0; i--) {
                if (arr[i].offsetTop < scrollY - 50) { target = arr[i]; break; }
            }
        }
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (e.key === '/') {
        e.preventDefault();
        document.getElementById('office-select')?.focus();
    } else if (e.key === '?') {
        e.preventDefault();
        openKbd();
    } else if (e.key === 'Escape') {
        closeKbd();
    }
});

// ─── Forecast history ───────────────────────────────────────────────
let historyList = [];

async function fetchHistoryList(office) {
    try {
        const res = await fetch(`https://api.weather.gov/products/types/AFD/locations/${office}`, {
            headers: { 'User-Agent': 'Plaincast/1.0 (plaincast.live)' }
        });
        if (!res.ok) return [];
        const data = await res.json();
        return (data['@graph'] || []).slice(0, 10).map(item => ({
            id: item.id,
            url: item['@id'] || `https://api.weather.gov/products/${item.id}`,
            time: new Date(item.issuanceTime)
        }));
    } catch(e) { return []; }
}

function renderHistorySelector(items, currentId) {
    const slot = document.getElementById('editions-slot');
    const line = document.getElementById('editions-line');
    if (!slot) return;
    if (line) line.style.display = items.length ? '' : 'none';
    let container = document.getElementById('history-selector');
    if (!container) {
        container = document.createElement('span');
        container.id = 'history-selector';
        container.style.cssText = 'display:inline-flex;align-items:baseline';
        slot.appendChild(container);
    }
    // Build select with DOM methods (no innerHTML for safety)
    container.textContent = '';
    const sel = document.createElement('select');
    sel.id = 'history-select';
    sel.setAttribute('aria-label', 'Forecast issuance time');
    sel.style.cssText = 'font-family:var(--font-ui);font-size:0.78rem;font-weight:500;border:none;border-bottom:1px solid var(--rule-strong);border-radius:0;padding:0.05rem 0.3rem 0.05rem 0.1rem;background:transparent;color:var(--text-secondary);cursor:pointer';
    const tz = OFFICE_TIMEZONES[currentOffice] || 'America/Los_Angeles';
    if (items.length === 0) {
        const opt = document.createElement('option');
        opt.disabled = true;
        opt.textContent = 'No previous forecasts';
        sel.appendChild(opt);
    } else {
        items.forEach((item, i) => {
            const opt = document.createElement('option');
            opt.value = item.id;
            const label = item.time.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', weekday: 'short', month: 'short', day: 'numeric', timeZone: tz, timeZoneName: 'short' });
            opt.textContent = i === 0 ? 'Latest edition' : `${label} (${timeAgo(item.time)})`;
            if (item.id === currentId) opt.selected = true;
            sel.appendChild(opt);
        });
    }
    sel.addEventListener('change', async () => {
        const item = items.find(i => i.id === sel.value);
        if (!item) return;
        try {
            const res = await fetch(item.url, { headers: { 'User-Agent': 'Plaincast/1.0 (plaincast.live)' } });
            if (!res.ok) throw new Error('Fetch failed');
            const prodData = await res.json();
            // Viewing an older edition: invalidate any in-flight AI writes and skip
            // the diff/changelog. Selecting "Latest" (items[0]) re-enables them.
            fetchGeneration++;
            viewingHistorical = item.id !== items[0].id;
            renderAFD(prodData, currentOffice);
        } catch(e) { console.debug('History fetch failed', e); }
    });
    container.appendChild(sel);
}

// ─── PWA install prompt ──────────────────────────────────────────
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    // Only show after 2nd visit
    const visits = parseInt(localStorage.getItem('plaincast-visits') || '0', 10) + 1;
    localStorage.setItem('plaincast-visits', String(visits));
    if (visits < 2) return;
    // Don't show if already dismissed
    if (localStorage.getItem('plaincast-install-dismissed')) return;
    deferredInstallPrompt = e;
    showInstallBanner();
});

function showInstallBanner() {
    const banner = document.createElement('div');
    banner.className = 'banner';
    banner.id = 'install-banner';
    banner.innerHTML = `<div class="banner-box banner-blue">
        <span>Add Plaincast to your home screen</span>
        <button class="banner-action" id="install-accept">Install</button>
        <button class="banner-dismiss" id="install-dismiss" aria-label="Dismiss">&times;</button>
    </div>`;
    const header = document.querySelector('.header');
    header.parentNode.insertBefore(banner, header.nextSibling);

    document.getElementById('install-accept').addEventListener('click', async () => {
        if (deferredInstallPrompt) {
            deferredInstallPrompt.prompt();
            await deferredInstallPrompt.userChoice;
            deferredInstallPrompt = null;
        }
        banner.remove();
    });
    document.getElementById('install-dismiss').addEventListener('click', () => {
        localStorage.setItem('plaincast-install-dismissed', '1');
        banner.remove();
    });
}

// Track visits for PWA prompt
(() => {
    const visits = parseInt(localStorage.getItem('plaincast-visits') || '0', 10) + 1;
    localStorage.setItem('plaincast-visits', String(visits));
})();
