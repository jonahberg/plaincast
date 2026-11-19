// ─── Tabular AFD sections ──────────────────────────────────────────
// Some sections of an Area Forecast Discussion are tables, not prose: the
// NWS "Preliminary point temps/pops" block is rows of station names and
// numbers (high, low, high, low / chance of rain per period). Measured on real
// model output, an AI "translation" of such a block turns it into prose and
// swaps numbers between highs and lows. A table is already as plain as it
// gets, so these sections are never sent to the model.
//
// One predicate, shared by the server (api/_translatable.js, which both the
// on-demand endpoint and the poller select sections with; api/office-page.js,
// which keeps tables out of the server-rendered digest) and the client (which
// must not ask for AI text for them). Pure, dependency-free, and keyed on
// (section key, section text) so both sides decide the same way: the key may
// be the raw header ("PRELIMINARY POINT TEMPS/POPS") or the display key
// ("Preliminary point temps/pops").
//
// Two independent signals, either one is enough:
//   1. The canonical name: TEMPS/POPS (with or without "PRELIMINARY POINT"),
//      or POINT TEMPS.
//   2. The shape, so an office that names its table differently is still
//      caught: at least two data rows, and data rows make up at least half of
//      the section's non-blank lines (boilerplate like "Issued at ..." and a
//      parenthesized period label excluded). A data row has three or more
//      numeric cells and more numeric cells than words — prose lines, even
//      number-heavy ones, have more words than numbers.

const TABLE_NAME_RE = /\bTEMPS?\s*\/\s*POPS?\b|\bPOINT\s+TEMPS?\b/i;

// A numeric cell: 73, -5, 0.25, 40%, 64/45, (2019).
const NUMERIC_CELL = /^\(?[-+]?\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?%?\)?$/;
// Column separators count as neither a number nor a word.
const SEPARATOR = /^[/|:]+$/;
// Lines that head a section in any format and say nothing about its shape.
const BOILERPLATE = /^(?:(?:Issued|Updated) at\b|\([^)]*\)$)/i;

export function isDataRow(line) {
    let numbers = 0;
    let words = 0;
    for (const token of String(line).trim().split(/\s+/)) {
        if (!token) continue;
        if (NUMERIC_CELL.test(token)) numbers++;
        else if (!SEPARATOR.test(token)) words++;
    }
    return numbers >= 3 && numbers > words;
}

export function isTabularText(text) {
    const lines = String(text || '')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !BOILERPLATE.test(l));
    const rows = lines.filter(isDataRow).length;
    return rows >= 2 && rows * 2 >= lines.length;
}

export function isTabularName(key) {
    return TABLE_NAME_RE.test(String(key || ''));
}

export function isTabularSection(key, text) {
    return isTabularName(key) || isTabularText(text);
}
