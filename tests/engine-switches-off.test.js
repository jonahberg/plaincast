// ─── Engine switches off = origin/main, byte for byte ──────────────
// The engine (api/cron-refresh.js, api/_store.js) adds four capabilities,
// each behind an environment switch that defaults OFF:
//   PLAINCAST_STORE_RENDER, PLAINCAST_PRETRANSLATE, PLAINCAST_AI_FOR_AGENTS
// (the poller itself is always safe to run). With every switch off, the
// office page and the homepage must answer exactly what origin/main did.
//
// The goldens in tests/fixtures/engine-golden/ were rendered by origin/main
// (25363cf) BEFORE the engine existed, from the fixed fixtures below, and
// regenerated once (2026-11-18) for intended switches-off changes only: the
// issuance time as data (<time datetime> in the dateline, dateModified in
// the WebPage JSON-LD, lifted into the head placeholder), the office count
// (68 → 123), and the office page's closing note losing its /?office= link
// (that URL now 308s back to the same page). Bodies
// are stored relative to the page shell (see `normalize`) and compared with
// the office count masked (`countFree`; it comes from OFFICE_NAMES), so a
// later, legitimate change to the shell or the office list does not break them;
// everything the handlers themselves write (the SSR digest, the boot block,
// the Markdown, every header) is compared exactly.
//
// Regenerate ONLY for an intended change to the switches-off output:
//   PLAINCAST_WRITE_GOLDEN=1 bun test tests/engine-switches-off.test.js
// and review the fixture diff.
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryBackend, recordFetches } from './shared-cache-backend.js';
import { OFFICE_NAMES } from '../docs/js/offices.js';

mock.module('ai', () => ({
    generateText: async () => { throw new Error('a page render must never call AI'); },
}));

let mockItems = [];
let mockProducts = {};
let mockListThrows = false;
// Bun module mocks are process-wide: stub every export of _utils.js.
mock.module('../api/_utils.js', () => ({
    fetchSevereAlerts: async () => [],
    fetchAlertTotals: async () => null,
    fetchSpcDy1: async () => null,
    fetchSpcOutlook: async () => null,
    fetchAlertById: async () => null,
    fetchAFDList: async () => { if (mockListThrows) throw new Error('NWS down'); return mockItems; },
    fetchAFDProduct: async (url) => {
        if (!(url in mockProducts)) throw new Error(`unexpected product url ${url}`);
        return mockProducts[url];
    },
    productUrlFromItem: (item) => item?.id || null,
}));

const { default: officeHandler, loadTemplate } = await import('../api/office-page.js');
const { default: homeHandler } = await import('../api/home.js');
const { renderOfficePage } = await import('../scripts/build-offices.mjs');
const { PROD_SCRIPT } = await import('../scripts/app-shell.mjs');
const shared = await import('../api/_shared-cache.js');
const { readRenderableEdition } = await import('../api/_store.js');
const { __setSharedCacheBackendForTests, translationKey, changelogKey, editionKey, pollStateKey, sectionKey, modelCallsKey } = shared;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_DIR = join(ROOT, 'tests', 'fixtures', 'engine-golden');
const WRITE = process.env.PLAINCAST_WRITE_GOLDEN === '1';

const SWITCHES = ['PLAINCAST_STORE_RENDER', 'PLAINCAST_PRETRANSLATE', 'PLAINCAST_AI_FOR_AGENTS'];
const savedEnv = Object.fromEntries(SWITCHES.map(k => [k, process.env[k]]));

const LOADING_DIV = '<div class="loading" id="loading">Setting the type…</div>';

