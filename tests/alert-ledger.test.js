import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FULL_ABBREVIATIONS } from '../docs/js/abbreviations.js';
import { GLOSSARY, GLOSSARY_COMPILED } from '../docs/js/glossary.js';
import { OFFICE_TIMEZONES } from '../docs/js/offices.js';

// Same VM-extraction pattern as app-formatting.test.js: pull the DOM-free
// slice between `function escapeHTML` and `// ─── AI Translation`, run it with a
// stubbed document, and export the new Hazard Ledger helpers.
function loadLedgerHelpers() {
    const source = readFileSync('docs/js/app.js', 'utf8');
    const start = source.indexOf('function escapeHTML');
    const end = source.indexOf('// ─── AI Translation');
    if (start === -1 || end === -1 || end <= start) {
        throw new Error('Could not locate formatter source in docs/js/app.js');
    }
    const context = {
        console,
        Date,
        Intl,
        GLOSSARY,
        GLOSSARY_COMPILED,
        FULL_ABBREVIATIONS,
        OFFICE_TIMEZONES,
        document: { addEventListener() {} },
        module: { exports: {} },
    };
    vm.createContext(context);
    vm.runInContext(`
        let currentOffice = 'LOX';
        ${source.slice(start, end)}
        module.exports = {
            classifyAlertKind, formatAlertTime, formatAlertTimeProse, formatUntilCell,
            areaDigest, slabHeadline, pickWorstAlert, clockGeometry, formatAlerts,
            alertWindowLabel, alertFactsHTML,
        };
    `, context);
    return context.module.exports;
}

const TZ = 'America/Los_Angeles';
const H = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const NO_EMOJI = /⚠️|👁️|ℹ️|🔹|⚠|👁|ℹ|🔹/u;

// A live alertMap in today's real LOX shapes, timed relative to `now` so the
// ledger's date logic is deterministic no matter when the suite runs.
function loxAlertMap(now) {
    const started = iso(now - 2 * H);
    const endEve = iso(now + 28 * H);
    const endMorn = iso(now + 17 * H);
    return {
        'Extreme Heat Warning': [
            {
                id: 'ehw-la', event: 'Extreme Heat Warning', severity: 'Severe',
                onset: started, ends: endEve, expires: '',
                areaDesc: 'Los Angeles County Valleys including Downtown Los Angeles; San Fernando Valley; Antelope Valley',
                description: '* WHAT...Dangerously hot conditions with temperatures up to 106.',
                instruction: 'Stay in air conditioning and drink plenty of fluids.',
            },
            {
                id: 'ehw-sb', event: 'Extreme Heat Warning', severity: 'Severe',
                onset: started, ends: endEve, expires: '',
                areaDesc: 'Santa Barbara County Southwestern Coast; Santa Ynez Mountains Eastern Range',
                description: '* WHAT...temperatures up to 101.',
                instruction: 'Stay cool and hydrated.',
            },
        ],
        'Red Flag Warning': [
            {
                id: 'rfw', event: 'Red Flag Warning', severity: 'Severe',
                onset: iso(now - 3 * H), ends: endMorn, expires: '',
                areaDesc: 'Interior Mountains; I-5 Corridor',
                description: '* WINDS...gusts of 30 to 50 mph. * RELATIVE HUMIDITY...10 to 25 percent.',
                instruction: 'Use extreme caution with anything that can spark a wildfire.',
            },
        ],
        'Heat Advisory': [
            {
                id: 'heat-adv', event: 'Heat Advisory', severity: 'Moderate',
                onset: started, ends: endEve, expires: '',
                areaDesc: 'Catalina and Santa Barbara Islands; Central Coast Beaches; Santa Ynez Valley',
                description: '* WHAT...Temperatures up to 104.',
                instruction: 'Drink fluids and keep to shade or AC.',
            },
        ],
        'Wind Advisory': [
            {
                id: 'wind-adv', event: 'Wind Advisory', severity: 'Moderate',
                onset: started, ends: endMorn, expires: '',
                areaDesc: 'Santa Ynez Mountains; South Coast of Santa Barbara County',
                description: '* WHAT...gusts up to 55 mph.',
                instruction: 'Secure loose outdoor objects.',
            },
        ],
        'Beach Hazards Statement': [
            {
                id: 'beach', event: 'Beach Hazards Statement', severity: 'Moderate',
                onset: iso(now + 4 * H), ends: iso(now + 11 * H), expires: '',
                areaDesc: 'Los Angeles County Beaches; Ventura County Beaches',
                description: '* WHAT...dangerous rip currents.',
                instruction: 'Stay out of the water.',
            },
        ],
    };
}

