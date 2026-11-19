// Tables are never AI-translated (docs/js/tabular.js). A measurement on real
// model output found the "Preliminary point temps/pops" block — rows of
// station names and numbers — "translated" into prose with highs and lows
// swapped. The predicate is shared by the server (api/_translatable.js, the
// one place the on-demand endpoint and the poller select sections) and the
// client, so both parsers' section texts are checked here.
import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isDataRow, isTabularName, isTabularSection, isTabularText } from '../docs/js/tabular.js';
import { extractSections } from '../api/_afd-sections.js';
import { parseSections } from '../shadcn/src/lib/afd.js';
import { translatableSections } from '../api/_translatable.js';
import { translateEdition } from '../api/translate-issuance.js';

const AFD_DIR = new URL('./fixtures/afd/', import.meta.url);
const product = (rel) => JSON.parse(readFileSync(new URL(rel, AFD_DIR), 'utf8'));
// Real products fetched from api.weather.gov on 2026-11-18 (MFL, HGX).
const MFL = product('live-2026-11-18/MFL.json');
const HGX = product('live-2026-11-18/HGX.json');

// Every AFD in the fixture corpus: the live snapshots (JSON) and the
// classic samples (.txt).
function corpus() {
    const out = [];
    const walk = (url) => {
        for (const f of readdirSync(url)) {
            const u = new URL(f, url);
            if (statSync(u).isDirectory()) walk(new URL(`${f}/`, url));
            else if (f.endsWith('.json')) out.push({ name: f, text: JSON.parse(readFileSync(u, 'utf8')).productText });
            else if (f.endsWith('.txt')) out.push({ name: f, text: readFileSync(u, 'utf8') });
        }
    };
    walk(AFD_DIR);
    return out;
}

const TABLE_KEY = 'PRELIMINARY POINT TEMPS/POPS';
const tableOf = (text) => extractSections(text).find(s => s.key === TABLE_KEY).text;

describe('isTabularName: the canonical table headers', () => {
    it('matches TEMPS/POPS and POINT TEMPS in raw and display form', () => {
        for (const k of ['PRELIMINARY POINT TEMPS/POPS', 'Preliminary point temps/pops', 'POINT TEMPS/POPS',
            'PRELIM TEMPS/POPS', 'TEMPS / POPS', 'TEMP/POP', 'POINT TEMPS']) {
            expect(isTabularName(k)).toBe(true);
        }
    });
    it('matches no narrative header', () => {
        for (const k of ['SYNOPSIS', 'KEY MESSAGES', 'DISCUSSION', 'SHORT TERM', 'LONG TERM', 'AVIATION', 'MARINE',
            'BEACHES', 'FIRE WEATHER', 'CLIMATE', 'HYDROLOGY', 'WHAT HAS CHANGED', 'TEMPERATURES', 'Short Term', '']) {
            expect(isTabularName(k)).toBe(false);
        }
    });
});