const CURR = `000
FXUS66 KLOX 031140
AFDLOX

Area Forecast Discussion
National Weather Service Los Angeles/Oxnard CA
440 AM PDT Thu Jul 3 2026

.SYNOPSIS...03/440 AM.
Low clouds and fog will continue each night and morning with a chc of
drizzle near the csts through the weekend across the region.

&&

.SHORT TERM (Today through Saturday)...
Marine layer around 1500 feet deep this morning. A wknd warming trend
is expected as high pressure builds over the region with temps abv
normal in the vlys by Saturday afternoon and evening.

&&

.LONG TERM (Sunday through Wednesday)...
Models are in good agreement that troughing returns early next week
bringing a cooling trend and increasing onshore flow across the area.

&&

.AVIATION...03/1140Z. VFR.

$$
`;
const PREV = CURR.replace('A wknd warming trend', 'A modest cooling trend');
const CURR_ID = 'golden-curr-0001';
const PREV_ID = 'golden-prev-0001';
const CURR_TIME = '2026-07-03T11:40:00+00:00';
const PREV_TIME = '2026-07-03T05:38:00+00:00';

const COMPLETE_TI = {
    office: 'LOX', id: CURR_ID, issuanceTime: CURR_TIME, productText: CURR, complete: true,
    sections: {
        Synopsis: 'Low clouds and fog return **each night and morning**, with a chance of drizzle near the coast.',
        'Short Term': 'A **warming trend** this weekend, with valley highs above normal by **Saturday**.',
        'Long Term': 'A trough brings **cooler** weather early next week.',
        Aviation: 'Clear flying conditions.',
    },
};
const CHANGELOG = { office: 'LOX', id: CURR_ID, changelog: 'Warmer this weekend.', since: PREV_TIME, updated: CURR_TIME };

function scenario({ prev = true, down = false } = {}) {
    mockListThrows = down;
    mockItems = [{ id: CURR_ID }];
    mockProducts = { [CURR_ID]: { id: CURR_ID, productText: CURR, issuanceTime: CURR_TIME } };
    if (prev) {
        mockItems.push({ id: PREV_ID });
        mockProducts[PREV_ID] = { id: PREV_ID, productText: PREV, issuanceTime: PREV_TIME };
    }
}

function createRes() {
    return {
        statusCode: 200, headers: {}, body: null,
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
        getHeader(k) { return this.headers[k.toLowerCase()]; },
        status(c) { this.statusCode = c; return this; },
        json(d) { this.body = d; return this; },
        send(d) { this.body = d; return this; },
        end() { return this; },
    };
}

// A body relative to the shell it was rendered from: the shell bytes become
// placeholders, so the golden pins what the handler inserted and where.
// The one insertion into the shell's <head> (dateModified, the issuance
// time, in the page's WebPage JSON-LD) is lifted into the head placeholder.
const DATE_MODIFIED_LINE = /\n[ \t]*"dateModified": ("[^"\n]*"),(?=\n)/;
function normalize(body, shell) {
    if (typeof body !== 'string' || !body.startsWith('<!DOCTYPE')) return body;
    if (body === shell) return '<<SHELL>>';
    let headMark = '<<HEAD>>';
    const dm = body.match(DATE_MODIFIED_LINE);
    if (dm && !shell.includes(dm[0])) {
        body = body.replace(dm[0], '');
        headMark = `<<HEAD dateModified=${dm[1]}>>`;
    }
    const [head, tail] = shell.split(LOADING_DIV);
    if (!body.startsWith(head)) throw new Error('body does not start with the shell head');
    let rest = body.slice(head.length);
    const [mid, end] = tail.split(PROD_SCRIPT);
    const midAt = rest.indexOf(mid);
    if (midAt < 0) throw new Error('shell middle not found in body');
    const ssr = rest.slice(0, midAt);
    rest = rest.slice(midAt + mid.length);
    const scriptAt = rest.indexOf(PROD_SCRIPT);
    if (scriptAt < 0) throw new Error('app script not found in body');
    const inserted = rest.slice(0, scriptAt);
    if (rest.slice(scriptAt + PROD_SCRIPT.length) !== end) throw new Error('shell tail differs');
    return `${headMark}${ssr}<<MID>>${inserted}<<SCRIPT>><<TAIL>>`;
}

