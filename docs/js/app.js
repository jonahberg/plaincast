// ─── Plaincast App (ES Module) ───────────────────────────────────────
import { GLOSSARY, GLOSSARY_COMPILED } from './glossary.js';
import { OFFICE_TIMEZONES, OFFICE_COORDS, OFFICE_STATES, OFFICE_SENDER, OFFICE_NAMES, SECTION_NAMES } from './offices.js';
import { FULL_ABBREVIATIONS } from './abbreviations.js';
import { computeDiff, renderDiffHTML } from './diff.js';
import { confidenceScore, confidenceWord, buildTimelineEntries } from './timeline.js';

let currentOffice = 'LOX';
let fetchGeneration = 0; // race condition guard for rapid office switching
let issueTimeDate = null; // for auto-updating "X ago"
let issuePrefix = ''; // "Issued 4:02 AM PDT" — stable half of the issue-time line
let viewingHistorical = false; // true while reading an archived edition (skip diff/changelog)
let currentView = 'forecast';  // 'forecast' (the spread) | 'changelog' (the edition ledger)
let currentTranslationObserver = null; // IntersectionObserver for lazy AI translation

// Changelog-view state — declared up here because showChangelogView can run at
// init (deep link) before module evaluation reaches the view code further down.
const TIMELINE_BATCH = 8;      // pairs per page (batch+1 product fetches)
const TIMELINE_LOOKBACK = 40;  // list metadata to page through (~1 week)
let timelineItems = [];        // metadata for every retained issuance
let timelineProducts = [];     // fetched product texts, newest-first
let timelineRendered = 0;      // entries currently in the DOM