describe('formatAlerts — live Hazard Ledger', () => {
    const { formatAlerts } = loadLedgerHelpers();
    const now = Date.now();
    const html = formatAlerts('Extreme Heat Warning. Red Flag Warning. Heat Advisory. Wind Advisory. Beach Hazards Statement.', loxAlertMap(now));

    it('renders one row per alert entry (6 rows for the 6 live alerts)', () => {
        expect(html.match(/class="hz-row/g)?.length).toBe(6);
    });

    it('orders warnings before advisories and statements', () => {
        const kinds = [...html.matchAll(/hz-row hz-(warn|watch|adv|stmt)/g)].map(m => m[1]);
        expect(kinds).toEqual(['warn', 'warn', 'warn', 'adv', 'adv', 'stmt']);
    });

    it('uses printed marks and carries no emoji', () => {
        expect(html).toContain('hz-mark');
        expect(html).not.toMatch(NO_EMOJI);
    });

    it('renders a tabular until cell for every row', () => {
        expect(html.match(/→/g)?.length).toBeGreaterThanOrEqual(6);
    });

    it('digests the area (first zone · N zones, incl. downtown L.A.)', () => {
        expect(html).toContain('· 3 zones');
        expect(html).toContain('incl. downtown L.A.');
    });
});

describe('formatAlerts — upcoming + degraded + XSS', () => {
    const { formatAlerts } = loadLedgerHelpers();

    it('renders an upcoming alert as the start → end cell form', () => {
        const now = Date.now();
        const html = formatAlerts('Beach Hazards Statement.', {
            'Beach Hazards Statement': [{
                id: 'b', event: 'Beach Hazards Statement', severity: 'Moderate',
                onset: iso(now + 4 * H), ends: iso(now + 11 * H), expires: '', areaDesc: 'All beaches',
            }],
        });
        const until = html.match(/<span class="hz-until">([^<]*)<\/span>/)[1];
        expect(until).toContain('→');
        expect(until.trimStart().startsWith('→')).toBe(false); // a start time precedes the arrow
        expect(until).toMatch(/\d{1,2}:\d{2}/);
    });

    it('degrades to static rows (no buttons, no emoji) with an empty alertMap', () => {
        const html = formatAlerts('Heat Advisory in effect. Wind Advisory in effect.', {});
        expect(html.match(/class="hz-row/g)?.length).toBe(2);
        expect(html).toContain('hz-line');
        expect(html).not.toContain('hz-btn');
        expect(html).not.toMatch(NO_EMOJI);
        expect(html).toContain('Heat Advisory');
    });

    it('renders the plain "None." body when nothing matches and no live data', () => {
        expect(formatAlerts('None.', {})).toBe('<p>None.</p>');
    });

    it('escapes hostile event / areaDesc in live rows', () => {
        const html = formatAlerts('x', {
            'Test <img src=x onerror=alert(1)> Warning': [{
                id: 'h', event: 'Test <img src=x onerror=alert(1)> Warning', severity: 'Severe',
                onset: '', ends: '', expires: '', areaDesc: '<b>evil</b> zone',
            }],
        });
        expect(html).toContain('&lt;img');
        expect(html).not.toContain('<img');
        expect(html).not.toContain('<b>evil');
    });
});

describe('formatAlertTime', () => {
    const { formatAlertTime } = loadLedgerHelpers();
    const now = Date.parse('2026-07-15T23:30:00Z'); // Wed 4:30 PM PDT

    it('returns the clock only when the instant is the same local day', () => {
        const out = formatAlertTime('2026-07-16T03:00:00Z', TZ, now); // Wed 8:00 PM PDT
        expect(out).toMatch(/^8:00\s?PM$/);
        expect(out).not.toMatch(/THU/);
    });

    it('prefixes the weekday when it falls on another local day', () => {
        const out = formatAlertTime('2026-07-17T03:00:00Z', TZ, now); // Thu 8:00 PM PDT
        expect(out).toMatch(/^THU /);
        expect(out).toMatch(/8:00/);
    });

    it('returns empty string for a falsy instant', () => {
        expect(formatAlertTime('', TZ, now)).toBe('');
    });
});

describe('formatUntilCell', () => {
    const { formatUntilCell } = loadLedgerHelpers();
    const now = Date.parse('2026-07-15T23:30:00Z');

    it('returns empty when there is no ends and no expires', () => {
        expect(formatUntilCell({ onset: '', ends: '', expires: '' }, TZ, now)).toBe('');
    });

    it('renders → end for an alert already in effect', () => {
        const out = formatUntilCell({ onset: '2026-07-15T20:00:00Z', ends: '2026-07-17T03:00:00Z' }, TZ, now);
        expect(out.startsWith('→')).toBe(true);
    });

    it('renders start → end for a future onset', () => {
        const out = formatUntilCell({ onset: '2026-07-16T03:30:00Z', ends: '2026-07-16T10:00:00Z' }, TZ, now);
        expect(out).toContain('→');
        expect(out.startsWith('→')).toBe(false);
    });

    it('falls back to expires when ends is absent', () => {
        const out = formatUntilCell({ onset: '2026-07-15T20:00:00Z', ends: '', expires: '2026-07-16T05:00:00Z' }, TZ, now);
        expect(out.startsWith('→')).toBe(true);
    });
});

describe('areaDigest', () => {
    const { areaDigest } = loadLedgerHelpers();

    it('keeps a single zone as-is', () => {
        expect(areaDigest('Antelope Valley')).toBe('Antelope Valley');
    });

    it('appends a zone count for multiple zones', () => {
        expect(areaDigest('A; B; C')).toBe('A · 3 zones');
    });

    it('flags downtown L.A. when present', () => {
        expect(areaDigest('Los Angeles County Valleys including Downtown Los Angeles; Antelope Valley'))
            .toContain('incl. downtown L.A.');
    });
});

describe('slabHeadline', () => {
    const { slabHeadline } = loadLedgerHelpers();
    const now = Date.now();
    const ends = iso(now + 24 * H);

    it('templates a heat figure', () => {
        expect(slabHeadline({ event: 'Extreme Heat Warning', description: 'temperatures up to 106.', ends }, TZ, now))
            .toContain('106°');
    });

    it('uses the fire phrase for a Red Flag Warning', () => {
        expect(slabHeadline({ event: 'Red Flag Warning', description: 'gusts of 30 to 50 mph', ends }, TZ, now))
            .toMatch(/fire weather/i);
    });

    it('templates a gust figure', () => {
        expect(slabHeadline({ event: 'Wind Advisory', description: 'gusts up to 55 mph', ends }, TZ, now))
            .toContain('55 mph');
    });

    it('falls back to <event> in effect for an unknown event', () => {
        expect(slabHeadline({ event: 'Dense Fog Advisory', description: 'Visibility one quarter mile.', ends }, TZ, now))
            .toMatch(/^Dense Fog Advisory in effect/);
    });
});

describe('pickWorstAlert', () => {
    const { pickWorstAlert } = loadLedgerHelpers();

    it('ranks Extreme severity above Severe even with fewer zones', () => {
        const worst = pickWorstAlert([
            { event: 'Flood Warning', severity: 'Severe', areaDesc: 'A; B; C; D; E' },
            { event: 'Tornado Warning', severity: 'Extreme', areaDesc: 'A' },
        ]);
        expect(worst.event).toBe('Tornado Warning');
    });

    it('breaks ties on zone count', () => {
        const worst = pickWorstAlert([
            { event: 'Extreme Heat Warning', severity: 'Severe', areaDesc: 'A; B' },
            { event: 'Red Flag Warning', severity: 'Severe', areaDesc: 'A; B; C; D; E' },
        ]);
        expect(worst.event).toBe('Red Flag Warning');
    });

    it('returns null when no severe/extreme warning exists', () => {
        expect(pickWorstAlert([{ event: 'Heat Advisory', severity: 'Moderate', areaDesc: 'A' }])).toBeNull();
    });
});

describe('clockGeometry', () => {
    const { clockGeometry } = loadLedgerHelpers();
    const now = Date.parse('2026-07-15T23:30:00Z');

    it('keeps every percentage within [0, 100] and 6h-aligned ticks', () => {
        const geo = clockGeometry([
            { onset: iso(now - 2 * H), ends: iso(now + 28 * H) },
            { onset: iso(now + 4 * H), ends: iso(now + 11 * H) },
        ], now);
        expect(geo.nowPct).toBeGreaterThanOrEqual(0);
        expect(geo.nowPct).toBeLessThanOrEqual(100);
        for (const t of geo.ticks) {
            expect(t.pct).toBeGreaterThanOrEqual(0);
            expect(t.pct).toBeLessThanOrEqual(100);
            expect(['MID', '6 AM', 'NOON', '6 PM']).toContain(t.label);
        }
        for (const r of geo.rows) {
            expect(r.leftPct).toBeGreaterThanOrEqual(0);
            expect(r.leftPct + r.widthPct).toBeLessThanOrEqual(100.01);
        }
    });

    it('flags an upcoming bar', () => {
        const geo = clockGeometry([
            { onset: iso(now - 2 * H), ends: iso(now + 20 * H) },
            { onset: iso(now + 4 * H), ends: iso(now + 11 * H) },
        ], now);
        expect(geo.rows[0].upcoming).toBe(false);
        expect(geo.rows[1].upcoming).toBe(true);
    });

    it('floors the window at 12h when all alerts end sooner', () => {
        const geo = clockGeometry([{ onset: iso(now - H), ends: iso(now + 3 * H) }], now);
        expect(geo.endMs - geo.startMs).toBe(12 * H);
    });

    it('caps the window at 48h when an alert runs long', () => {
        const geo = clockGeometry([{ onset: iso(now - H), ends: iso(now + 60 * H) }], now);
        expect(geo.endMs - geo.startMs).toBe(48 * H);
    });

    it('handles an empty alerts array — no rows, a floored 12h window, ticks intact', () => {
        const geo = clockGeometry([], now);
        expect(geo.rows).toEqual([]);
        expect(geo.endMs - geo.startMs).toBe(12 * H); // maxEnd never advances past start
        expect(geo.ticks.length).toBeGreaterThan(0);
        expect(geo.nowPct).toBeGreaterThanOrEqual(0);
        expect(geo.nowPct).toBeLessThanOrEqual(100);
    });

    it('treats a nullish alerts arg as empty (the `alerts || []` guard)', () => {
        const geo = clockGeometry(undefined, now);
        expect(geo.rows).toEqual([]);
        expect(geo.endMs - geo.startMs).toBe(12 * H);
    });
});

// ─── Branches not reached by the suite above ────────────────────────

describe('classifyAlertKind — the watch branch (via a live Watch row)', () => {
    const { formatAlerts } = loadLedgerHelpers();

    it('classifies a Watch event as hz-watch', () => {
        const now = Date.now();
        const html = formatAlerts('Flood Watch.', {
            'Flood Watch': [{
                id: 'fw', event: 'Flood Watch', severity: 'Moderate',
                onset: '', ends: iso(now + 6 * H), expires: '', areaDesc: 'Some Basin',
            }],
        });
        expect(html).toContain('hz-row hz-watch');
    });
});

describe('formatAlertTime — unparseable instant', () => {
    const { formatAlertTime } = loadLedgerHelpers();
    const now = Date.parse('2026-07-15T23:30:00Z');

    it('returns empty string when the instant does not parse', () => {
        expect(formatAlertTime('not-a-date', TZ, now)).toBe('');
    });
});

describe('formatAlertTimeProse', () => {
    const { formatAlertTimeProse } = loadLedgerHelpers();
    const now = Date.parse('2026-07-15T23:30:00Z'); // Wed 4:30 PM PDT

    it("drops ':00' for a same-day top-of-the-hour time (no weekday)", () => {
        const out = formatAlertTimeProse('2026-07-16T03:00:00Z', TZ, now); // Wed 8:00 PM PDT
        expect(out).toMatch(/^8\s?PM$/);
        expect(out).not.toContain(':00');
        expect(out).not.toMatch(/WED|Wednesday/i);
    });

    it('keeps the minutes when the same-day time is not on the hour', () => {
        const out = formatAlertTimeProse('2026-07-16T03:30:00Z', TZ, now); // Wed 8:30 PM PDT
        expect(out).toContain('8:30');
    });

    it('prefixes the long weekday on another local day (and still strips :00)', () => {
        const out = formatAlertTimeProse('2026-07-17T03:00:00Z', TZ, now); // Thu 8:00 PM PDT
        expect(out).toMatch(/^Thursday /);
        expect(out).not.toContain(':00');
    });

    it('returns empty string for a falsy or unparseable instant', () => {
        expect(formatAlertTimeProse('', TZ, now)).toBe('');
        expect(formatAlertTimeProse('nope', TZ, now)).toBe('');
    });
});

describe('formatUntilCell — onset absent but ends present', () => {
    const { formatUntilCell } = loadLedgerHelpers();
    const now = Date.parse('2026-07-15T23:30:00Z');

    it('renders → end when there is no onset (NaN onset → in-effect form)', () => {
        const out = formatUntilCell({ onset: '', ends: '2026-07-16T05:00:00Z' }, TZ, now);
        expect(out.startsWith('→')).toBe(true);
    });
});

describe('areaDigest — empty / all-delimiter input', () => {
    const { areaDigest } = loadLedgerHelpers();

    it('returns empty string for empty, whitespace, or nullish input', () => {
        expect(areaDigest('')).toBe('');
        expect(areaDigest('   ')).toBe('');
        expect(areaDigest(null)).toBe('');
        expect(areaDigest(undefined)).toBe('');
    });

    it('returns empty string when the string is only delimiters', () => {
        expect(areaDigest(';;')).toBe('');
    });
});

describe('slabHeadline — until suffix, no-end, and event fallback', () => {
    const { slabHeadline } = loadLedgerHelpers();
    const now = Date.now();
    const ends = iso(now + 24 * H);

    it('appends an " until <time>" suffix when an end is known', () => {
        const out = slabHeadline({ event: 'Extreme Heat Warning', description: 'temperatures up to 106.', ends }, TZ, now);
        expect(out).toMatch(/ until /);
        expect(out.trimEnd().endsWith('.')).toBe(true);
    });

    it('omits the until suffix when there is no end or expiry', () => {
        const out = slabHeadline({ event: 'Dense Fog Advisory', description: 'Visibility one quarter mile.', ends: '', expires: '' }, TZ, now);
        expect(out).toBe('Dense Fog Advisory in effect.');
        expect(out).not.toMatch(/until/);
    });

    it("falls back to 'Alert' when the event name is missing", () => {
        const out = slabHeadline({ description: 'nothing templatable', ends: '', expires: '' }, TZ, now);
        expect(out).toBe('Alert in effect.');
    });
});

describe('pickWorstAlert — empty input, skip branches, and the end-time tiebreak', () => {
    const { pickWorstAlert } = loadLedgerHelpers();
    const now = Date.now();

    it('returns null for an empty or nullish alerts list', () => {
        expect(pickWorstAlert([])).toBeNull();
        expect(pickWorstAlert(undefined)).toBeNull();
    });

    it('keeps the leading worst alert when a weaker candidate follows (lower rank, then fewer zones)', () => {
        const worst = pickWorstAlert([
            { event: 'Tornado Warning', severity: 'Extreme', areaDesc: 'A; B; C', ends: iso(now + 10 * H) },
            { event: 'Flood Warning', severity: 'Severe', areaDesc: 'A', ends: iso(now + 4 * H) },
        ]);
        expect(worst.event).toBe('Tornado Warning');
    });

    it('breaks a rank+zone tie on the earliest end time', () => {
        const worst = pickWorstAlert([
            { event: 'Flood Warning', severity: 'Severe', areaDesc: 'A; B', ends: iso(now + 20 * H) },
            { event: 'Tornado Warning', severity: 'Severe', areaDesc: 'A; B', ends: iso(now + 5 * H) },
        ]);
        expect(worst.event).toBe('Tornado Warning'); // same rank, same zone count → soonest to end wins
    });
});

describe('slabHeadline — event-type gating (red-team regression)', () => {
    const { slabHeadline } = loadLedgerHelpers();
    const now = Date.now();
    const ends = iso(now + 24 * H);

    it('does not give a wind headline to a non-wind warning that mentions gusts', () => {
        const head = slabHeadline({
            event: 'Winter Storm Warning', ends,
            description: 'Heavy snow expected. Winds gusts up to 40 mph at times.',
        }, TZ, now);
        expect(head).toMatch(/^Winter Storm Warning in effect/);
        expect(head).not.toMatch(/Gusts to/);
    });

    it('does not give a heat headline to a non-heat warning that quotes temperatures', () => {
        const head = slabHeadline({
            event: 'Flood Warning', ends,
            description: 'River flooding. Afternoon temperatures up to 95 will accelerate snowmelt.',
        }, TZ, now);
        expect(head).toMatch(/^Flood Warning in effect/);
        expect(head).not.toMatch(/Dangerous heat/);
    });
});

describe('alertWindowLabel', () => {
    const { alertWindowLabel } = loadLedgerHelpers();
    const now = Date.now();

    it('labels an in-effect alert Now → end', () => {
        const label = alertWindowLabel({ onset: iso(now - 2 * H), ends: iso(now + 20 * H) }, TZ, now);
        expect(label.startsWith('Now → ')).toBe(true);
    });

    it('labels an upcoming alert start → end', () => {
        const label = alertWindowLabel({ onset: iso(now + 4 * H), ends: iso(now + 10 * H) }, TZ, now);
        expect(label.startsWith('Now')).toBe(false);
        expect(label).toContain(' → ');
    });
});

describe('alertFactsHTML — structure and escaping', () => {
    const { alertFactsHTML } = loadLedgerHelpers();
    const now = Date.now();

    it('renders facts, what-to-do, and verbatim details', () => {
        const html = alertFactsHTML({
            severity: 'Severe', areaDesc: 'A; B; C',
            onset: iso(now - H), ends: iso(now + 10 * H),
            description: '* WHAT...Hot.', instruction: 'Stay cool.\n\nDrink water.',
        });
        expect(html).toContain('hz-facts');
        expect(html).toContain('3 zones');
        expect(html).toContain('What to do');
        expect(html).toContain('hz-verbatim');
    });

    it('escapes hostile NWS-sourced description, instruction, and severity', () => {
        const html = alertFactsHTML({
            severity: '<script>alert(1)</script>',
            areaDesc: 'A',
            description: '<img src=x onerror=alert(2)>',
            instruction: 'Do this <b onmouseover=alert(3)>now</b>.',
        });
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<img');
        expect(html).not.toContain('<b onmouseover');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('&lt;img');
    });
});

describe('formatAlerts — degraded-mode event/tail split', () => {
    const { formatAlerts } = loadLedgerHelpers();

    it('separates the event name into hz-ev and the sentence tail into hz-area', () => {
        const html = formatAlerts('Heat Advisory in effect until 8 PM PDT Thursday for the valleys.', {});
        const ev = html.match(/<span class="hz-ev">([^<]*)<\/span>/)[1];
        const area = html.match(/<span class="hz-area">([^<]*)<\/span>/)[1];
        expect(ev).toBe('Heat Advisory');
        expect(area).toContain('in effect');
        expect(area).toContain('valleys');
    });

    it('escapes a hostile sentence tail on the degraded path', () => {
        const html = formatAlerts('Heat Advisory <img src=x onerror=alert(1)> in effect.', {});
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
    });
});
