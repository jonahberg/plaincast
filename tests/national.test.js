import { describe, test, expect, afterEach } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import {
    officeFromAlert, groupDispatches, buildCensus, parseSpcOutlook,
    parseRiskCategory, parseDiscussionBody, digestArea, formatExpiry, nextOutlookTime,
    caseArea, riskAreaLine, areaCaption, AREA_PROPER_NOUNS, formatClock, nextOutlookAt,
} from '../api/_national.js';
import { OFFICE_NAMES } from '../docs/js/offices.js';
// `?real` forces a distinct module instance from the bare '../api/_utils.js'
// specifier. Several other test files call mock.module('../api/_utils.js',
// ...) with stubs that predate these four exports; Bun's module mocks are
// process-global (not file-scoped) and also hijack same-module internal
// cross-references (fetchSpcDy1 -> fetchAFDProduct/productUrlFromItem), so a
// plain import here can silently receive a stale, partially-stubbed module
// depending on file run order. The query-string suffix sidesteps that by
// resolving to a fresh, unmocked instance (_utils.js has no module-level
// state beyond a constant, so double-instantiation is safe).
import { fetchSevereAlerts, fetchAlertTotals, fetchSpcDy1, fetchSpcOutlook } from '../api/_utils.js?real';
import alerts from './fixtures/national/severe-alerts.json';
import swody1 from './fixtures/national/swody1.json';
import swody1Fresh from './fixtures/national/swody1-fresh.json';
// Live 05:23Z Nov 12 2026 Day 1 (11:23 PM CST Nov 11): the "today across
// parts of southeastern pennsylvania..." line seen on production Nov 11.
import swody1Nov12 from './fixtures/national/swody1-nov12.json';
import swody2 from './fixtures/national/swody2.json';
import swody3 from './fixtures/national/swody3.json';

const NAMES = { PUB: 'Pueblo', EPZ: 'El Paso', LOT: 'Chicago' };

describe('officeFromAlert', () => {
    test('extracts last-3 office code from AWIPSidentifier', () => {
        expect(officeFromAlert({ parameters: { AWIPSidentifier: ['SVRPUB'] } })).toBe('PUB');
    });
    test('null on missing/short/garbage identifier', () => {
        expect(officeFromAlert({})).toBeNull();
        expect(officeFromAlert({ parameters: { AWIPSidentifier: ['AB'] } })).toBeNull();
        expect(officeFromAlert({ parameters: { AWIPSidentifier: ['SVR12$'] } })).toBeNull();
    });
});

describe('groupDispatches', () => {
    test('warnings only, one row per office, worst first, count aggregated', () => {
        const feats = [
            f('Severe Thunderstorm Warning', 'Severe', 'SVRPUB'),
            f('Severe Thunderstorm Warning', 'Severe', 'SVRPUB'),
            f('Tornado Warning', 'Extreme', 'TORLOT'),
            f('Flood Watch', 'Severe', 'FFAEPZ'), // watch: excluded
        ];
        const rows = groupDispatches(feats, NAMES);
        // toMatchObject (not toEqual): rows now also carry raw areaDesc/expires
        // passthrough fields (see the dedicated describe block below) — the
        // code/city/event/count/extreme contract here is unchanged.
        expect(rows[0]).toMatchObject({ code: 'LOT', city: 'Chicago', event: 'Tornado Warning', count: 1, extreme: true });
        expect(rows[1]).toMatchObject({ code: 'PUB', city: 'Pueblo', event: 'Severe Thunderstorm Warning', count: 2, extreme: false });
        expect(rows.length).toBe(2);
    });
    test('uncovered office keeps its dispatch with city null', () => {
        const rows = groupDispatches([f('Severe Thunderstorm Warning', 'Severe', 'SVRCYS')], NAMES);
        expect(rows[0].code).toBe('CYS');
        expect(rows[0].city).toBeNull();
    });
    test('live fixture produces rows without throwing', () => {
        expect(Array.isArray(groupDispatches(alerts.features, NAMES))).toBe(true);
    });
    test('passes through raw areaDesc/expires from the leading warning, unformatted', () => {
        const rows = groupDispatches(
            [f('Severe Thunderstorm Warning', 'Severe', 'SVRPUB', { areaDesc: 'Otero; Crowley', expires: '2026-08-16T01:30:00Z' })],
            NAMES,
        );
        expect(rows[0].areaDesc).toBe('Otero; Crowley');
        expect(rows[0].expires).toBe('2026-08-16T01:30:00Z');
    });
    test('expires falls back to ends; both null when absent', () => {
        const withEnds = groupDispatches([f('Tornado Warning', 'Extreme', 'TORLOT', { ends: '2026-08-16T02:00:00Z' })], NAMES);
        expect(withEnds[0].expires).toBe('2026-08-16T02:00:00Z');
        const withNeither = groupDispatches([f('Tornado Warning', 'Extreme', 'TORLOT')], NAMES);
        expect(withNeither[0].areaDesc).toBeNull();
        expect(withNeither[0].expires).toBeNull();
    });
    test('promotion to a worse warning carries that warning\'s own areaDesc/expires, not the first warning\'s', () => {
        const rows = groupDispatches([
            f('Severe Thunderstorm Warning', 'Severe', 'SVRPUB', { areaDesc: 'FirstArea', expires: '2026-08-16T01:00:00Z' }),
            f('Tornado Warning', 'Extreme', 'SVRPUB', { areaDesc: 'SecondArea', expires: '2026-08-16T02:00:00Z' }),
        ], NAMES);
        expect(rows[0].event).toBe('Tornado Warning');
        expect(rows[0].areaDesc).toBe('SecondArea');
        expect(rows[0].expires).toBe('2026-08-16T02:00:00Z');
    });
});