describe('isTabularText: the shape, for an office that names its table differently', () => {
    it('catches the real MFL and HGX tables by shape alone', () => {
        expect(isTabularText(tableOf(MFL.productText))).toBe(true);
        expect(isTabularText(tableOf(HGX.productText))).toBe(true);
    });

    it('a data row has 3+ numeric cells and more numbers than words', () => {
        expect(isDataRow('Miami            73  81  73  82 /  70  50  50  40')).toBe(true);
        expect(isDataRow('College Station (CLL)  51  74  52  76 /   0   0   0   0')).toBe(true);
        expect(isDataRow('N Ft Lauderdale  73  80  73  81 /  80  70  50  50')).toBe(true);
        expect(isDataRow('Tampa       88 (2019)   89 (2015)')).toBe(true);
        expect(isDataRow('MinRH/MaxRH   25   80   30')).toBe(true);
        expect(isDataRow('Highs Thursday reach 78 to 82 with lows 62 to 65 inland.')).toBe(false);
        expect(isDataRow('Seas 8 to 12 feet, winds 25 to 30 kts with gusts to 35 kts.')).toBe(false);
        expect(isDataRow('                     TONIGHT  WED  WED NIGHT  THU')).toBe(false);
    });

    it('a renamed table with a header row and boilerplate is still a table', () => {
        const text = 'Issued at 300 PM CST Wed Nov 18 2026\n\n'
            + '                    Tonight  Thu  Thu Night  Fri\n'
            + 'Charleston SC         62      78     60       75 /  10  20  20  10\n'
            + 'Savannah GA           63      79     61       76 /  10  20  20  10\n'
            + 'Beaufort SC           61      77     59       74 /  10  20  10  10\n';
        expect(isTabularSection('CITY FORECASTS', text)).toBe(true);
    });

    it('prose, even number-heavy prose, is not a table', () => {
        const text = 'Highs Thursday will reach the upper 70s to near 80 with lows 62 to 65.\n'
            + 'Rain chances 20 to 30 percent Friday, 10 percent Saturday.\n'
            + 'Seas 4 to 6 ft in the Gulf and 8 to 12 ft in the Atlantic through Thursday.\n';
        expect(isTabularText(text)).toBe(false);
    });

    it('a discussion with a small table inside it stays prose (a table must be at least half the section)', () => {
        const prose = 'The ridge holds through the weekend and keeps the region dry with a light onshore breeze.\n';
        const text = prose.repeat(8)
            + 'Miami            73  81  73  82 /  70  50  50  40\n'
            + 'Naples           69  82  70  81 /  20  40  10  20\n';
        expect(isTabularText(text)).toBe(false);
    });

    it('needs two rows: a single numeric line is not a table', () => {
        expect(isTabularText('Miami 73 81 73 82 / 70 50 50 40')).toBe(false);
        expect(isTabularText('')).toBe(false);
        expect(isTabularText(undefined)).toBe(false);
    });
});

describe('the fixture corpus: every table caught, nothing else', () => {
    const all = corpus();

    it('covers the offices with tables (FFC, OUN, HGX, MFL)', () => {
        const withTable = all.filter(p => extractSections(p.text).some(s => s.key === TABLE_KEY));
        expect(withTable.length).toBeGreaterThanOrEqual(5);
    });

    for (const [parser, sectionsOf] of [
        ['server extractSections', (t) => extractSections(t)],
        ['client parseSections', (t) => parseSections(t).sections],
    ]) {
        it(`${parser}: the temps/pops table matches by name AND by shape; no other section matches either`, () => {
            const misses = [];
            for (const p of all) {
                for (const s of sectionsOf(p.text)) {
                    const isTable = /temps\/pops/i.test(s.key);
                    const name = isTabularName(s.key);
                    const shape = isTabularText(s.text);
                    if (isTable ? !(name && shape) : (name || shape)) misses.push(`${p.name}: ${s.key} name=${name} shape=${shape}`);
                }
            }
            expect(misses).toEqual([]);
        });
    }
});

describe('translatableSections: tables never get a model call', () => {
    it('drops the table from real MFL and HGX products and keeps every prose section', () => {
        expect(translatableSections(MFL.productText).map(s => s.key))
            .toEqual(['Messages', 'Short Term', 'Long Term', 'Aviation', 'Marine', 'Beaches']);
        expect(translatableSections(HGX.productText).map(s => s.key))
            .toEqual(['Messages', 'Discussion', 'Aviation', 'Marine']);
    });

    it('drops a renamed table by shape', () => {
        const rows = tableOf(MFL.productText);
        const text = MFL.productText.replace(`.${TABLE_KEY}...`, '.CITY FORECASTS...');
        expect(text).toContain(rows);
        expect(translatableSections(text).map(s => s.key)).not.toContain('City forecasts');
        expect(translatableSections(text).map(s => s.key)).toContain('Beaches');
    });

    it('an edition with every prose section translated is COMPLETE (the endpoint\'s and the poller\'s rule)', async () => {
        // Stored reuse text stands in for the model: no call is made.
        const sections = translatableSections(MFL.productText).map(s => ({ ...s, reused: `Summary of ${s.key}.` }));
        const payload = await translateEdition({
            office: 'MFL', id: MFL.id, issuanceTime: MFL.issuanceTime, productText: MFL.productText, sections,
        });
        expect(payload.complete).toBe(true);
        expect(Object.keys(payload.sections)).not.toContain('Preliminary point temps/pops');
        // The default selection is the same list.
        expect(translatableSections(MFL.productText)).toEqual(sections.map(({ key, text }) => ({ key, text })));
    });
});
