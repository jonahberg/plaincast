// The page functions with the engine's switches ON:
//   PLAINCAST_STORE_RENDER=1   render from the edition store, zero NWS calls
//   PLAINCAST_AI_FOR_AGENTS=1  AI text in <main> and in the Markdown twin
// (switches off = origin/main: tests/engine-switches-off.test.js).
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { memoryBackend, recordFetches } from './shared-cache-backend.js';

mock.module('ai', () => ({
    generateText: async () => { throw new Error('a page render must never call AI'); },
}));

let mockItems = [];
let mockProducts = {};
let mockListThrows = false;
let nwsCalls = [];
// Bun module mocks are process-wide: stub every export of _utils.js.
mock.module('../api/_utils.js', () => ({
    fetchSevereAlerts: async () => [],
    fetchAlertTotals: async () => null,
    fetchSpcDy1: async () => null,
    fetchSpcOutlook: async () => null,
    fetchAlertById: async () => null,
    fetchAFDList: async (code) => { nwsCalls.push(`list:${code}`); if (mockListThrows) throw new Error('NWS down'); return mockItems; },
    fetchAFDProduct: async (url) => {
        nwsCalls.push(`product:${url}`);
        if (!(url in mockProducts)) throw new Error(`unexpected product url ${url}`);
        return mockProducts[url];
    },
    productUrlFromItem: (item) => item?.id || null,
}));

const { default: officeHandler, aiForSections, STORE_CACHE, CACHE_TAG_HEADER } = await import('../api/office-page.js');
const { default: homeHandler } = await import('../api/home.js');
const { SHORT_CACHE } = await import('../api/_boot.js');
const { aiParagraphs, aiMarkdownParagraphs } = await import('../api/_ai-text.js');
const { formatTranslationHTML } = await import('../shadcn/src/lib/ai.js');
const { PREAMBLE_AI, PREAMBLE_NO_AI, AI_LABEL_MD, NWS_LABEL_MD, HOME_NO_AI } = await import('../api/_edition-markdown.js');
const {
    __setSharedCacheBackendForTests, translationKey, changelogKey, editionKey, pollStateKey,
} = await import('../api/_shared-cache.js');

const SWITCHES = ['PLAINCAST_STORE_RENDER', 'PLAINCAST_PRETRANSLATE', 'PLAINCAST_AI_FOR_AGENTS'];
const savedEnv = Object.fromEntries(SWITCHES.map(k => [k, process.env[k]]));
const setSwitches = (on) => {
    for (const k of SWITCHES) delete process.env[k];
    for (const k of on) process.env[k] = '1';
};

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
const CURR_ID = 'store-curr-1';
const PREV_ID = 'store-prev-1';
const CURR_TIME = '2026-07-03T11:40:00+00:00';
const PREV_TIME = '2026-07-03T05:38:00+00:00';

const AI_SECTIONS = {
    Synopsis: 'Low clouds and fog return **each night and morning**, with a chance of drizzle near the coast.',
    'Short Term': 'A **warming trend** this weekend.\n\nValley highs run above normal by **Saturday**.',
    'Long Term': 'A trough brings **cooler** weather early next week.',
    Aviation: 'Clear flying conditions.',
};
const completeTi = (over = {}) => ({
    office: 'LOX', id: CURR_ID, issuanceTime: CURR_TIME, productText: CURR, complete: true, sections: AI_SECTIONS, ...over,
});

function liveScenario({ prev = true } = {}) {
    mockListThrows = false;
    mockItems = [{ id: CURR_ID }];
    mockProducts = { [CURR_ID]: { id: CURR_ID, productText: CURR, issuanceTime: CURR_TIME } };
    if (prev) {
        mockItems.push({ id: PREV_ID });
        mockProducts[PREV_ID] = { id: PREV_ID, productText: PREV, issuanceTime: PREV_TIME };
    }
}