describe('buildCensus', () => {
    test('counts by event desc, capped at 6 classes', () => {
        const feats = ['A','A','A','B','B','C','D','E','F','G'].map(e => f(e, 'Severe', 'XXXLOT'));
        const rows = buildCensus(feats);
        expect(rows[0]).toEqual({ event: 'A', count: 3 });
        expect(rows.length).toBe(6);
    });
});

describe('parseSpcOutlook', () => {
    test('extracts headline and summary from live fixture', () => {
        const { headline, summary } = parseSpcOutlook(swody1.productText);
        expect(headline).toMatch(/risk/i);
        expect(summary.length).toBeGreaterThan(80);
        expect(summary).not.toMatch(/\.\.\.SUMMARY\.\.\./);
    });
    test('null-safe on garbage', () => {
        expect(parseSpcOutlook('')).toEqual({ headline: null, summary: null });
        expect(parseSpcOutlook('no structure here')).toEqual({ headline: null, summary: null });
    });
});

describe('parseRiskCategory', () => {
    test('extracts level and regions from a THERE-IS headline', () => {
        const r = parseRiskCategory('THERE IS A SLIGHT RISK OF SEVERE THUNDERSTORMS PORTIONS OF THE OHIO VALLEY AND PARTS OF THE CENTRAL HIGH PLAINS');
        expect(r.level).toBe('SLIGHT');
        expect(r.regions).toMatch(/Ohio Valley/i);
    });
    test('all five categorical words map', () => {
        for (const w of ['MARGINAL','SLIGHT','ENHANCED','MODERATE','HIGH']) {
            expect(parseRiskCategory(`THERE IS A ${w} RISK OF SEVERE THUNDERSTORMS SOMEWHERE`).level).toBe(w);
        }
    });
    test('null on no-risk / garbage headlines (calm face)', () => {
        expect(parseRiskCategory('NO SEVERE THUNDERSTORM AREAS FORECAST')).toBeNull();
        expect(parseRiskCategory(null)).toBeNull();
    });
    test('area keeps the whole tail, connective included; regions still trims one', () => {
        const r = parseRiskCategory('THERE IS A MARGINAL RISK OF SEVERE THUNDERSTORMS ACROSS  PARTS OF THE OHIO VALLEY');
        expect(r.area).toBe('ACROSS PARTS OF THE OHIO VALLEY');
        expect(r.regions).toBe('PARTS OF THE OHIO VALLEY');
        expect(parseRiskCategory('THERE IS A SLIGHT RISK OF SEVERE THUNDERSTORMS').area).toBe('');
    });
});