// One NWS product-list fetch per render: fetchAFD, fetchHistoryList, and the
// refresh poll all read the same URL — share it briefly instead of refetching.
let afdListCache = { office: null, time: 0, graph: null };
async function fetchAFDListShared(office, { force = false } = {}) {
    if (!force && afdListCache.office === office && afdListCache.graph
        && Date.now() - afdListCache.time < 60 * 1000) {
        return afdListCache.graph;
    }
    const res = await fetch(`https://api.weather.gov/products/types/AFD/locations/${office}`, {
        headers: { 'User-Agent': 'Plaincast/1.0 (plaincast.live)' },
        signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const graph = data['@graph'] || [];
    afdListCache = { office, time: Date.now(), graph };
    return graph;
}

// Fetch live alerts and return map of event name → alert URL
async function fetchAlerts(office) {
    const state = OFFICE_STATES[office];
    if (!state) return {};
    try {
        const res = await fetch(`https://api.weather.gov/alerts/active?area=${state}`, {
            headers: { 'User-Agent': 'Plaincast/1.0 (plaincast.live)' },
            signal: AbortSignal.timeout(10000)
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
                id: p.id || f.id || '',
                event: event || '',
                headline: p.headline || event,
                description: p.description || '',
                instruction: p.instruction || '',
                severity: p.severity || '',
                onset: p.onset || '',
                ends: p.ends || '',        // event end — expires is only the message expiry
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
        // Severe posture: an active Warning of Severe/Extreme severity tightens
        // the auto-refresh poll (forecasts move fast in exactly these hours).
        const severeNow = Object.entries(alertMap).some(([event, list]) =>
            /warning/i.test(event) && list.some(a => /severe|extreme/i.test(a.severity)));
        // Office-guarded: a slow response for the PREVIOUS office must not set
        // the posture for the current one.
        if (office === currentOffice && severeNow !== severeAlertActive) {
            severeAlertActive = severeNow;
            startRefreshPolling();
        }
        return alertMap;
    } catch(e) { console.debug('Alert fetch failed', e); return {}; }
}

let currentAlerts = {};
let severeAlertActive = false; // an active Severe/Extreme Warning for this office

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

    // Remove embedded ".KEY MESSAGE N..." pseudo-headers (real OKX/AKQ, with or
    // without the leading dot) so the regex column doesn't show "KEY MESSAGE 1"
    // label noise (mirrors the "Message N" strip in stripAIArtifacts). Require the
    // trailing "." delimiter so bare "key message 3" in prose is not consumed.
    t = t.replace(/\.?\s*KEY\s+MESSAGE\s+\d+\s*\.{1,3}\s*/gi, '');

    // Remove NWS formatting artifacts
    t = t.replace(/\.{3,}/g, '. ');
    // Collapse runs of spaces (but preserve newlines for paragraph splitting)
    t = t.replace(/[ \t]{2,}/g, ' ');

    // Expand abbreviations using imported FULL_ABBREVIATIONS
    for (const [pat, rep] of FULL_ABBREVIATIONS) {
        t = t.replace(pat, rep);
    }

    // Convert Zulu time references: 18Z → local time (DST-aware). Case-insensitive
    // because live aviation text uses lowercase 'z' ("05-09z", "20z-22z"); the
    // replacement reads only the captured digits, so 'z' vs 'Z' is immaterial.
    t = t.replace(/\b(\d{2,4})Z\b/gi, (_, h) => {
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

    // Phrase weighting lives in timeline.js (shared with the changelog ledger).
    const score = confidenceScore(fullText);
    if (score === null) { container.style.display = 'none'; return; }
    const label = confidenceWord(score);

    // The bar fill is a graphical object (3:1 suffices), but the text label
    // needs 4.5:1 — so the label gets a theme-aware .conf-* class (styles.css)
    // instead of the saturated bar color, which failed contrast in one theme.
    let barColor;
    if (label === 'High') barColor = '#16a34a';
    else if (label === 'Moderate') barColor = '#0F766E';
    else if (label === 'Mixed') barColor = '#d97706';
    else barColor = '#dc2626';

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

// ─── Active Alerts — the Hazard Ledger ──────────────────────────────
// Alert store keyed by index so row markup carries only a data-alert-idx
// (no inline JSON, no XSS). Click delegation looks alerts up here.
const ALERT_DATA = {};
let alertIdx = 0;

// A slow /api/explain-alert response must not fill DOM from a stale render.
// Bumped whenever the alerts section is re-rendered (office switch / live
// re-render), so every in-flight expansion/slab fetch checks this token.
let alertRenderGen = 0;

document.addEventListener('DOMContentLoaded', () => {
    // Inline expansion replaces the old alert modal: clicking a ledger row
    // toggles its hz-body (one open per ledger — close siblings first), and
    // the plain-English brief is built lazily on first open.
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.hz-btn');
        if (!btn) return;
        const row = btn.closest('.hz-row');
        if (!row) return;
        const ledger = row.parentElement;
        const body = row.querySelector('.hz-body');
        const wasOpen = row.classList.contains('open');
        if (ledger) ledger.querySelectorAll('.hz-row.open').forEach(r => {
            r.classList.remove('open');
            r.querySelector('.hz-btn')?.setAttribute('aria-expanded', 'false');
            const bd = r.querySelector('.hz-body');
            if (bd) bd.hidden = true;
        });
        if (!wasOpen) {
            row.classList.add('open');
            btn.setAttribute('aria-expanded', 'true');
            if (body) {
                body.hidden = false;
                if (!body.dataset.built) {
                    body.dataset.built = '1';
                    const data = ALERT_DATA[btn.dataset.alertIdx];
                    if (data) buildAlertExpansion(body, data);
                }
            }
        }
    });

    // Timetable ("On the clock") rows toggle one shared panel below the chart,
    // reusing the same expansion builder as the ledger rows.
    document.addEventListener('click', (e) => {
        const row = e.target.closest('.hz-clock-row');
        if (!row) return;
        const col = row.closest('.clock-col');
        if (!col) return;
        const panel = col.querySelector('.hz-clock-panel');
        const wasOpen = row.getAttribute('aria-expanded') === 'true';
        col.querySelectorAll('.hz-clock-row[aria-expanded="true"]').forEach(r => r.setAttribute('aria-expanded', 'false'));
        if (wasOpen || !panel) {
            if (panel) { panel.hidden = true; panel.textContent = ''; }
            return;
        }
        row.setAttribute('aria-expanded', 'true');
        const kind = (row.className.match(/hz-(warn|watch|adv|stmt)/) || [])[1] || 'adv';
        panel.className = 'hz-clock-panel hz-body hz-' + kind;
        panel.hidden = false;
        panel.textContent = '';
        const data = ALERT_DATA[row.dataset.alertIdx];
        if (data) buildAlertExpansion(panel, data);
    });

    // Escape closes an open ledger row / clock panel (the modal it replaced
    // had this). The kbd overlay's own Escape handling takes precedence.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (document.querySelector('.alert-modal-overlay.open')) return;
        const open = document.querySelector('.hz-row.open');
        if (open) {
            const btn = open.querySelector('.hz-btn');
            open.classList.remove('open');
            btn?.setAttribute('aria-expanded', 'false');
            const bd = open.querySelector('.hz-body');
            if (bd) bd.hidden = true;
            btn?.focus();
            return;
        }
        const openClock = document.querySelector('.hz-clock-row[aria-expanded="true"]');
        if (openClock) {
            openClock.setAttribute('aria-expanded', 'false');
            const panel = openClock.closest('.clock-col')?.querySelector('.hz-clock-panel');
            if (panel) { panel.hidden = true; panel.textContent = ''; }
            openClock.focus();
        }
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

    // View toggle (In plain English / The original / On the clock). The third
    // view is only present on the alerts section when the timetable is built.
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-view]');
        if (!btn) return;
        const section = btn.closest('.forecast-section');
        if (!section) return;
        const columns = section.querySelector('.columns');
        const view = btn.dataset.view;
        // On desktop the clock button is the only one visible — clicking it
        // again returns to the plain view instead of dead-ending in the chart.
        if (view === 'clock' && btn.classList.contains('active')) {
            const plainBtn = section.querySelector('[data-view="plain"]');
            if (plainBtn) { plainBtn.click(); return; }
        }
        // Update button states
        section.querySelectorAll('[data-view]').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        // Update column visibility
        columns.classList.remove('show-plain', 'show-original', 'show-clock');
        columns.classList.add(view === 'plain' ? 'show-plain' : view === 'clock' ? 'show-clock' : 'show-original');
    });
});

// Known NWS alert types — used both to format advisories and to tell a real
// watches/warnings body from an empty "None." (or "AZ...None. CA...None.") one.
const ALERT_PATTERN = /((?:High Wind (?:Watch|Warning)|Wind Advisory|Flood (?:Watch|Warning)|High Surf (?:Advisory|Warning)|Beach Hazards? Statement|Winter Storm (?:Watch|Warning)|Winter Weather Advisory|Small Craft Advisory|Gale Warning|Storm Warning|Red Flag Warning|Fire Weather Watch|Tornado (?:Watch|Warning)|Severe Thunderstorm (?:Watch|Warning)|Flash Flood (?:Watch|Warning)|Blizzard Warning|Ice Storm Warning|Freeze (?:Watch|Warning)|Frost Advisory|Dense Fog Advisory|Heat Advisory|Excessive Heat Warning|Extreme (?:Heat|Cold) Warning|Wind Chill (?:Watch|Warning|Advisory)|Tropical Storm (?:Watch|Warning)|Hurricane (?:Watch|Warning)|Rip Current Statement|Coastal Flood (?:Watch|Warning|Advisory|Statement))[^.]*\.?)/gi;

// The event-name half of ALERT_PATTERN (no trailing sentence tail), used to
// split a matched AFD sentence into "<event name> <the rest>" in degraded mode.
const ALERT_EVENT_PATTERN = /(?:High Wind (?:Watch|Warning)|Wind Advisory|Flood (?:Watch|Warning)|High Surf (?:Advisory|Warning)|Beach Hazards? Statement|Winter Storm (?:Watch|Warning)|Winter Weather Advisory|Small Craft Advisory|Gale Warning|Storm Warning|Red Flag Warning|Fire Weather Watch|Tornado (?:Watch|Warning)|Severe Thunderstorm (?:Watch|Warning)|Flash Flood (?:Watch|Warning)|Blizzard Warning|Ice Storm Warning|Freeze (?:Watch|Warning)|Frost Advisory|Dense Fog Advisory|Heat Advisory|Excessive Heat Warning|Extreme (?:Heat|Cold) Warning|Wind Chill (?:Watch|Warning|Advisory)|Tropical Storm (?:Watch|Warning)|Hurricane (?:Watch|Warning)|Rip Current Statement|Coastal Flood (?:Watch|Warning|Advisory|Statement))/i;

// True only when a watches/warnings section actually names an advisory.
function hasRealAlerts(text) {
    if (!text) return false;
    return !!stripNWSArtifacts(text).match(ALERT_PATTERN);
}

// ─── Pure ledger helpers (extracted into the VM test region) ────────
// Every function below is DOM-free so tests/alert-ledger.test.js can run them
// in a VM. Anything NWS-sourced is escaped by the caller building markup.

// Warning → warn, Watch → watch, Statement → stmt, everything else → advisory.
function classifyAlertKind(eventName) {
    const e = eventName || '';
    if (/warning/i.test(e)) return 'warn';
    if (/watch/i.test(e)) return 'watch';
    if (/statement/i.test(e)) return 'stmt';
    return 'adv';
}

// An ISO instant as a short local clock: 'THU 8:00 PM', or '8:00 PM' when it
// falls on the same local day as `nowMs`. '' for a falsy/unparseable instant.
function formatAlertTime(iso, tz, nowMs) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const zone = tz || 'America/Los_Angeles';
    const dayOf = (ms) => new Intl.DateTimeFormat('en-US',
        { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(ms));
    const time = new Intl.DateTimeFormat('en-US',
        { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(d);
    if (dayOf(d.getTime()) === dayOf(nowMs)) return time;
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(d).toUpperCase();
    return `${wd} ${time}`;
}

// The tabular "until" column. Future onset → 'start → end'; already in effect →
// '→ end'; nothing to show (no ends and no expires) → ''.
function formatUntilCell(alert, tz, nowMs) {
    const end = formatAlertTime(alert.ends || alert.expires || '', tz, nowMs);
    if (!end) return '';
    const onsetMs = alert.onset ? new Date(alert.onset).getTime() : NaN;
    if (!isNaN(onsetMs) && onsetMs > nowMs) {
        return `${formatAlertTime(alert.onset, tz, nowMs)} → ${end}`;
    }
    return `→ ${end}`;
}

// A shortened area line: first zone, then '· N zones' when more than one, plus
// an 'incl. downtown L.A.' flag for the marquee zone.
function areaDigest(areaDesc) {
    const raw = (areaDesc || '').trim();
    if (!raw) return '';
    const zones = raw.split(';').map(z => z.trim()).filter(Boolean);
    if (!zones.length) return '';
    let digest = zones[0];
    if (zones.length > 1) digest += ` · ${zones.length} zones`;
    if (/Downtown Los Angeles/i.test(raw)) digest += ', incl. downtown L.A.';
    return digest;
}

// A long-form clock for prose: 'Thursday 8 PM' (weekday only when it isn't
// today, ':00' dropped) — the slab headline reads as a sentence, not a cell.
function formatAlertTimeProse(iso, tz, nowMs) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const zone = tz || 'America/Los_Angeles';
    const dayOf = (ms) => new Intl.DateTimeFormat('en-US',
        { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(ms));
    const time = new Intl.DateTimeFormat('en-US',
        { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(d).replace(':00', '');
    if (dayOf(d.getTime()) === dayOf(nowMs)) return time;
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long' }).format(d);
    return `${wd} ${time}`;
}

// A display headline templated from the alert's WHAT-line figures (no AI spend).
function slabHeadline(alert, tz, nowMs) {
    const desc = alert.description || '';
    const event = alert.event || 'Alert';
    const end = formatAlertTimeProse(alert.ends || alert.expires || '', tz, nowMs);
    const until = end ? ` until ${end}` : '';
    if (/red flag/i.test(event)) return `Hot, dry, and gusty — critical fire weather${until}.`;
    // Figure templates are gated on the event type: a Winter Storm Warning whose
    // text mentions "gusts up to 40" must not get a wind headline.
    let m;
    if (/heat/i.test(event)) {
        m = desc.match(/temperatures up to (\d{2,3})/i);
        if (m) return `Dangerous heat to ${m[1]}°${until}.`;
    }
    if (/wind|thunderstorm|hurricane|tropical/i.test(event)) {
        m = desc.match(/gusts (?:of |up to )?(\d{2,3})/i);
        if (m) return `Gusts to ${m[1]} mph${until}.`;
    }
    return `${event} in effect${until}.`;
}

// Rank two severe warnings to pick the one that leads the Bulletin Slab:
// Extreme severity beats Severe, then more zones, then the earliest to end.
function pickWorstAlert(alerts) {
    const rank = (s) => /extreme/i.test(s || '') ? 2 : /severe/i.test(s || '') ? 1 : 0;
    const zones = (a) => (a.areaDesc || '').split(';').length;
    const endMs = (a) => new Date(a.ends || a.expires || 0).getTime();
    let best = null;
    for (const a of (alerts || [])) {
        if (!/warning/i.test(a.event || '') || !/severe|extreme/i.test(a.severity || '')) continue;
        if (!best) { best = a; continue; }
        const dr = rank(a.severity) - rank(best.severity);
        if (dr > 0) { best = a; continue; }
        if (dr < 0) continue;
        const dz = zones(a) - zones(best);
        if (dz > 0) { best = a; continue; }
        if (dz < 0) continue;
        if (endMs(a) < endMs(best)) best = a;
    }
    return best;
}

// Geometry for the timetable ("On the clock"): a window from 2h before now to
// the latest end (clamped 12h–48h), 6-hour local ticks, and a clamped bar per
// alert. Times use OFFICE_TIMEZONES[currentOffice].
function clockGeometry(alerts, nowMs) {
    const zone = OFFICE_TIMEZONES[currentOffice] || 'America/Los_Angeles';
    const HOUR = 3600000;
    const startMs = Math.floor((nowMs - 2 * HOUR) / HOUR) * HOUR;
    let maxEnd = startMs;
    for (const a of (alerts || [])) {
        const e = new Date(a.ends || a.expires || 0).getTime();
        if (!isNaN(e) && e > maxEnd) maxEnd = e;
    }
    const endMs = Math.min(startMs + 48 * HOUR, Math.max(startMs + 12 * HOUR, maxEnd));
    const span = endMs - startMs || 1;
    const pct = (ms) => Math.max(0, Math.min(100, ((ms - startMs) / span) * 100));
    // Formatters are hoisted: Intl.DateTimeFormat construction is far costlier
    // than .format(), and the tick loop below runs 12–48 iterations.
    const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hour12: false });
    const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' });
    const localHour = (ms) => parseInt(hourFmt.format(new Date(ms)), 10) % 24;
    const weekday = (ms) => weekdayFmt.format(new Date(ms)).toUpperCase();

    const ticks = [];
    let prevDay = null;
    for (let ms = startMs; ms <= endMs + 1; ms += HOUR) {
        const h = localHour(ms);
        if (h % 6 !== 0) continue;
        const label = h === 0 ? 'MID' : h === 6 ? '6 AM' : h === 12 ? 'NOON' : '6 PM';
        const day = weekday(ms);
        const tick = { pct: +pct(ms).toFixed(2), label };
        if (prevDay !== null && day !== prevDay) tick.day = day;
        ticks.push(tick);
        prevDay = day;
    }

    const rows = (alerts || []).map((a) => {
        const onsetMs = a.onset ? new Date(a.onset).getTime() : NaN;
        const barStart = !isNaN(onsetMs) ? onsetMs : startMs;
        const be = new Date(a.ends || a.expires || 0).getTime();
        const barEnd = !isNaN(be) ? be : endMs;
        const leftPct = pct(barStart);
        const widthPct = Math.max(0, pct(barEnd) - leftPct);
        return { leftPct: +leftPct.toFixed(2), widthPct: +widthPct.toFixed(2), upcoming: !isNaN(onsetMs) && onsetMs > nowMs };
    });

    return { startMs, endMs, nowPct: +pct(nowMs).toFixed(2), ticks, rows };
}

// One aligned ledger row per row-descriptor. Live rows are expandable buttons
// carrying a data-alert-idx; degraded rows (built from AFD text before the live
// fetch lands) are static divs. All NWS-sourced strings are escaped here.
function ledgerRowHTML(kind, event, area, until, idx) {
    const lead = idx == null
        ? '<div class="hz-line">'
        : `<button class="hz-btn" data-alert-idx="${idx}" aria-expanded="false">`;
    const tail = idx == null ? '</div>' : '</button>';
    const body = idx == null ? '' : '<div class="hz-body" hidden></div>';
    return `<div class="hz-row hz-${kind}">${lead}`
        + '<span class="hz-mark" aria-hidden="true"></span>'
        + `<span class="hz-ev">${escapeHTML(event)}</span>`
        + `<span class="hz-area">${escapeHTML(area)}</span>`
        + `<span class="hz-until">${escapeHTML(until)}</span>`
        + `${tail}${body}</div>`;
}

const HZ_ORDER = { warn: 0, watch: 1, adv: 2, stmt: 3 };

function formatAlerts(text, alertMap) {
    const tz = OFFICE_TIMEZONES[currentOffice] || 'America/Los_Angeles';
    const nowMs = Date.now();
    const mapEntries = alertMap ? Object.entries(alertMap) : [];

    // Live data: one row per alert entry (not per event), ordered
    // warn → watch → adv → stmt and stable within a kind.
    if (mapEntries.length) {
        const list = [];
        for (const [event, entries] of mapEntries) {
            for (const ad of entries) list.push({ ad, event, kind: classifyAlertKind(event) });
        }
        list.sort((a, b) => HZ_ORDER[a.kind] - HZ_ORDER[b.kind]);
        const rows = list.map(({ ad, event, kind }) => {
            const idx = alertIdx++;
            ALERT_DATA[idx] = ad;
            const until = formatUntilCell(ad, tz, nowMs);
            return ledgerRowHTML(kind, event, areaDigest(ad.areaDesc), until, idx);
        });
        return `<div class="hz-ledger">${rows.join('')}</div>`;
    }

    // Degraded / first-paint: no live data. Render static rows from the matched
    // AFD sentences, or the plain body ("None.") when nothing matches. The strip
    // + big-alternation match run only here — the live path never uses them.
    const t = stripNWSArtifacts(text);
    const matches = t.match(ALERT_PATTERN);
    if (!matches || matches.length === 0) {
        return `<p>${escapeHTML(t)}</p>`;
    }
    const rows = matches.map((m) => {
        let item = m.trim().replace(/\.\s*$/, '').replace(/^\.\s*/, '').trim();
        item = item.charAt(0).toUpperCase() + item.slice(1);
        const kind = classifyAlertKind(item);
        const ev = item.match(ALERT_EVENT_PATTERN);
        const event = ev ? ev[0] : item;
        const rest = ev ? item.slice(ev.index + ev[0].length).replace(/^[\s,:]+/, '').trim() : '';
        return ledgerRowHTML(kind, event, rest, '', null);
    });
    return `<div class="hz-ledger">${rows.join('')}</div>`;
}

// The alert's window as a tooltip/label: 'Now → THU 8:00 PM' when in effect,
// or 'start → end' when it hasn't started yet.
function alertWindowLabel(data, tz, nowMs) {
    const end = formatAlertTime(data.ends || data.expires || '', tz, nowMs);
    const onsetMs = data.onset ? new Date(data.onset).getTime() : NaN;
    if (!isNaN(onsetMs) && onsetMs > nowMs) return `${formatAlertTime(data.onset, tz, nowMs)} → ${end}`;
    return `Now → ${end}`;
}

// The facts + "what to do" + verbatim block (no plain lead — that is prepended
// lazily). All NWS-sourced strings escaped. Pure (returns HTML string), so it
// lives in the VM test region for escaping tests.
function alertFactsHTML(data) {
    const tz = OFFICE_TIMEZONES[currentOffice] || 'America/Los_Angeles';
    const nowMs = Date.now();
    const facts = [];
    if (data.severity) facts.push(escapeHTML(data.severity));
    const zoneCount = data.areaDesc ? data.areaDesc.split(';').filter(z => z.trim()).length : 0;
    if (zoneCount) facts.push(`${zoneCount} zone${zoneCount === 1 ? '' : 's'}`);
    const until = formatUntilCell(data, tz, nowMs);
    if (until) facts.push(escapeHTML(until));

    let html = '';
    if (facts.length) html += `<ul class="hz-facts">${facts.map(f => `<li>${f}</li>`).join('')}</ul>`;
    if (data.instruction) {
        const paras = data.instruction.split(/\n\s*\n/).map(p => escapeHTML(p.replace(/\s+/g, ' ').trim())).filter(Boolean);
        if (paras.length) html += `<div class="hz-do"><b>What to do</b>${paras.map(p => `<p>${p}</p>`).join('')}</div>`;
    }
    if (data.description) {
        html += `<details class="hz-verbatim"><summary>The official text · verbatim</summary>`
            + `<pre>${escapeHTML(data.description)}</pre></details>`;
    }
    return html;
}

// ─── AI Translation ─────────────────────────────────────────────────
const aiCache = new Map();
const AI_CACHE_MAX = 100;

// Raw model output → display HTML (markdown bold + paragraphs), shared by the
// per-issuance GET path and the per-section POST fallback.
function formatTranslationHTML(raw) {
    const safe = stripAIArtifacts(raw)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return safe
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .split(/\n\s*\n+/)
        .filter(b => b.trim())
        .map(b => `<p>${b.trim().replace(/\n/g, ' ')}</p>`)
        .join('');
}

// ─── Alert ledger interactions (DOM side of the Hazard Ledger) ───────
// The pure row/geometry/markup helpers live in the VM test region above; these
// build and mutate DOM, so they stay out of it.

// The "On the clock" timetable only earns its place when enough alerts have
// real time windows to compare.
const CLOCK_MIN_TIMED_ALERTS = 3;

// Lazy plain-English lead via /api/explain-alert (unforgeable input: server
// fetches by id). Soft-fails, and drops itself if a re-render supersedes it.
function lazyExplain(host, data, place) {
    if (!data.id) return;
    const gen = alertRenderGen;
    const lead = document.createElement('div');
    lead.className = 'hz-plain';
    lead.innerHTML = '<div class="ai-loading-label"><span class="ai-loading"></span> Summarizing…</div>';
    if (place === 'prepend') host.insertBefore(lead, host.firstChild);
    else host.appendChild(lead);
    fetch(`/api/explain-alert?id=${encodeURIComponent(data.id)}`)
        .then(r => (r.ok ? r.json() : null))
        .then(d => {
            if (gen !== alertRenderGen) return;
            if (d && d.explanation) {
                lead.innerHTML = '<div class="hz-plain-label">In plain English · simplified by AI</div>'
                    + formatTranslationHTML(d.explanation);
            } else {
                lead.remove();
            }
        })
        .catch(() => { if (gen === alertRenderGen) lead.remove(); });
}

// Fill a row/clock expansion body: facts block + lazy plain-English lead above.
function buildAlertExpansion(host, data) {
    host.innerHTML = alertFactsHTML(data);
    lazyExplain(host, data, 'prepend');
}

// The Bulletin Slab: promote the worst severe warning to a headline above the
// ledger. The same alert keeps its ordinary row below (ledger stays complete).
function renderAlertSlab(plainCol, ordered) {
    const worst = pickWorstAlert(ordered.map(o => o.data));
    if (!worst) return;
    const entry = ordered.find(o => o.data === worst) || { kind: classifyAlertKind(worst.event) };
    const tz = OFFICE_TIMEZONES[currentOffice] || 'America/Los_Angeles';
    const nowMs = Date.now();
    const slab = document.createElement('div');
    slab.className = `hz-slab hz-${entry.kind}`;
    slab.innerHTML = `<p class="hz-slab-eyebrow"><span class="hz-mark" aria-hidden="true"></span>`
        + `${escapeHTML(worst.event || 'Alert')} <span class="hz-sep">·</span> ${escapeHTML(alertWindowLabel(worst, tz, nowMs))}</p>`
        + `<h3 class="hz-slab-head">${escapeHTML(slabHeadline(worst, tz, nowMs))}</h3>`
        + `<div class="hz-slab-plain"></div>`;
    plainCol.insertBefore(slab, plainCol.firstChild);
    lazyExplain(slab.querySelector('.hz-slab-plain'), worst, 'append');
}

// The timetable chart. `ordered` rows carry {idx, kind, data} in ledger order,
// so clock rows reuse the same ALERT_DATA index for their expansion.
function renderAlertClock(host, ordered) {
    const tz = OFFICE_TIMEZONES[currentOffice] || 'America/Los_Angeles';
    const nowMs = Date.now();
    const geo = clockGeometry(ordered.map(o => o.data), nowMs);
    // Must match the label column in .hz-clock-row grid-template-columns and
    // .hz-clock-axis margin-left (styles.css) — the three stay in sync by hand.
    const LABEL = '13.5rem';
    const trackLeft = (p) => `calc(${LABEL} + (100% - ${LABEL}) * ${(p / 100).toFixed(4)})`;
    const nowLabel = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(nowMs));

    const axis = '<div class="hz-clock-axis">'
        + geo.ticks.map(t => `<span class="hz-clock-tick" style="left:${t.pct}%">`
            + `${t.day ? `<span class="hz-clock-day">${escapeHTML(t.day)}</span>` : ''}${t.label}</span>`).join('')
        + '</div>';

    let grid = '<div class="hz-clock-grid">';
    grid += geo.ticks.map(t => `<div class="hz-clock-vline" style="left:${trackLeft(t.pct)}"></div>`).join('');
    grid += `<div class="hz-clock-now" style="left:${trackLeft(geo.nowPct)}"><i>NOW · ${escapeHTML(nowLabel)}</i></div>`;
    grid += ordered.map((o, i) => {
        const r = geo.rows[i];
        const zoneCount = o.data.areaDesc ? o.data.areaDesc.split(';').filter(z => z.trim()).length : 0;
        return `<button class="hz-clock-row hz-${o.kind}" data-alert-idx="${o.idx}" aria-expanded="false">`
            + `<span class="hz-clock-lab"><span class="hz-mark" aria-hidden="true"></span>`
            + `<span class="t">${escapeHTML(o.data.event || '')}</span>`
            + `${zoneCount > 1 ? `<span class="z">×${zoneCount}</span>` : ''}</span>`
            + `<span class="hz-clock-track"><span class="hz-clock-bar${r.upcoming ? ' upcoming' : ''}" `
            + `style="left:${r.leftPct}%;width:${r.widthPct}%" data-tip="${escapeAttr(alertWindowLabel(o.data, tz, nowMs))}"></span></span>`
            + `</button>`;
    }).join('');
    grid += '</div>';

    host.innerHTML = `<div class="hz-clock-scroll"><div class="hz-clock-chart">${axis}${grid}</div></div>`
        + '<div class="hz-clock-panel" hidden></div>';
}

// Add the "On the clock" toggle + timetable column to the alerts section. The
// clock column is PREPENDED (first child) so the mobile show-plain rule still
// targets the original column (see styles.css note).
function addClockView(sectionEl, ordered) {
    const toggleBar = sectionEl.querySelector('.ai-toggle');
    const columns = sectionEl.querySelector('.columns');
    if (!toggleBar || !columns) return;
    // has-clock surfaces the toggle on desktop too (clock button only there —
    // plain/original stay a mobile-only choice since desktop shows both columns).
    toggleBar.classList.add('has-clock');
    if (!toggleBar.querySelector('[data-view="clock"]')) {
        const btn = document.createElement('button');
        btn.className = 'ai-toggle-btn';
        btn.dataset.view = 'clock';
        btn.setAttribute('aria-pressed', 'false');
        btn.textContent = 'On the clock';
        toggleBar.appendChild(btn);
    }
    let clockCol = columns.querySelector('.clock-col');
    if (!clockCol) {
        clockCol = document.createElement('div');
        clockCol.className = 'clock-col';
        columns.insertBefore(clockCol, columns.firstChild);
    }
    renderAlertClock(clockCol, ordered);
}

// Whole-issuance translation, one GET per (office, productId). The server
// translates every section once and the CDN serves everyone after — see
// api/translate-issuance.js. Resolves to a {sectionKey: rawText} map or null.
let issuanceMapKey = '';
let issuanceMapPromise = null;

function getIssuanceTranslations(office, productId) {
    const key = `${office}|${productId}`;
    if (issuanceMapKey !== key) {
        issuanceMapKey = key;
        issuanceMapPromise = fetch(`/api/translate-issuance?office=${encodeURIComponent(office)}&id=${encodeURIComponent(productId)}`)
            .then(r => (r.ok ? r.json() : null))
            .then(d => (d && d.sections && typeof d.sections === 'object' ? d.sections : null))
            .catch(() => null);
    }
    return issuanceMapPromise;
}

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
    const html = formatTranslationHTML(data.translation);
    if (aiCache.size >= AI_CACHE_MAX) {
        aiCache.delete(aiCache.keys().next().value);
    }
    aiCache.set(key, html);
    return html;
}

// ─── Scroll-spy: the printed running head ────────────────────────
// styles.css has styled .section-nav a[aria-current="true"] (rubric underline
// sweep) since the Dispatch redesign — this is the JS that was never wired.
let sectionSpyObserver = null;
function setupScrollSpy() {
    if (sectionSpyObserver) { sectionSpyObserver.disconnect(); sectionSpyObserver = null; }
    if (!('IntersectionObserver' in window)) return;
    const navEl = document.getElementById('section-nav');
    if (!navEl) return;
    const links = new Map();
    navEl.querySelectorAll('a[href^="#section-"]').forEach(a => {
        links.set(a.getAttribute('href').slice(1), a);
    });
    if (!links.size) return;
    sectionSpyObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            navEl.querySelectorAll('a[aria-current]').forEach(a => a.removeAttribute('aria-current'));
            links.get(entry.target.id)?.setAttribute('aria-current', 'true');
        }
    }, { rootMargin: '-15% 0px -75% 0px' });
    for (const id of links.keys()) {
        const el = document.getElementById(id);
        if (el) sectionSpyObserver.observe(el);
    }
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
            // Prefer the issuance-wide translation (one CDN-cached GET covers
            // every section); fall back to the per-section POST if this key is
            // missing from the map or the GET failed entirely.
            let html = null;
            if (productContext.productId) {
                const map = await getIssuanceTranslations(currentOffice, productContext.productId);
                if (renderGen !== fetchGeneration) return;
                if (map && typeof map[s.key] === 'string' && map[s.key]) {
                    html = formatTranslationHTML(map[s.key]);
                }
            }
            if (!html) {
                html = await fetchAITranslation(s.text, s.key, currentOffice, productContext.issuanceTime);
            }
            if (renderGen !== fetchGeneration) return;

            // Crossfade: lock height, fade out, swap content, fade in
            const currentHeight = plainCol.offsetHeight;
            plainCol.style.minHeight = currentHeight + 'px';
            plainCol.style.opacity = '0';

            setTimeout(() => {
                if (renderGen !== fetchGeneration) return;
                plainCol.innerHTML = html;
                plainCol.style.opacity = '1';
                // Swap in the AI credit only once its translation is actually on screen —
                // the regex gloss shown before (or instead, on AI failure) isn't its work.
                const colLabel = el.querySelector('.col-label');
                if (colLabel) colLabel.innerHTML = 'In plain English · simplified by AI';
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

    setupScrollSpy();

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
                // The cache may hide a fresh issuance (the ledger and editions
                // dropdown would show a newer edition than the spread): check
                // the list in the background and offer the refresh banner.
                fetchAFDListShared(office).then(graph => {
                    if (thisGen !== fetchGeneration) return;
                    const latest = graph[0];
                    if (latest && latest.id && latest.id !== prodData.id) {
                        const banner = document.getElementById('refresh-banner');
                        if (banner) banner.style.display = '';
                    }
                }).catch(() => {});
                return;
            }
        } catch(e) { console.debug('Cache parse error, refetching', e); }
    }

    try {
        const graph = await fetchAFDListShared(office);
        if (thisGen !== fetchGeneration) return; // stale request
        const latest = graph[0];
        if (!latest) throw new Error('No AFD found for this office');

        const prodUrl = latest['@id'] || `https://api.weather.gov/products/${latest.id}`;
        const prodRes = await fetch(prodUrl, {
            headers: { 'User-Agent': 'Plaincast/1.0 (plaincast.live)' },
            signal: AbortSignal.timeout(10000)
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
    // Reset the alert store on EVERY render path — edition/history navigation
    // enters here without fetchAFD, and without this the store accumulates
    // stale entries (and a slow explain-alert fetch could fill dead DOM).
    alertIdx = 0;
    alertRenderGen++;
    for (const k of Object.keys(ALERT_DATA)) delete ALERT_DATA[k];

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
    render(orderedSections, { issuanceTime: prodData.issuanceTime, productId: prodData.id });

    // Then fetch alerts and re-render the alerts section with links.
    // thisAlertGen guards the SAME-office race too: rapid edition switching
    // re-enters renderAFD (which bumps alertRenderGen) without changing
    // currentOffice, and a slower earlier fetch must not clobber the newer
    // render with stale alert data.
    const thisAlertGen = alertRenderGen;
    fetchAlerts(office).then(alertMap => {
        if (office !== currentOffice) return; // user switched offices mid-fetch — don't clobber
        if (thisAlertGen !== alertRenderGen) return; // a newer render superseded this fetch
        currentAlerts = alertMap;
        // Re-render just the alerts section with the live Hazard Ledger, then
        // promote severe posture to a Bulletin Slab and, when enough alerts are
        // timed, offer the "On the clock" timetable view.
        if (Object.keys(alertMap).length > 0) {
            const alertSection = orderedSections.find(s => s.key === 'Active Alerts');
            if (alertSection) {
                const el = document.getElementById('section-active-alerts');
                if (el) {
                    el.style.display = ''; // un-hide if it was a "None." body now superseded by live alerts
                    const plainCol = el.querySelector('.plain-col');
                    if (plainCol) {
                        alertRenderGen++; // supersede any in-flight expansion/slab fetch
                        plainCol.innerHTML = formatAlerts(alertSection.text, alertMap);
                        // Ledger-order list with each row's ALERT_DATA index, so
                        // the slab and clock reuse the exact same entries.
                        const ordered = Array.from(plainCol.querySelectorAll('.hz-btn[data-alert-idx]')).map(b => ({
                            idx: b.dataset.alertIdx,
                            kind: (b.closest('.hz-row').className.match(/hz-(warn|watch|adv|stmt)/) || [])[1] || 'adv',
                            data: ALERT_DATA[b.dataset.alertIdx],
                        }));
                        renderAlertSlab(plainCol, ordered);
                        const timed = ordered.filter(o => o.data && o.data.onset && (o.data.ends || o.data.expires));
                        if (timed.length >= CLOCK_MIN_TIMED_ALERTS) addClockView(el, ordered);
                    }
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
        // Canonical URL form is the path (/o/LOT/), not ?office= — one URL per
        // office keeps shares, SEO equity, and the baked pages in agreement,
        // and never produces the contradictory /o/OKX/?office=LOT.
        const url = new URL(window.location);
        url.pathname = `/o/${encodeURIComponent(office)}/`;
        url.searchParams.delete('office');
        url.searchParams.delete('edition'); // a new office always opens on its latest edition
        history.pushState({}, '', url);
        renderedRoute = currentRoute();
    }
    try { localStorage.setItem('plaincast-office', office); } catch(e) { /* quota */ }
    updateTitle(office);
    // The baked footer index highlights the page's office; keep it honest
    // when navigation happens in-app.
    document.querySelectorAll('.office-index-list a[aria-current]').forEach(a => a.removeAttribute('aria-current'));
    document.querySelector(`.office-index-list a[href="/o/${office}/"]`)?.setAttribute('aria-current', 'page');
    // Update RSS auto-discovery link
    const rssLink = document.getElementById('rss-link');
    if (rssLink) rssLink.href = `/api/feed?office=${office}`;
    document.getElementById('rss-colophon-link')?.setAttribute('href', `/api/feed?office=${office}`);
    // Switching offices keeps you in whichever view you're reading
    if (currentView === 'changelog') showChangelogView(office, false);
    else fetchAFD(office);
}

officeSelect.addEventListener('change', () => selectOffice(officeSelect.value));

// Open a specific archived edition by product id (?edition= deep links).
// Falls back to the latest forecast if the id has aged out of NWS retention.
async function loadEdition(office, editionId) {
    currentOffice = office;
    const thisGen = ++fetchGeneration; // stale responses must never clobber a newer render
    try {
        const items = await fetchHistoryList(office, TIMELINE_LOOKBACK);
        if (thisGen !== fetchGeneration) return;
        timelineItems = items;
        const item = items.find(i => i.id === editionId);
        if (!item) {
            // Aged out of NWS retention — a durable snapshot (if the server has
            // one) can still reconstruct the edition, so old shares never rot.
            const snap = await fetch(`/api/translate-issuance?office=${encodeURIComponent(office)}&id=${encodeURIComponent(editionId)}`)
                .then(r => (r.ok ? r.json() : null))
                .catch(() => null);
            if (thisGen !== fetchGeneration) return;
            if (snap && snap.productText) {
                viewingHistorical = true;
                renderAFD({ id: editionId, productText: snap.productText, issuanceTime: snap.issuanceTime }, office);
                return;
            }
            const url = new URL(window.location);
            url.searchParams.delete('edition');
            history.replaceState({}, '', url);
            renderedRoute = currentRoute();
            fetchAFD(office);
            return;
        }
        const res = await fetch(item.url, { headers: { 'User-Agent': 'Plaincast/1.0 (plaincast.live)' }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error('Fetch failed');
        const prodData = await res.json();
        if (thisGen !== fetchGeneration) return;
        viewingHistorical = item.id !== items[0]?.id;
        renderAFD(prodData, office);
    } catch (e) {
        console.debug('Edition deep link failed', e);
        if (thisGen === fetchGeneration) fetchAFD(office);
    }
}

// Handle browser back/forward. Hash-only navigation (clicking a #section-…
// anchor in the contents nav) also fires popstate — that must NOT re-render
// the spread, so no-op when the meaningful route is unchanged.
function currentRoute() {
    const params = new URLSearchParams(window.location.search);
    const pathM = window.location.pathname.match(/\/o\/([A-Za-z]{3})\/?$/);
    return {
        office: params.get('office')?.toUpperCase() || pathM?.[1]?.toUpperCase() || null,
        view: params.get('view') || null,
        edition: params.get('edition') || null,
    };
}
let renderedRoute = currentRoute();

window.addEventListener('popstate', () => {
    const route = currentRoute();
    if (route.office === renderedRoute.office
        && route.view === renderedRoute.view
        && route.edition === renderedRoute.edition) {
        return; // fragment-only navigation
    }
    renderedRoute = route;
    const target = (route.office && officeSelect.querySelector(`option[value="${route.office}"]`)) ? route.office : currentOffice;
    officeSelect.value = target;
    if (route.view === 'changelog') {
        showChangelogView(target, false);
        return;
    }
    currentView = 'forecast';
    document.body.classList.remove('view-changelog');
    if (route.edition) {
        updateTitle(target);
        loadEdition(target, route.edition);
    } else {
        selectOffice(target, false);
    }
});

// Restore a #section-… anchor once, after the first async render lands —
// static HTML can't scroll to content that doesn't exist yet.
let initialHashHandled = false;
afterRender.push(() => {
    if (initialHashHandled) return;
    initialHashHandled = true;
    const h = window.location.hash;
    if (h && /^#section-[\w-]+$/.test(h)) {
        document.querySelector(h)?.scrollIntoView({ block: 'start' });
    }
});

// Load initial office. Deep links may land on the changelog ledger or a
// specific archived edition; both resolve before the default spread.
updateTitle(initialOffice);
// The baked RSS links say office=LOX; a returning visitor's saved office may
// differ, and the initial load goes through fetchAFD, not selectOffice.
document.getElementById('rss-link')?.setAttribute('href', `/api/feed?office=${initialOffice}`);
document.getElementById('rss-colophon-link')?.setAttribute('href', `/api/feed?office=${initialOffice}`);
if (urlParams.get('view') === 'changelog') {
    showChangelogView(initialOffice, false);
} else if (urlParams.get('edition')) {
    loadEdition(initialOffice, urlParams.get('edition'));
} else {
    fetchAFD(initialOffice);
}

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
        toggle.setAttribute('aria-pressed', String(isDark()));
        // Keep the browser-chrome tint on the current paper color — the baked
        // meta was a pre-redesign teal that matched nothing in the palette.
        document.querySelector('meta[name="theme-color"]')
            ?.setAttribute('content', isDark() ? '#100f0c' : '#f7f3ea');
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
    // Severe posture: 2-minute checks while a Severe/Extreme Warning is live
    // (forecasters re-issue rapidly in those hours); a calm 10 otherwise.
    const interval = severeAlertActive ? 2 * 60 * 1000 : 10 * 60 * 1000;
    refreshTimer = setInterval(async () => {
        if (document.hidden) return;
        try {
            const graph = await fetchAFDListShared(currentOffice, { force: true });
            // Severe posture must also stand down on its own: re-check alerts
            // so an expired Warning returns the poll to its calm cadence.
            if (severeAlertActive) fetchAlerts(currentOffice).catch(() => {});
            const latest = graph[0];
            if (latest && lastProductId && latest.id !== lastProductId) {
                document.getElementById('refresh-banner').style.display = '';
            }
        } catch(e) { /* silent retry next cycle */ }
    }, interval);
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
    el.innerHTML = `<span class="changelog-label">Since ${escapeHTML(sinceText(since))}</span> ${escapeHTML(text)}`
        + ` <a class="changelog-view-link" href="/o/${encodeURIComponent(currentOffice)}/?view=changelog">See every revision →</a>`;
    el.querySelector('.changelog-view-link')?.addEventListener('click', (e) => {
        e.preventDefault();
        showChangelogView(currentOffice);
    });
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
    if (currentView === 'changelog') leaveChangelogChrome();
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
        if (target) {
            const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
        }
    } else if (e.key === '/') {
        e.preventDefault();
        document.getElementById('office-select')?.focus();
    } else if (e.key === '?') {
        e.preventDefault();
        openKbd();
    } else if (e.key === 'Escape') {
        closeKbd();
        // WCAG 1.4.13: hover/focus tooltips must be dismissible without moving
        // the pointer or focus.
        document.querySelectorAll('.jargon.tip-open').forEach(el => el.classList.remove('tip-open'));
        if (document.activeElement?.closest?.('.jargon')) document.activeElement.blur();
    }
});

// ─── Forecast history ───────────────────────────────────────────────
let historyList = [];

async function fetchHistoryList(office, limit = 10) {
    try {
        const graph = await fetchAFDListShared(office);
        return graph.slice(0, limit).map(item => ({
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
        // An edition older than this window (deep link near the retention
        // horizon) must not masquerade as "Latest edition".
        const inWindow = items.some(i => i.id === currentId);
        if (!inWindow && viewingHistorical) {
            const opt = document.createElement('option');
            opt.disabled = true;
            opt.selected = true;
            opt.textContent = 'Archived edition';
            sel.appendChild(opt);
        }
        items.forEach((item, i) => {
            const opt = document.createElement('option');
            opt.value = item.id;
            const label = item.time.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', weekday: 'short', month: 'short', day: 'numeric', timeZone: tz, timeZoneName: 'short' });
            opt.textContent = i === 0 ? 'Latest edition' : `${label} (${timeAgo(item.time)})`;
            if (inWindow && item.id === currentId) opt.selected = true;
            sel.appendChild(opt);
        });
    }
    sel.addEventListener('change', async () => {
        const item = items.find(i => i.id === sel.value);
        if (!item) return;
        try {
            const res = await fetch(item.url, { headers: { 'User-Agent': 'Plaincast/1.0 (plaincast.live)' }, signal: AbortSignal.timeout(10000) });
            if (!res.ok) throw new Error('Fetch failed');
            const prodData = await res.json();
            // Viewing an older edition: invalidate any in-flight AI writes and skip
            // the diff/changelog. Selecting "Latest" (items[0]) re-enables them.
            fetchGeneration++;
            viewingHistorical = item.id !== items[0].id;
            // Every edition is a permalink — the address bar always names what
            // you're reading, so Share and copy-link just work.
            const url = new URL(window.location);
            if (viewingHistorical) url.searchParams.set('edition', item.id);
            else url.searchParams.delete('edition');
            history.pushState({}, '', url);
        renderedRoute = currentRoute();
            renderAFD(prodData, currentOffice);
        } catch(e) { console.debug('History fetch failed', e); }
    });
    container.appendChild(sel);

    // The ledger's front door lives beside the editions control in the colophon.
    // (`line` is the #editions-line node declared at the top of this function.)
    const existingLink = document.getElementById('colophon-changelog-link');
    if (existingLink) {
        existingLink.href = `/o/${encodeURIComponent(currentOffice)}/?view=changelog`;
    }
    if (line && !existingLink) {
        const sep = document.createTextNode(' · ');
        const a = document.createElement('a');
        a.id = 'colophon-changelog-link';
        a.href = `/o/${encodeURIComponent(currentOffice)}/?view=changelog`;
        a.textContent = 'Changelog';
        a.addEventListener('click', (e) => {
            e.preventDefault();
            showChangelogView(currentOffice);
            window.scrollTo(0, 0);
        });
        line.appendChild(sep);
        line.appendChild(a);
    }
}

// ─── Changelog view — the edition ledger ────────────────────────────
// Reverse-chronological record of every retained issuance: what each revision
// changed, in the forecaster's own confidence language, with the full text
// diff one fold away. Works for first-time visitors — nothing here depends on
// sessionStorage having seen a previous edition. (State consts live at the top
// of the file: deep links call showChangelogView during init.)

async function fetchTimelineProducts(items) {
    // POSITIONAL results — a failed fetch stays as null so pagination indices
    // into timelineItems never drift (a dropped slot once produced a
    // duplicated entry that "diffed" an issuance against itself).
    return Promise.all(items.map(async (item) => {
        try {
            const res = await fetch(item.url, { headers: { 'User-Agent': 'Plaincast/1.0 (plaincast.live)' }, signal: AbortSignal.timeout(10000) });
            if (!res.ok) return null;
            const prod = await res.json();
            return typeof prod.productText === 'string'
                ? { id: item.id, time: item.time, text: prod.productText }
                : null;
        } catch (e) { return null; }
    }));
}

function timelineDateline(time, tz) {
    return {
        date: time.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz }),
        clock: time.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }),
        edition: editionName(localHour(time, tz)),
    };
}

function confidenceSentence(conf) {
    if (!conf || !conf.word) return '';
    if (conf.direction === 'rising') return `Confidence rising — now ${conf.word.toLowerCase()}.`;
    if (conf.direction === 'falling') return `Confidence slipping — now ${conf.word.toLowerCase()}.`;
    if (conf.direction === 'steady') return `Confidence ${conf.word.toLowerCase()}, holding steady.`;
    return `Confidence ${conf.word.toLowerCase()}.`;
}

function timelineEntryHTML(entry, tz) {
    const dl = timelineDateline(entry.time, tz);
    const revised = entry.changedKeys.length
        ? `Revised: ${entry.changedKeys.map(escapeHTML).join(', ')}.`
        : 'No substantive revisions.';
    const conf = confidenceSentence(entry.confidence);
    const byline = entry.forecaster ? `<span class="timeline-byline">— ${escapeHTML(entry.forecaster)}</span>` : '';
    const summary = entry.changedKeys.length
        ? `<p class="timeline-summary pending" data-id="${escapeAttr(entry.id)}"><span class="ai-loading"></span></p>`
        : `<p class="timeline-summary timeline-summary-quiet">The forecast carried forward unchanged.</p>`;
    const diff = entry.changed.length ? `
        <details class="timeline-diff">
            <summary>Compare the text</summary>
            ${entry.changed.map(d => `
            <div class="timeline-diff-section">
                <h3 class="timeline-diff-title">${escapeHTML(d.key)}</h3>
                ${renderDiffHTML(d)}
            </div>`).join('')}
        </details>` : '';
    return `
    <article class="timeline-entry" data-entry-id="${escapeAttr(entry.id)}">
        <h3 class="timeline-dateline">
            <span class="timeline-date">${escapeHTML(dl.date)}</span>
            <span class="timeline-sep" aria-hidden="true">·</span>
            <span class="timeline-clock">${escapeHTML(dl.clock)}</span>
            <span class="timeline-sep" aria-hidden="true">·</span>
            <span class="timeline-edition">${escapeHTML(dl.edition)} Edition</span>
        </h3>
        ${summary}
        <p class="timeline-meta">${revised} <span class="timeline-confidence">${conf}</span> ${byline}</p>
        ${diff}
        <p class="timeline-read"><a href="/o/${encodeURIComponent(currentOffice)}/?edition=${encodeURIComponent(entry.id)}" data-edition-id="${escapeAttr(entry.id)}">Read this edition</a></p>
    </article>`;
}

async function fillTimelineSummary(office, el) {
    const id = el.dataset.id;
    if (!id) return;
    delete el.dataset.id;
    try {
        const res = await fetch(`/api/changelog?office=${encodeURIComponent(office)}&id=${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error('changelog fetch failed');
        const data = await res.json();
        el.classList.remove('pending');
        if (data && data.changelog) {
            el.textContent = data.changelog;
        } else if (data && data.transient) {
            el.remove(); // a model/NWS failure is not a "nothing changed" verdict
        } else {
            el.textContent = 'Minor refinements — timing and wording, no headline change.';
            el.classList.add('timeline-summary-quiet');
        }
    } catch (e) {
        el.remove(); // the entry still carries the revised-sections line + diff
    }
}

function observeTimelineSummaries(office, root) {
    const els = Array.from(root.querySelectorAll('.timeline-summary[data-id]'));
    if (!('IntersectionObserver' in window)) {
        els.forEach(el => fillTimelineSummary(office, el));
        return;
    }
    const io = new IntersectionObserver((entries) => {
        for (const ent of entries) {
            if (!ent.isIntersecting) continue;
            io.unobserve(ent.target);
            fillTimelineSummary(office, ent.target);
        }
    }, { rootMargin: '300px' });
    els.forEach(el => io.observe(el));
}

// Open one edition as the full Dispatch spread (exits the ledger).
async function openEditionFromTimeline(id) {
    const item = timelineItems.find(i => i.id === id);
    if (!item) return;
    const thisGen = ++fetchGeneration; // capture BEFORE the fetch, not after
    try {
        const res = await fetch(item.url, { headers: { 'User-Agent': 'Plaincast/1.0 (plaincast.live)' }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error('Fetch failed');
        const prodData = await res.json();
        if (thisGen !== fetchGeneration) return; // user moved on mid-fetch
        const isHistorical = item.id !== timelineItems[0]?.id;
        // Permalink: archived editions carry ?edition= so the URL IS the artifact
        leaveChangelogChrome(isHistorical ? item.id : null);
        viewingHistorical = isHistorical;
        renderAFD(prodData, currentOffice);
        window.scrollTo(0, 0);
        announce('Opened edition');
    } catch (e) { console.debug('Edition open failed', e); }
}

function leaveChangelogChrome(editionId) {
    currentView = 'forecast';
    document.body.classList.remove('view-changelog');
    updateTitle(currentOffice);
    const url = new URL(window.location);
    url.searchParams.delete('view');
    if (editionId) url.searchParams.set('edition', editionId);
    else url.searchParams.delete('edition');
    history.pushState({}, '', url);
    renderedRoute = currentRoute();
}

function appendTimelineEntries(entries, container, office) {
    const tz = OFFICE_TIMEZONES[office] || 'America/Los_Angeles';
    const holder = document.createElement('div');
    holder.innerHTML = entries.map(e => timelineEntryHTML(e, tz)).join('');
    const more = container.querySelector('.timeline-more');
    while (holder.firstChild) {
        container.insertBefore(holder.firstChild, more || null);
    }
    timelineRendered += entries.length;
    observeTimelineSummaries(office, container);
}

async function loadEarlierEditions(container, office, btn) {
    btn.disabled = true;
    btn.textContent = 'Setting the type…';
    try {
        // Need one product past the visible window to diff the last pair.
        const nextItems = timelineItems.slice(timelineProducts.length, timelineProducts.length + TIMELINE_BATCH);
        if (!nextItems.length) { btn.closest('.timeline-more')?.remove(); return; }
        const fetched = await fetchTimelineProducts(nextItems);
        // Focus safety: if the button (about to be moved/removed) holds focus,
        // park focus on the container before mutating.
        const overlapFrom = timelineProducts.length - 1; // last already-fetched product heads the new pairs
        timelineProducts = timelineProducts.concat(fetched);
        const entries = buildTimelineEntries(timelineProducts.slice(overlapFrom), { parseSections, computeDiff });
        appendTimelineEntries(entries, container, office);
        if (timelineProducts.length >= timelineItems.length) {
            const more = btn.closest('.timeline-more');
            if (more && more.contains(document.activeElement)) {
                container.querySelector('.timeline-entry:last-of-type a')?.focus();
            }
            more?.remove();
        } else {
            btn.disabled = false;
            btn.textContent = 'Earlier editions';
        }
    } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Earlier editions';
    }
}

async function showChangelogView(office, updateUrl) {
    currentOffice = office;
    currentView = 'changelog';
    viewingHistorical = false;
    document.body.classList.add('view-changelog');
    applySky(office);
    renderLedger(office);
    const name = OFFICE_NAMES[office] || office;
    const cityEl = document.getElementById('dateline-city');
    if (cityEl) cityEl.textContent = name;
    const dlDate = document.getElementById('dateline-date');
    if (dlDate) dlDate.textContent = 'Forecast Changelog';
    const dlEd = document.getElementById('dateline-edition');
    if (dlEd) dlEd.textContent = 'Every Revision';
    document.title = `Forecast Changelog · ${name} · Plaincast`;
    if (updateUrl !== false) {
        const url = new URL(window.location);
        url.searchParams.set('view', 'changelog');
        history.pushState({}, '', url);
        renderedRoute = currentRoute();
    }

    const thisGen = ++fetchGeneration;
    const sectionsEl = document.getElementById('sections');
    sectionsEl.innerHTML = `
    <div class="skeleton" aria-hidden="true">
        <div class="skeleton-line" style="width: 40%"></div>
        <div class="skeleton-line" style="width: 90%"></div>
        <div class="skeleton-line" style="width: 75%"></div>
    </div>`;

    try {
        timelineItems = await fetchHistoryList(office, TIMELINE_LOOKBACK);
        if (thisGen !== fetchGeneration) return;
        timelineProducts = await fetchTimelineProducts(timelineItems.slice(0, TIMELINE_BATCH + 1));
        if (thisGen !== fetchGeneration) return;
        const entries = buildTimelineEntries(timelineProducts, { parseSections, computeDiff });

        const container = document.createElement('div');
        container.className = 'timeline';
        container.innerHTML = `
        <header class="timeline-header">
            <h2 class="timeline-kicker">The Changelog</h2>
            <p class="timeline-standfirst">Every revision to the ${escapeHTML(name)} forecast, newest first —
            what changed with each update, and whether the forecasters' confidence rose or fell.</p>
            <p class="timeline-back"><a href="/o/${encodeURIComponent(office)}/" id="timeline-back-link">← Back to the forecast</a></p>
        </header>`;

        if (entries.length === 0) {
            container.insertAdjacentHTML('beforeend',
                '<p class="timeline-empty">The archive is thin right now — check back after the next update.</p>');
        }
        if (timelineItems.length > timelineProducts.length) {
            container.insertAdjacentHTML('beforeend',
                '<p class="timeline-more"><button class="timeline-more-btn" type="button">Earlier editions</button></p>');
        }
        sectionsEl.innerHTML = '';
        sectionsEl.appendChild(container);
        timelineRendered = 0;
        appendTimelineEntries(entries, container, office);

        container.querySelector('.timeline-more-btn')?.addEventListener('click', (e) => {
            loadEarlierEditions(container, office, e.currentTarget);
        });
        container.addEventListener('click', (e) => {
            const editionLink = e.target.closest('a[data-edition-id]');
            if (editionLink) {
                e.preventDefault();
                openEditionFromTimeline(editionLink.dataset.editionId);
                return;
            }
            if (e.target.closest('#timeline-back-link')) {
                e.preventDefault();
                leaveChangelogChrome();
                fetchAFD(office);
            }
        });
        announce(`Forecast changelog for ${name}`);
    } catch (e) {
        console.error('Changelog view failed:', e && (e.stack || e.message || e));
        track('changelog-view-fail', { office });
        if (thisGen !== fetchGeneration) return;
        // Wire the retry button programmatically — inline onclick is refused under
        // the CSP (script-src 'self', no 'unsafe-inline'), so it would be a silent no-op.
        sectionsEl.innerHTML = '<div class="loading">Could not load the changelog. <button id="changelog-retry" class="retry-btn">Try again</button></div>';
        sectionsEl.querySelector('#changelog-retry')?.addEventListener('click', () => location.reload());
    }
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