const officeShell = (query) => {
    let baked = renderOfficePage(loadTemplate(), 'LOX', 'Los Angeles');
    if (query.edition) {
        baked = baked
            .split('content="https://plaincast.live/api/og?office=LOX"')
            .join(`content="https://plaincast.live/api/og?office=LOX&amp;id=${query.edition}"`)
            .replace('<meta property="og:url" content="https://plaincast.live/o/LOX/">',
                `<meta property="og:url" content="https://plaincast.live/o/LOX/?edition=${query.edition}">`);
    }
    return baked;
};

// The office count is printed in the homepage copy ("every one of the 123
// forecast offices"); it comes from OFFICE_NAMES. The goldens were rendered
// with 123; while that holds, bodies are compared byte for byte.
const GOLDEN_OFFICES = 123;
const countFree = (body) => (typeof body === 'string' ? body.replace(/\b\d+ forecast offices\b/g, '<<N>> forecast offices') : body);

const CASES = [
    { name: 'office-html', page: 'office', query: { code: 'LOX' } },
    { name: 'office-html-translated', page: 'office', query: { code: 'LOX' }, seed: true },
    { name: 'office-html-no-prev', page: 'office', query: { code: 'LOX' }, prev: false },
    { name: 'office-html-edition', page: 'office', query: { code: 'LOX', edition: 'a1b2c3d4-5566-7788-99aa-bbccddeeff00' } },
    { name: 'office-html-down', page: 'office', query: { code: 'LOX' }, down: true },
    { name: 'office-md', page: 'office', query: { code: 'LOX' }, accept: 'text/markdown' },
    { name: 'office-md-translated', page: 'office', query: { code: 'LOX' }, accept: 'text/markdown', seed: true },
    { name: 'office-md-down', page: 'office', query: { code: 'LOX' }, accept: 'text/markdown', down: true },
    { name: 'home-html', page: 'home', query: {} },
    { name: 'home-html-translated', page: 'home', query: {}, seed: true },
    { name: 'home-html-down', page: 'home', query: {}, down: true },
    { name: 'home-md', page: 'home', query: {}, accept: 'text/markdown' },
    { name: 'home-md-translated', page: 'home', query: {}, accept: 'text/markdown', seed: true },
    { name: 'home-md-down', page: 'home', query: {}, accept: 'text/markdown', down: true },
];

async function render(c, backend) {
    scenario({ prev: c.prev !== false, down: Boolean(c.down) });
    if (c.seed) {
        backend.seed(translationKey('LOX', CURR_ID), COMPLETE_TI);
        backend.seed(changelogKey('LOX', CURR_ID), CHANGELOG);
    }
    const res = createRes();
    const req = { method: 'GET', query: c.query, headers: c.accept ? { accept: c.accept } : {} };
    await (c.page === 'office' ? officeHandler : homeHandler)(req, res);
    const shell = c.page === 'office' ? officeShell(c.query) : loadTemplate();
    return {
        status: res.statusCode,
        headers: Object.fromEntries(Object.entries(res.headers).sort(([a], [b]) => a.localeCompare(b))),
        body: normalize(res.body, shell),
    };
}