// The risk line under the categorical word, cased in the source text (Nov 11
// 2026: production showed "today across parts of southeastern
// pennsylvania...much of delaware..." — CSS-lowercased SPC caps).
describe('riskAreaLine / caseArea', () => {
    const line = (product) => riskAreaLine(parseRiskCategory(parseSpcOutlook(product.productText).headline));

    test('every fixture headline reads as a cased sentence', () => {
        expect(line(swody1)).toBe('Risk of severe thunderstorms across portions of the Ohio Valley and parts of the central High Plains.');
        expect(line(swody1Fresh)).toBe('Risk of severe thunderstorms across parts of the Ohio Valley, central Appalachians, Mid-Atlantic, and central High Plains.');
        expect(line(swody1Nov12)).toBe('Risk of severe thunderstorms today across parts of southeastern Pennsylvania, much of Delaware, adjacent eastern Maryland and southern through central New Jersey.');
        expect(line(swody2)).toBe('Risk of severe thunderstorms over parts of the northern Plains, and from the southern Appalachians into the Carolinas.');
        expect(line(swody3)).toBe('Risk of severe thunderstorms over parts of the central Plains to lower Missouri/mid Mississippi Valley.');
    });

    test('the Nov 11 production string, as SPC wrote it', () => {
        expect(riskAreaLine({ area: 'TODAY ACROSS PARTS OF SOUTHEASTERN PENNSYLVANIA...MUCH OF DELAWARE...ADJACENT EASTERN MARYLAND AND SOUTHERN THROUGH CENTRAL NEW JERSEY' }))
            .toBe('Risk of severe thunderstorms today across parts of southeastern Pennsylvania, much of Delaware, adjacent eastern Maryland and southern through central New Jersey.');
    });

    test('"..." joins become commas; the source\'s own final "and" is kept, never invented', () => {
        expect(caseArea('TEXAS...OKLAHOMA...KANSAS')).toBe('Texas, Oklahoma, Kansas');
        expect(caseArea('TEXAS...OKLAHOMA AND KANSAS')).toBe('Texas, Oklahoma and Kansas');
        expect(caseArea('TEXAS...OKLAHOMA...AND KANSAS')).toBe('Texas, Oklahoma, and Kansas');
    });

    // Real Day 1-3 headlines from Nov 5-12 2026 (api.weather.gov SWO DY1/2/3).
    test('live phrasings: multi-word regions, slashes, hyphens, plurals, postal codes', () => {
        const cases = [
            ['ACROSS PARTS OF THE LOWER OHIO AND WESTERN TENNESSEE VALLEYS...AS WELL AS ACROSS THE EAST-CENTRAL FLORIDA PENINSULA',
                'across parts of the lower Ohio and western Tennessee Valleys, as well as across the east-central Florida Peninsula'],
            ['ACROSS PARTS OF CENTRAL/SOUTHERN INDIANA...WESTERN KENTUCKY...AND FAR SOUTHEASTERN ILLINOIS',
                'across parts of central/southern Indiana, western Kentucky, and far southeastern Illinois'],
            ['THROUGH MID EVENING ACROSS PARTS OF WESTERN INTO CENTRAL KENTUCKY',
                'through mid evening across parts of western into central Kentucky'],
            ['ACROSS THE MIDDLE TO UPPER TX COAST', 'across the middle to upper TX coast'],
            ['TODAY ALONG THE MIDDLE-LOWER TEXAS COAST', 'today along the middle-lower Texas coast'],
            ['ACROSS PARTS OF THE CENTRAL/EASTERN CAROLINAS AND COASTAL SOUTHERN MID-ATLANTIC',
                'across parts of the central/eastern Carolinas and coastal southern Mid-Atlantic'],
            ['FROM PORTIONS OF THE CAROLINAS TO THE MID ATLANTIC COAST', 'from portions of the Carolinas to the Mid Atlantic coast'],
            ['THIS AFTERNOON ACROSS PARTS OF EASTERN NORTH CAROLINA', 'this afternoon across parts of eastern North Carolina'],
            ['ACROSS PORTIONS OF THE MID MISSISSIPPI VALLEY', 'across portions of the mid Mississippi Valley'],
        ];
        for (const [raw, cased] of cases) expect(caseArea(raw)).toBe(cased);
    });

    test('compass regions: capitalised alone, adjectives before a place', () => {
        expect(caseArea('OVER NORTHWEST WASHINGTON')).toBe('over northwest Washington');
        expect(caseArea('OVER THE EASTERN CAROLINAS AND FAR SOUTHEAST VIRGINIA')).toBe('over the eastern Carolinas and far southeast Virginia');
        expect(caseArea('ACROSS THE SOUTHEAST')).toBe('across the Southeast');
        expect(caseArea('THE NORTHEAST AND MID-ATLANTIC')).toBe('the Northeast and Mid-Atlantic');
        expect(caseArea('SOUTHEAST TX')).toBe('southeast TX');
        expect(caseArea('NORTHWEST WASHINGTON AND THE PACIFIC NORTHWEST COAST')).toBe('northwest Washington and the Pacific Northwest coast');
        expect(caseArea('NORTHERN PLAINS INTO THE UPPER MIDWEST')).toBe('northern Plains into the upper Midwest');
    });

    test('longest name wins: two-word states, DC, chained suffixes', () => {
        expect(caseArea('WESTERN NORTH CAROLINA AND SOUTHERN WEST VIRGINIA')).toBe('western North Carolina and southern West Virginia');
        expect(caseArea('THE DISTRICT OF COLUMBIA')).toBe('the District of Columbia');
        expect(caseArea('ARKANSAS AND KANSAS')).toBe('Arkansas and Kansas');
        expect(caseArea('THE CONNECTICUT RIVER VALLEY')).toBe('the Connecticut River Valley');
        expect(caseArea('THE NEBRASKA PANHANDLE')).toBe('the Nebraska Panhandle');
        expect(caseArea('PARTS OF THE U.S. INTERMOUNTAIN WEST')).toBe('parts of the U.S. Intermountain West');
    });

    test('postal codes that are also words stay words — unless slash-joined to a code', () => {
        expect(caseArea('EASTERN KS/WESTERN MO')).toBe('eastern KS/western MO');
        expect(caseArea('IN AND AROUND SOUTHERN OH')).toBe('in and around southern OH');
        expect(caseArea('OKLAHOMA OR TEXAS')).toBe('Oklahoma or Texas');
        expect(caseArea('THE TX/OK PANHANDLES')).toBe('the TX/OK Panhandles');
        expect(caseArea('THE LOWER MS VALLEY')).toBe('the lower MS Valley');
    });

    test('names beyond the states: neighbours, coasts, ranges, cities on the list', () => {
        expect(caseArea('NORTHERN MEXICO')).toBe('northern Mexico');
        expect(caseArea('NEAR THE CANADIAN BORDER')).toBe('near the Canadian border');
        expect(caseArea('THE CAROLINA COAST')).toBe('the Carolina coast');
        expect(caseArea('THE EAST COAST')).toBe('the East Coast');
        expect(caseArea('NEW YORK CITY')).toBe('New York City');
        expect(caseArea('THE ADIRONDACKS AND WHITE MOUNTAINS')).toBe('the Adirondacks and White Mountains');
        expect(caseArea('SAN JOAQUIN VALLEY')).toBe('San Joaquin Valley');
    });

    test('a bare place gets "across"; an empty tail is a bare sentence', () => {
        expect(riskAreaLine({ area: 'PORTIONS OF THE OHIO VALLEY' })).toBe('Risk of severe thunderstorms across portions of the Ohio Valley.');
        expect(riskAreaLine({ area: '' })).toBe('Risk of severe thunderstorms.');
        expect(riskAreaLine(parseRiskCategory('THERE IS A MARGINAL RISK OF SEVERE THUNDERSTORMS'))).toBe('Risk of severe thunderstorms.');
        expect(riskAreaLine({ regions: 'THE PLAINS' })).toBe('Risk of severe thunderstorms across the Plains.'); // no `area`: falls back
        expect(riskAreaLine(null)).toBe('Risk of severe thunderstorms.');
    });

    test('areaCaption: the rail note, sentence-cased', () => {
        expect(areaCaption('PARTS OF THE NORTHERN PLAINS...AND FROM THE SOUTHERN APPALACHIANS INTO THE CAROLINAS'))
            .toBe('Parts of the northern Plains, and from the southern Appalachians into the Carolinas');
        expect(areaCaption('')).toBeNull();
    });

    test('the list: all 50 states, DC, and the regions SPC routinely names', () => {
        const states = ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware',
            'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana',
            'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana',
            'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina',
            'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina',
            'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia',
            'Wisconsin', 'Wyoming', 'District of Columbia'];
        expect(states.length).toBe(51);
        const regions = ['Mid-Atlantic', 'New England', 'Great Lakes', 'Great Plains', 'High Plains', 'Great Basin',
            'Ohio Valley', 'Tennessee Valley', 'Mississippi Valley', 'Missouri Valley', 'Red River', 'Rio Grande',
            'Gulf Coast', 'Gulf of America', 'Gulf of Mexico', 'Atlantic', 'Pacific', 'Appalachians', 'Ozarks',
            'Rockies', 'Black Hills', 'Carolinas', 'Dakotas', 'Florida Peninsula', 'Florida Panhandle', 'Florida Keys',
            'Texas Panhandle', 'Oklahoma Panhandle', 'Big Bend', 'Delmarva', 'Arklatex', 'Four Corners',
            'Intermountain West', 'Midwest', 'Northeast', 'Southeast', 'Southwest', 'Northwest', 'Pacific Northwest',
            'Hudson Valley', 'Chesapeake', 'Great Salt Lake', 'Sierra Nevada', 'Cascades', 'Front Range',
            'Edwards Plateau', 'Lake Michigan', 'Lake Superior', 'Lake Erie', 'Lake Huron', 'Lake Ontario'];
        for (const name of [...states, ...regions]) {
            expect(AREA_PROPER_NOUNS).toContain(name);
            // and each one round-trips out of SPC's capitals
            expect(caseArea(name.toUpperCase())).toBe(name);
        }
    });

    test('plain text out: no markup is added (the caller escapes)', () => {
        expect(caseArea('<B> & THE OHIO VALLEY')).toBe('<b> & the Ohio Valley');
    });
});