function seedStore(backend, { at = new Date().toISOString(), prev = true, seenId = CURR_ID, office = 'LOX', text = CURR, purged = true } = {}) {
    backend.seed(pollStateKey(), {
        v: 1, at, fullAt: at,
        offices: { [office]: { id: seenId, issuanceTime: CURR_TIME, prevId: PREV_ID, stored: CURR_ID, storedPrev: prev ? PREV_ID : null, ...(purged ? { purge: { id: seenId, n: 1 } } : {}) } },
    });
    backend.seed(editionKey(office), {
        v: 1, office,
        current: { id: CURR_ID, issuanceTime: CURR_TIME, productText: text, storedAt: at, prevId: PREV_ID },
        previous: prev ? { id: PREV_ID, issuanceTime: PREV_TIME, productText: PREV } : null,
    });
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
async function get(handler, query, accept) {
    const res = createRes();
    await handler({ method: 'GET', query, headers: accept ? { accept } : {} }, res);
    return res;
}
const office = (accept, query = { code: 'LOX' }) => get(officeHandler, query, accept);
const home = (accept, query = {}) => get(homeHandler, query, accept);
const mainOf = (html) => html.slice(html.indexOf('<main'), html.indexOf('</main>'));

let backend;
let fetches;
beforeEach(() => {
    backend = memoryBackend();
    __setSharedCacheBackendForTests(backend);
    fetches = recordFetches();
    nwsCalls = [];
    liveScenario();
});
afterEach(() => {
    fetches.restore();
    __setSharedCacheBackendForTests(null);
    for (const k of SWITCHES) {
        if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
});

describe('PLAINCAST_STORE_RENDER=1: office page', () => {
    beforeEach(() => setSwitches(['PLAINCAST_STORE_RENDER']));

    it('renders from the store with zero NWS calls, the same page the live path renders', async () => {
        // The live page for the same edition (switch off).
        setSwitches([]);
        const live = await office();
        setSwitches(['PLAINCAST_STORE_RENDER']);
        seedStore(backend);
        nwsCalls = [];
        const res = await office();
        expect(nwsCalls).toEqual([]);
        expect(fetches.calls).toEqual([]);
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe(live.body);
        expect(res.body).toContain('Revised in 1 passage since the 10:38 PM discussion.');
        // No translation yet: the existing short policy, plus the office tag.
        expect(res.headers['cache-control']).toBe(SHORT_CACHE);
        expect(res.headers[CACHE_TAG_HEADER.toLowerCase()]).toBe('office-LOX');
        expect(res.headers.vary).toContain('Accept');
    });

    it('a complete translation → the store policy (5 min), still tagged', async () => {
        seedStore(backend);
        backend.seed(translationKey('LOX', CURR_ID), completeTi());
        const res = await office();
        expect(nwsCalls).toEqual([]);
        expect(res.headers['cache-control']).toBe(STORE_CACHE);
        expect(STORE_CACHE).toBe('public, s-maxage=300, stale-while-revalidate=3600');
        // The boot block carries the stored translation, as on the live path.
        expect(res.body).toContain('"translationsComplete":true');
    });

    it('Markdown from the store: zero NWS calls, the same body as live', async () => {
        setSwitches([]);
        const live = await office('text/markdown');
        setSwitches(['PLAINCAST_STORE_RENDER']);
        seedStore(backend);
        nwsCalls = [];
        const res = await office('text/markdown');
        expect(nwsCalls).toEqual([]);
        expect(res.body).toBe(live.body);
        expect(res.headers['cache-control']).toBe(STORE_CACHE);
        expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
    });

    it('no stored predecessor → the changelog line is omitted', async () => {
        seedStore(backend, { prev: false });
        const res = await office();
        expect(nwsCalls).toEqual([]);
        expect(res.body).not.toContain('Revised in');
        expect(res.body).toContain('<article class="forecast-section ssr">');
    });

    it('no successful purge for this edition → the live path with today\'s cache policy', async () => {
        seedStore(backend, { purged: false });
        const res = await office();
        expect(nwsCalls[0]).toBe('list:LOX');
        expect(res.headers['cache-control']).toBe(SHORT_CACHE);
        backend.seed(translationKey('LOX', CURR_ID), completeTi());
        const full = await office();
        expect(full.headers['cache-control']).toBe('public, s-maxage=900, stale-while-revalidate=3600');
    });

    it('stale heartbeat → the live path', async () => {
        seedStore(backend, { at: new Date(Date.now() - 11 * 60 * 1000).toISOString() });
        const res = await office();
        expect(nwsCalls[0]).toBe('list:LOX');
        expect(res.headers['cache-control']).toBe(SHORT_CACHE);
        expect(res.headers[CACHE_TAG_HEADER.toLowerCase()]).toBe('office-LOX');
    });

    it('store miss → the live path', async () => {
        const res = await office();
        expect(nwsCalls[0]).toBe('list:LOX');
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('Low clouds and fog');
    });

    it('a newer issuance seen but not yet stored → the live path', async () => {
        seedStore(backend, { seenId: 'newer-id' });
        await office();
        expect(nwsCalls[0]).toBe('list:LOX');
    });

    it('a failing store → the live path, no error to the reader', async () => {
        __setSharedCacheBackendForTests({ get: async () => { throw new Error('down'); }, set: async () => {} });
        const res = await office();
        expect(res.statusCode).toBe(200);
        expect(nwsCalls[0]).toBe('list:LOX');
    });

    it('store miss AND NWS down → the exact baked page, tagged', async () => {
        mockListThrows = true;
        const res = await office();
        expect(res.headers['cache-control']).toBe('public, s-maxage=300');
        expect(res.body).toContain('Setting the type…');
        expect(res.headers[CACHE_TAG_HEADER.toLowerCase()]).toBe('office-LOX');
    });

    it('another office\'s stored edition is never served for this one', async () => {
        seedStore(backend, { office: 'OKX' });
        await office();
        expect(nwsCalls[0]).toBe('list:LOX');
    });
});

describe('PLAINCAST_STORE_RENDER=1: homepage', () => {
    beforeEach(() => setSwitches(['PLAINCAST_STORE_RENDER']));

    it('renders the default office from the store, tagged office + home', async () => {
        setSwitches([]);
        const live = await home();
        setSwitches(['PLAINCAST_STORE_RENDER']);
        seedStore(backend);
        nwsCalls = [];
        const res = await home();
        expect(nwsCalls).toEqual([]);
        expect(res.body).toBe(live.body);
        expect(res.headers[CACHE_TAG_HEADER.toLowerCase()]).toBe('office-LOX,home');
        const md = await home('text/markdown');
        expect(nwsCalls).toEqual([]);
        expect(md.headers['cache-control']).toBe(STORE_CACHE);
    });

    it('?office= is tagged with that office; a store miss goes live', async () => {
        const res = await home(undefined, { office: 'OKX' });
        expect(res.headers[CACHE_TAG_HEADER.toLowerCase()]).toBe('office-OKX,home');
        expect(nwsCalls[0]).toBe('list:OKX');
    });
});

describe('PLAINCAST_AI_FOR_AGENTS=1', () => {
    beforeEach(() => setSwitches(['PLAINCAST_AI_FOR_AGENTS']));

    it('HTML: each section leads with the labelled AI text; the NWS text stays, labelled as the original', async () => {
        backend.seed(translationKey('LOX', CURR_ID), completeTi());
        const res = await office();
        const main = mainOf(res.body);
        // AI paragraphs, formatted as the app's Plain English tab.
        expect(main).toContain('<p>Low clouds and fog return <strong>each night and morning</strong>, with a chance of drizzle near the coast.</p>');
        expect(main).toContain('<p>A <strong>warming trend</strong> this weekend.</p>');
        expect(main).toContain('<p>Valley highs run above normal by <strong>Saturday</strong>.</p>');
        // Every rendered section is attributed, and keeps the NWS text in a closed <details>.
        const articles = main.split('<article class="forecast-section ssr">').slice(1);
        expect(articles.length).toBe(3);
        for (const a of articles) {
            expect(a).toContain('<p class="ssr-ai-label"><small>Plain-English summary written by AI (Claude) from the National Weather Service text below.</small></p>');
            expect(a).toMatch(/<details class="ssr-original">\n {16}<summary>The original: National Weather Service text, shorthand expanded<\/summary>/);
            expect(a.indexOf('ssr-ai-label')).toBeLessThan(a.indexOf('<details'));
        }
        expect(main).toContain('temperatures above normal in the valleys'); // the NWS text, regex-expanded
        expect(main).not.toContain('decoded without AI');
        expect(main).toContain('opens with a plain-English summary written by AI (Claude)');
        // Machine-readable issuance time, in the dateline and the JSON-LD.
        expect(main).toContain(`issued <time datetime="${CURR_TIME}">`);
        expect(res.body).toContain(`"dateModified": "${CURR_TIME}",`);
        const ld = res.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)
            .map(s => JSON.parse(s.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')))
            .find(d => d['@type'] === 'WebPage');
        expect(ld.dateModified).toBe(CURR_TIME);
        // Complete translation: the normal window.
        expect(res.headers['cache-control']).toBe('public, s-maxage=900, stale-while-revalidate=3600');
        // The main H1 is still there (heading rule).
        expect(main).toContain('<h1 class="sr-only">');
    });

    it('Markdown: the preamble says AI is included; each section is AI summary, then the labelled original', async () => {
        backend.seed(translationKey('LOX', CURR_ID), completeTi());
        const res = await office('text/markdown');
        expect(res.body).toContain(PREAMBLE_AI);
        expect(res.body).not.toContain(PREAMBLE_NO_AI);
        expect(res.body).toContain(`issued Friday, July 3 at 4:40 AM PDT (${CURR_TIME}).`);
        const sections = res.body.split(/^## /m).slice(1);
        expect(sections.length).toBe(3);
        for (const s of sections) {
            const ai = s.indexOf(AI_LABEL_MD);
            const nws = s.indexOf(NWS_LABEL_MD);
            expect(ai).toBeGreaterThan(-1);
            expect(nws).toBeGreaterThan(ai);
        }
        expect(sections[1]).toContain('A **warming trend** this weekend.\n\nValley highs run above normal by **Saturday**.');
        expect(sections[1].slice(sections[1].indexOf(NWS_LABEL_MD))).toContain('temperatures above normal in the valleys');
        // A store read for the translation, never a model call or an HTTP call.
        expect(backend.reads).toContain(translationKey('LOX', CURR_ID));
        expect(fetches.calls).toEqual([]);
        expect(res.headers['cache-control']).toBe('public, s-maxage=900, stale-while-revalidate=3600');
    });

    it('no complete translation → today\'s page and Markdown, said so, regenerated soon', async () => {
        for (const seed of [null, completeTi({ complete: false }), completeTi({ id: 'other' }), completeTi({ productText: PREV }),
            completeTi({ sections: { Synopsis: 'x' } }), completeTi({ sections: { ...AI_SECTIONS, 'Long Term': '   ' } })]) {
            backend.store.clear();
            if (seed) backend.seed(translationKey('LOX', CURR_ID), seed);
            const html = await office();
            expect(html.body).not.toContain('ssr-ai-label');
            expect(html.body).not.toContain('<details class="ssr-original">');
            expect(mainOf(html.body)).toContain('decoded without AI');
            expect(html.headers['cache-control']).toBe(SHORT_CACHE);
            const md = await office('text/markdown');
            expect(md.body).toContain(PREAMBLE_NO_AI);
            expect(md.body).not.toContain(AI_LABEL_MD);
            expect(md.headers['cache-control']).toBe(SHORT_CACHE);
        }
    });

    it('a render never calls the model or the translate endpoint', async () => {
        // `ai` is mocked to throw, and every HTTP call is recorded.
        for (const accept of [undefined, 'text/markdown']) {
            const res = await office(accept);
            expect(res.statusCode).toBe(200);
        }
        expect(fetches.calls).toEqual([]);
    });

    it('homepage: AI text in the first two sections, the standfirst and note say so; Markdown labelled', async () => {
        backend.seed(translationKey('LOX', CURR_ID), completeTi());
        const res = await home();
        const main = mainOf(res.body);
        expect(main.match(/class="ssr-ai-label"/g).length).toBe(2);
        expect(main).toContain('each section opens with a plain-English summary written by AI (Claude)');
        expect(main).toContain('Each summary above is written by AI (Claude)');
        expect(main).not.toContain('decoded without AI');
        expect(main).toContain(`<time datetime="${CURR_TIME}">`);
        const md = await home('text/markdown');
        expect(md.body).toContain(PREAMBLE_AI);
        expect(md.body.match(new RegExp(AI_LABEL_MD.replace(/[*()]/g, '\\$&'), 'g')).length).toBe(2);

        backend.store.clear();
        const plain = await home('text/markdown');
        expect(plain.body).toContain(HOME_NO_AI);
        expect(plain.body).not.toContain(AI_LABEL_MD);
    });

    it('with the store switch too: AI text from the store with zero NWS calls', async () => {
        setSwitches(['PLAINCAST_AI_FOR_AGENTS', 'PLAINCAST_STORE_RENDER']);
        seedStore(backend);
        backend.seed(translationKey('LOX', CURR_ID), completeTi());
        backend.seed(changelogKey('LOX', CURR_ID), { office: 'LOX', id: CURR_ID, changelog: 'Warmer.', since: PREV_TIME, updated: CURR_TIME });
        const res = await office();
        expect(nwsCalls).toEqual([]);
        expect(res.body).toContain('ssr-ai-label');
        expect(res.headers['cache-control']).toBe(STORE_CACHE);
    });
});

describe('later switches with the poller not running', () => {
    it('store render + AI for agents, no poll state at all: the live path, with AI from an on-demand translation', async () => {
        setSwitches(['PLAINCAST_STORE_RENDER', 'PLAINCAST_AI_FOR_AGENTS']);
        backend.seed(translationKey('LOX', CURR_ID), completeTi()); // written by a reader's /api/translate-issuance
        const res = await office();
        expect(nwsCalls[0]).toBe('list:LOX');
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('ssr-ai-label');
        expect(res.headers['cache-control']).toBe('public, s-maxage=900, stale-while-revalidate=3600');
        const md = await office('text/markdown');
        expect(md.body).toContain(PREAMBLE_AI);
    });
});

describe('aiForSections: the join is exact or nothing', () => {
    it('joins through the display key (NEAR TERM → "Short Term")', () => {
        const text = CURR.replace('.SHORT TERM (Today through Saturday)...', '.NEAR TERM (Today through Saturday)...');
        const ai = aiForSections(text, completeTi({ productText: text }), 'LOX', CURR_ID);
        expect([...ai.keys()]).toEqual(['SYNOPSIS', 'NEAR TERM', 'LONG TERM']);
        expect(ai.get('NEAR TERM')).toBe(AI_SECTIONS['Short Term']);
    });

    // Nov 18 2026: a NEAR TERM beside a SHORT TERM is "Near Term" (it used to
    // share "Short Term", and the map could hold only one of them).
    it('NEAR TERM beside SHORT TERM joins under its own key, "Near Term"', () => {
        const text = CURR.replace('.LONG TERM (Sunday through Wednesday)...',
            '.NEAR TERM...\nA second short-term discussion that is long enough to render here today.\n\n&&\n\n.LONG TERM (Sunday through Wednesday)...');
        const sections = { ...AI_SECTIONS, 'Near Term': 'A second short-term summary.' };
        const ai = aiForSections(text, completeTi({ productText: text, sections }), 'LOX', CURR_ID);
        expect([...ai.keys()]).toEqual(['SYNOPSIS', 'SHORT TERM', 'NEAR TERM', 'LONG TERM']);
        expect(ai.get('SHORT TERM')).toBe(AI_SECTIONS['Short Term']);
        expect(ai.get('NEAR TERM')).toBe('A second short-term summary.');
        // a map without the Near Term translation is not complete for this page
        expect(aiForSections(text, completeTi({ productText: text }), 'LOX', CURR_ID)).toBe(null);
    });

    it('a rendered section with no translatable twin (too long to translate) → no AI', () => {
        const long = 'Very long discussion text that keeps going. '.repeat(240);
        const text = CURR.replace('Models are in good agreement', `${long}Models are in good agreement`);
        expect(aiForSections(text, completeTi({ productText: text }), 'LOX', CURR_ID)).toBe(null);
    });

    it('limit checks only the sections the homepage renders', () => {
        const ai = aiForSections(CURR, completeTi({ sections: { Synopsis: 'a', 'Short Term': 'b' } }), 'LOX', CURR_ID, 2);
        expect([...ai.keys()]).toEqual(['SYNOPSIS', 'SHORT TERM']);
        expect(aiForSections(CURR, completeTi({ sections: { Synopsis: 'a', 'Short Term': 'b' } }), 'LOX', CURR_ID)).toBe(null);
    });

    it('rejects an entry for another office, edition or text, or not complete', () => {
        for (const e of [null, completeTi({ office: 'OKX' }), completeTi({ id: 'x' }), completeTi({ complete: false }),
            completeTi({ productText: undefined }), completeTi({ sections: [] })]) {
            expect(aiForSections(CURR, e, 'LOX', CURR_ID)).toBe(null);
        }
    });
});

describe('AI text formatting', () => {
    it('the SSR paragraphs are exactly the app\'s Plain English HTML', () => {
        for (const raw of [
            AI_SECTIONS['Short Term'],
            '## Header\nText with **bold** & <tags> and `code`.\n\n\n---\nKey Message 1. Second para\nwrapped.',
            'One line only.',
        ]) {
            expect(aiParagraphs(raw).map(p => `<p>${p}</p>`).join('')).toBe(formatTranslationHTML(raw));
        }
    });

    it('Markdown paragraphs cannot open a block the page did not mean', () => {
        expect(aiMarkdownParagraphs('> quoted\n\n1. one\n\n- dash\n\n**Bold** start\n\n<b>x</b> then\nwrap'))
            .toEqual(['\\> quoted', '1\\. one', '\\- dash', '**Bold** start', '&lt;b>x&lt;/b> then wrap']);
    });
});

// Tables are never AI-translated (docs/js/tabular.js). A translation set
// stored before that rule existed can still hold model text for one; the
// server-rendered page and its Markdown must never show it, and the table
// must not cost the other sections their AI text.
describe('PLAINCAST_AI_FOR_AGENTS=1: a stored translation of a table is never shown', () => {
    beforeEach(() => setSwitches(['PLAINCAST_AI_FOR_AGENTS']));

    // Real MFL prose and table rows (api.weather.gov, 2026-11-18), under
    // headers no rule names: no narrative key, so the digest falls back to
    // "any substantial section", which used to include the 508-char table.
    const { readFileSync } = require('node:fs');
    const MFL = JSON.parse(readFileSync(new URL('./fixtures/afd/live-2026-11-18/MFL.json', import.meta.url), 'utf8'));
    const { extractSections } = require('../api/_afd-sections.js');
    const real = Object.fromEntries(extractSections(MFL.productText).map(s => [s.key, s.text]));
    const TEXT = `000\nFXUS62 KMFL 182343\nAFDMFL\n\nArea Forecast Discussion\nNational Weather Service Miami FL\n643 PM EST Wed Nov 18 2026\n\n`
        + `.FORECAST REASONING...\n${real['LONG TERM']}\n\n&&\n\n`
        + `.CITY FORECASTS...\n${real['PRELIMINARY POINT TEMPS/POPS']}\n\n&&\n\n$$\n`;
    const ID = 'mfl-table-1';
    const STALE = 'Miami sees highs of 81 and lows of 73 STALE-TABLE-PROSE';
    const preChangeSet = {
        office: 'MFL', id: ID, issuanceTime: MFL.issuanceTime, productText: TEXT, complete: true,
        sections: { 'Forecast reasoning': 'Drier air arrives for the **weekend** after one more wet day.', 'City forecasts': STALE },
    };

    beforeEach(() => {
        mockItems = [{ id: ID }];
        mockProducts = { [ID]: { id: ID, productText: TEXT, issuanceTime: MFL.issuanceTime } };
        backend.seed(translationKey('MFL', ID), preChangeSet);
    });

    it('HTML: the prose section keeps its labelled AI text; the table and its stale text are not rendered', async () => {
        const res = await office(undefined, { code: 'MFL' });
        const main = mainOf(res.body);
        expect(main.match(/<article class="forecast-section ssr">/g).length).toBe(1);
        expect(main).toContain('<h2 class="section-title">Forecast Reasoning</h2>');
        expect(main).toContain('Drier air arrives for the <strong>weekend</strong> after one more wet day.');
        expect(main).toContain('ssr-ai-label');
        expect(res.body).not.toContain('STALE-TABLE-PROSE');
        expect(main).not.toContain('West Kendall');
        // The app's boot data keeps the prose translation and drops the table's.
        const boot = JSON.parse(res.body.match(/<script type="application\/json" id="plaincast-boot">([^<]*)<\/script>/)[1]);
        expect(Object.keys(boot.translations)).toEqual(['Forecast reasoning']);
        expect(boot.translationsComplete).toBe(true);
        // The set counts as complete: the normal window, not the "AI pending" one.
        expect(res.headers['cache-control']).toBe('public, s-maxage=900, stale-while-revalidate=3600');
    });

    it('Markdown: the same', async () => {
        const res = await office('text/markdown', { code: 'MFL' });
        expect(res.body).toContain(PREAMBLE_AI);
        expect(res.body).toContain('Drier air arrives for the **weekend** after one more wet day.');
        expect(res.body).not.toContain('STALE-TABLE-PROSE');
        expect(res.body).not.toContain('West Kendall');
        expect(res.body.split(/^## /m).length - 1).toBe(1);
    });

    it('the homepage for that office: the same', async () => {
        for (const accept of [undefined, 'text/markdown']) {
            const res = await home(accept, { office: 'MFL' });
            expect(res.body).not.toContain('STALE-TABLE-PROSE');
            expect(res.body).toContain('Drier air arrives');
        }
    });
});