describe('engine switches off: office page and homepage are origin/main, byte for byte', () => {
    let backend;
    let fetches;
    beforeEach(() => {
        for (const k of SWITCHES) delete process.env[k];
        backend = memoryBackend();
        __setSharedCacheBackendForTests(backend);
        fetches = recordFetches();
    });
    afterEach(() => {
        fetches.restore();
        __setSharedCacheBackendForTests(null);
        for (const k of SWITCHES) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
    });

    for (const c of CASES) {
        it(`${c.name} matches the origin/main golden`, async () => {
            const got = await render(c, backend);
            const file = join(GOLDEN_DIR, `${c.name}.json`);
            if (WRITE) {
                mkdirSync(GOLDEN_DIR, { recursive: true });
                writeFileSync(file, `${JSON.stringify(got, null, 2)}\n`);
            }
            expect(existsSync(file)).toBe(true);
            const golden = JSON.parse(readFileSync(file, 'utf8'));
            expect(got.status).toBe(golden.status);
            expect(got.headers).toEqual(golden.headers);
            expect(countFree(got.body)).toBe(countFree(golden.body));
            // Byte for byte while the office list is the one the goldens saw.
            if (Object.keys(OFFICE_NAMES).length === GOLDEN_OFFICES) expect(got.body).toBe(golden.body);
            // A render makes no HTTP call of its own (NWS is module-mocked).
            expect(fetches.calls).toEqual([]);
        });

        it(`${c.name}: a full, fresh engine store changes nothing while the switches are off`, async () => {
            // A heartbeat from now and a stored edition whose text differs from
            // NWS's: if any switch-off path read it, the body would change.
            const at = new Date().toISOString();
            const other = CURR.replace('Low clouds and fog', 'STORED EDITION TEXT');
            backend.seed(pollStateKey(), {
                v: 1, at, fullAt: at,
                offices: { LOX: { id: CURR_ID, issuanceTime: CURR_TIME, prevId: PREV_ID, stored: CURR_ID, storedPrev: PREV_ID, purge: { id: CURR_ID, n: 2 } } },
            });
            backend.seed(editionKey('LOX'), {
                v: 1, office: 'LOX',
                current: { id: CURR_ID, issuanceTime: CURR_TIME, productText: other, storedAt: at, prevId: PREV_ID },
                previous: { id: PREV_ID, issuanceTime: PREV_TIME, productText: PREV },
            });
            backend.seed(sectionKey('LOX', 'a'.repeat(64)), { office: 'LOX', key: 'Synopsis', hash: 'a'.repeat(64), text: 'x' });
            backend.seed(modelCallsKey('2026-07-03'), { day: '2026-07-03', calls: 1 });
            // The seed is genuinely renderable: with PLAINCAST_STORE_RENDER=1
            // the page WOULD come from it (and carry the stored text).
            const renderable = await readRenderableEdition('LOX');
            expect(renderable?.current.productText).toBe(other);
            expect(renderable?.previous?.id).toBe(PREV_ID);
            backend.reads.length = 0;
            const got = await render(c, backend);
            const golden = JSON.parse(readFileSync(join(GOLDEN_DIR, `${c.name}.json`), 'utf8'));
            expect({ ...got, body: countFree(got.body) }).toEqual({ ...golden, body: countFree(golden.body) });
            for (const key of backend.reads) expect(key).toMatch(/^(ti|cl):/);
            expect(backend.writes).toEqual([]);
            expect(fetches.calls).toEqual([]);
        });
    }

    it('control: the same seed with PLAINCAST_STORE_RENDER=1 does change the page', async () => {
        const at = new Date().toISOString();
        backend.seed(pollStateKey(), {
            v: 1, at, fullAt: at,
            offices: { LOX: { id: CURR_ID, issuanceTime: CURR_TIME, prevId: PREV_ID, stored: CURR_ID, storedPrev: PREV_ID, purge: { id: CURR_ID, n: 2 } } },
        });
        backend.seed(editionKey('LOX'), {
            v: 1, office: 'LOX',
            current: { id: CURR_ID, issuanceTime: CURR_TIME, productText: CURR.replace('Low clouds and fog', 'STORED EDITION TEXT'), storedAt: at, prevId: PREV_ID },
            previous: { id: PREV_ID, issuanceTime: PREV_TIME, productText: PREV },
        });
        process.env.PLAINCAST_STORE_RENDER = '1';
        const got = await render(CASES[0], backend);
        expect(got.body).toContain('STORED EDITION TEXT');
    });
});