describe('formatClock (the desk\'s Eastern clock)', () => {
    test('US Eastern with the zone abbreviation, DST-aware', () => {
        expect(formatClock('2026-11-12T05:23:00+00:00')).toBe('12:23 AM EST');
        expect(formatClock('2026-08-16T12:44:00+00:00')).toBe('8:44 AM EDT');
        expect(formatClock('2026-08-16T12:44:00+00:00', 'America/Denver')).toBe('6:44 AM MDT');
    });
    test('a plain space before AM/PM, never ICU\'s narrow no-break space', () => {
        expect(formatClock('2026-11-12T17:05:00Z')).toBe('12:05 PM EST');
        expect(formatClock('2026-11-12T17:05:00Z')).not.toMatch(/[  ]/);
    });
    test('null — never a broken string — for a missing or bad timestamp', () => {
        for (const bad of [null, undefined, '', 'not-a-date']) expect(formatClock(bad)).toBeNull();
    });
});

describe('nextOutlookAt', () => {
    test('the next SPC slot as an instant, rolling to tomorrow after 2000 UTC', () => {
        expect(nextOutlookAt('2026-11-12T05:23:00Z')).toBe('2026-11-12T06:00:00.000Z');
        expect(nextOutlookAt('2026-11-12T13:00:00Z')).toBe('2026-11-12T16:30:00.000Z');
        expect(nextOutlookAt('2026-11-12T21:00:00Z')).toBe('2026-11-13T01:00:00.000Z');
        expect(nextOutlookAt('2026-12-31T23:59:00Z')).toBe('2027-01-01T01:00:00.000Z');
    });
    test('agrees with nextOutlookTime on the slot', () => {
        for (const now of ['2026-08-16T02:00:00Z', '2026-08-16T06:01:00Z', '2026-08-16T23:30:00Z']) {
            const at = new Date(nextOutlookAt(now));
            const hhmm = `${String(at.getUTCHours()).padStart(2, '0')}${String(at.getUTCMinutes()).padStart(2, '0')} UTC`;
            expect(hhmm).toBe(nextOutlookTime(now));
        }
    });
    test('null on a bad date', () => {
        expect(nextOutlookAt('nope')).toBeNull();
    });
});

describe('parseDiscussionBody', () => {
    // The FRESH-issuance fixture (12:44Z, first product of its cycle) is the
    // one that exercises the running-copy path end to end: no PREV block, no
    // reissue preamble, discussion prose straight after the summary.
    test('returns post-SUMMARY prose only, from the live fresh-issuance DY1 fixture', () => {
        const paras = parseDiscussionBody(swody1Fresh.productText);
        expect(paras.length).toBeGreaterThan(0);
        expect(paras.length).toBeLessThanOrEqual(3);
        const { summary } = parseSpcOutlook(swody1Fresh.productText);
        expect(paras[0]).not.toBe(summary);           // never the summary itself
        for (const p of paras) {
            expect(p).not.toMatch(/^\.\.\./);          // no section-header lines
            expect(p.length).toBeGreaterThanOrEqual(40);
        }
        // spec: running copy opens with the meteorology, not editorial preamble
        expect(paras[0]).toMatch(/^Satellite and regional radar imagery/);
    });
    test('empty array when nothing follows the summary', () => {
        expect(parseDiscussionBody('...SUMMARY...\nOnly a summary here with enough length to pass filters.\n$$')).toEqual([]);
        expect(parseDiscussionBody('')).toEqual([]);
    });

    // The 20Z DY1 fixture is a REISSUE: a ".PREV DISCUSSION... /ISSUED 1135
    // AM/" block republishing the superseded 11:35 AM discussion, and above
    // it a paragraph of reissue housekeeping ("The previous forecast (see
    // below) remains generally on track…"). Neither is current forecast
    // prose: the PREV block is this morning's forecast, and the preamble
    // points at content we just cut, so "(see below)" would dangle at the
    // reader. Both go; the product then has no running copy of its own and
    // falls back to the summary (spec §5).
    test('a reissued product yields no running copy at all — PREV block and preamble both dropped', () => {
        const paras = parseDiscussionBody(swody1.productText);
        expect(paras).toEqual([]);
    });

    test('the reissue preamble is dropped even without a PREV block', () => {
        const text = '...SUMMARY...\nA summary paragraph long enough to survive the length filter here.\n\n...20Z Update...\nThe previous forecast (see below) remains generally on track, with only minor changes made this hour.\n';
        expect(parseDiscussionBody(text)).toEqual([]);
    });

    // Narrow by construction: the preamble pattern must not eat a paragraph
    // that merely mentions a previous forecast while reporting weather.
    test('the preamble filter does not swallow genuine prose that mentions a forecast', () => {
        const text = '...SUMMARY...\nA summary paragraph long enough to survive the length filter here.\n\n...Discussion...\nSevere storms will develop along the dryline this afternoon, and the previous forecast reasoning about storm mode still applies across the warm sector.\n';
        const paras = parseDiscussionBody(text);
        expect(paras.length).toBe(1);
        expect(paras[0]).toMatch(/^Severe storms will develop/);
    });

    // Live 20Z Day 1 update paragraphs, Nov 5-12 2026: housekeeping that
    // points at the PREV block we cut. Each product falls back to the summary.
    test('a 20Z update that only points at the discussion below is dropped', () => {
        const live = [
            'The forecast remains on track, and no changes were needed with this update. See the previous discussion below for details.',
            'No changes are needed to the D1 Convective Outlook. See previous discussion below for more information.',
            'No changes are needed to the current D1 Convective Outlook. See previous discussion below for more information.',
            'Only minor adjustments were made to clear behind ongoing convection. See previous discussion below for more information.',
            'Only minor adjustments were made to thunderstorm coverage based on trends in radar. See previous discussion below for more information.',
        ];
        for (const para of live) {
            const text = `...SUMMARY...\nA summary paragraph long enough to survive the length filter here.\n\n...20z Update...\n${para}\n\n..Halbert-E.. 11/07/2026\n\n.PREV DISCUSSION... /ISSUED 1026 AM CST Sat Nov 07 2026/\n\n...Synopsis...\nStale prose that is also comfortably past the forty character floor.\n`;
            expect(parseDiscussionBody(text)).toEqual([]);
        }
    });

    test('a 20Z update with real meteorology and no pointer is kept', () => {
        const para = 'The Marginal Risk along the lower Texas coast was removed with this update. Temperatures have been gradually cooling with the air mass inland becoming overworked by ongoing rain/thunderstorm activity.';
        const text = `...SUMMARY...\nA summary paragraph long enough to survive the length filter here.\n\n...20z Update...\n${para}\n`;
        expect(parseDiscussionBody(text)).toEqual([para]);
    });

    test('the PREV marker matches 1-3 dots, any case', () => {
        const body = (mark) => `...SUMMARY...\nA summary paragraph long enough to survive the length filter here.\n\n...20Z Update...\nCurrent prose that is comfortably past the forty character floor.\n\n${mark} /ISSUED 1135 AM CDT/\n\n...Front Range...\nStale prose that is also comfortably past the forty character floor.\n`;
        for (const mark of ['.PREV DISCUSSION...', '..PREV DISCUSSION...', '...PREV DISCUSSION...', '.prev discussion...']) {
            const paras = parseDiscussionBody(body(mark));
            expect(paras.length).toBe(1);
            expect(paras[0]).toMatch(/Current prose/);
            expect(paras.join(' ')).not.toMatch(/Stale prose/);
        }
    });

    test('a PREV marker ahead of the summary leaves nothing to render (fallback path)', () => {
        const text = '.PREV DISCUSSION... /ISSUED 1135 AM CDT/\n...SUMMARY...\nA summary paragraph long enough to survive the length filter.\n\n...Region...\nProse that would otherwise pass every filter in this parser.\n';
        expect(parseDiscussionBody(text)).toEqual([]);
    });
});

describe('digestArea', () => {
    test('two areas + overflow marker', () => {
        expect(digestArea('Otero; Crowley; Pueblo; Las Animas')).toBe('Otero & Crowley +2 more');
        expect(digestArea('Franklin Mountains')).toBe('Franklin Mountains');
        expect(digestArea('A; B')).toBe('A & B');
        expect(digestArea('')).toBeNull();
        expect(digestArea(null)).toBeNull();
    });
});

describe('formatExpiry', () => {
    test('office-local until-time', () => {
        expect(formatExpiry('2026-08-16T01:30:00Z', 'America/Denver')).toMatch(/until 7:30 PM MDT/i);
    });
    test('null on garbage', () => {
        expect(formatExpiry('nope', 'America/Denver')).toBeNull();
        expect(formatExpiry(null, 'America/Denver')).toBeNull();
    });
});

describe('nextOutlookTime', () => {
    test('walks the fixed SPC schedule', () => {
        expect(nextOutlookTime('2026-08-16T02:00:00Z')).toBe('0600 UTC');
        expect(nextOutlookTime('2026-08-16T06:01:00Z')).toBe('1300 UTC');
        expect(nextOutlookTime('2026-08-16T23:30:00Z')).toBe('0100 UTC'); // wraps
    });
});

function f(event, severity, awips, extra = {}) {
    return { properties: { event, severity, parameters: { AWIPSidentifier: [awips] }, ...extra } };
}

// These three fetchers call the global `fetch` directly (NWS APIs), so we
// stub globalThis.fetch per test rather than mock.module — mirroring the
// save/restore mechanics in tests/api-conditions.test.js. realFetch is
// captured once here and restored after every test so no mock leaks into
// the rest of the suite.
describe('national fetchers', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    test('fetchSevereAlerts hits the exact verified query and unwraps features', async () => {
        let seen;
        globalThis.fetch = async (url) => {
            seen = String(url);
            return new Response(JSON.stringify({ features: [{ properties: { event: 'X' } }] }), { status: 200 });
        };
        const feats = await fetchSevereAlerts({});
        expect(seen).toBe('https://api.weather.gov/alerts/active?status=actual&severity=Severe,Extreme&region_type=land');
        expect(feats.length).toBe(1);
    });

    test('fetchSpcDy1 follows @graph[0]["@id"] and returns text+issuance', async () => {
        globalThis.fetch = async (url) => {
            if (String(url).includes('/products/types/SWO/locations/DY1')) {
                return new Response(JSON.stringify({ '@graph': [{ '@id': 'https://api.weather.gov/products/abc' }] }), { status: 200 });
            }
            return new Response(JSON.stringify({ productText: 'TEXT', issuanceTime: '2026-08-15T19:42:00+00:00' }), { status: 200 });
        };
        const out = await fetchSpcDy1({});
        expect(out.productText).toBe('TEXT');
        expect(out.issuanceTime).toContain('2026');
    });

    test('fetchAlertTotals returns null on non-OK (soft data)', async () => {
        globalThis.fetch = async () => new Response('nope', { status: 503 });
        expect(await fetchAlertTotals({})).toBeNull();
    });

    test('fetchSpcOutlook(DY2) hits the DY2 locations endpoint and unwraps text+issuance', async () => {
        let seen;
        globalThis.fetch = async (url) => {
            if (String(url).includes('/products/types/SWO/locations/DY2')) {
                seen = String(url);
                return new Response(JSON.stringify({ '@graph': [{ '@id': 'https://api.weather.gov/products/def' }] }), { status: 200 });
            }
            return new Response(JSON.stringify({ productText: 'TEXT2', issuanceTime: '2026-08-16T17:34:00+00:00' }), { status: 200 });
        };
        const out = await fetchSpcOutlook('DY2', {});
        expect(seen).toBe('https://api.weather.gov/products/types/SWO/locations/DY2');
        expect(out.productText).toBe('TEXT2');
        expect(out.issuanceTime).toContain('2026');
    });

    test('fetchSpcOutlook rejects an invalid location without fetching', async () => {
        let called = false;
        globalThis.fetch = async () => { called = true; throw new Error('must not fetch'); };
        // Asserts the specific validation message (not just "rejects") — a
        // tripwire mock that throws on fetch would otherwise satisfy a bare
        // rejects.toThrow() even if the guard were deleted and fetch ran.
        await expect(fetchSpcOutlook('EVIL', {})).rejects.toThrow('bad outlook location');
        expect(called).toBe(false);
    });

    test('fetchSpcDy1 still resolves through the shared fetchSpcOutlook path', async () => {
        globalThis.fetch = async (url) => {
            if (String(url).includes('/products/types/SWO/locations/DY1')) {
                return new Response(JSON.stringify({ '@graph': [{ '@id': 'https://api.weather.gov/products/abc' }] }), { status: 200 });
            }
            return new Response(JSON.stringify({ productText: 'TEXT', issuanceTime: '2026-08-15T19:42:00+00:00' }), { status: 200 });
        };
        const out = await fetchSpcDy1({});
        expect(out.productText).toBe('TEXT');
        expect(out.issuanceTime).toContain('2026');
    });
});

// The baked shell is the fail-safe floor for /national/: api/national-desk.js
// string-replaces the #desk-loading marker with SSR content and, on any error,
// serves these exact bytes. These assertions pin the marker contract (drift
// here silently degrades the live page to the shell forever) and the shell's
// standalone value — a typeset index linking all 68 local desks.
//
// The shell lives at api/_national-shell.html, NOT under docs/. Unlike the
// per-office pages it has no reason to exist in the static root: nothing links
// to a static /national/index.html, and putting one there would shadow the
// /national rewrite (rewrites are evaluated after the filesystem check), which
// would then need a .vercelignore entry — and an ignored file's availability to
// `includeFiles` is undocumented. Underscore-prefixed in api/ sidesteps all of
// it: Vercel does not treat it as an endpoint (see api/_utils.js) and it ships
// to the function via the same includeFiles path as api/_og-fonts/**.
// Paths are repo-root-relative, matching the readFileSync in tests/sw.test.js.
describe('national shell', () => {
    const shell = readFileSync('api/_national-shell.html', 'utf8');

    test('carries the SSR marker and local-desk slot', () => {
        expect(shell).toContain('<div class="loading" id="desk-loading">Setting the type…</div>');
        expect(shell).toContain('id="local-desk"');
        expect(shell).toContain('src="/js/national.js"');
    });

    test('links every covered office in the desk index', () => {
        for (const code of Object.keys(OFFICE_NAMES)) {
            expect(shell).toContain(`href="/o/${code}/"`);
        }
    });

    test('self-canonical, absolute assets, static OG card', () => {
        expect(shell).toContain('<link rel="canonical" href="https://plaincast.live/national/">');
        expect(shell).toContain('href="/styles.css"');
        expect(shell).toContain('content="https://plaincast.live/og-image.png"');
    });

    // Guards the routing hazard in the other direction: if anyone reintroduces
    // a static docs/national/, it shadows the /national rewrite and
    // api/national-desk.js silently stops running. Keeping the shell out of
    // docs/ is what makes a .vercelignore entry unnecessary, so a rule
    // reappearing there is the signal that the shell moved back.
    test('no static docs/national/ exists to shadow the /national rewrite', () => {
        expect(existsSync('docs/national')).toBe(false);
        expect(readFileSync('.vercelignore', 'utf8')).not.toMatch(/docs\/national/);
    });

    test('ships to the serverless function via includeFiles', () => {
        const cfg = JSON.parse(readFileSync('vercel.json', 'utf8'));
        expect(cfg.functions['api/national-desk.js'].includeFiles).toBe('api/_national-shell.html');
        const sources = cfg.rewrites.map(r => r.source);
        expect(sources).toContain('/national');
        expect(sources).toContain('/national/');
    });
});

// Sitewide linkage: the homepage office-index and the sitemap both need to
// point at /national/, or the desk is orphaned — reachable only by URL.
describe('national linkage', () => {
    test('homepage office-index links the National Desk', () => {
        const home = readFileSync('docs/index.html', 'utf8');
        expect(home).toContain('href="/national/"');
    });
    test('sitemap carries /national/', () => {
        expect(readFileSync('docs/sitemap.xml', 'utf8')).toContain('https://plaincast.live/national/</loc>');
    });
    // The office-index link sits at the foot of the page; the masthead entry is
    // what makes the desk reachable above the fold. Exact-match the anchor —
    // the bare href already appears in the office index, so a substring test on
    // '/national/' alone would pass without the dateline entry existing.
    test('homepage masthead dateline carries the National Desk entry', () => {
        const home = readFileSync('docs/index.html', 'utf8');
        expect(home).toContain('<a class="dateline-desk" href="/national/">National&nbsp;Desk</a>');
    });
    // On the desk itself the same entry would be a self-link, so the shell's
    // dateline deliberately stays as-is.
    test('national shell does not self-link in its dateline', () => {
        expect(readFileSync('api/_national-shell.html', 'utf8')).not.toContain('dateline-desk');
    });
});
