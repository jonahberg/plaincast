// ─── /api/feed: the "what changed" delta feed ───────────────────────
// Each item gets a unique per-edition permalink (feed readers dedupe
// items that share a link), a title disambiguated by issuance local
// time, and a description that leads with the paragraph-level delta
// against the previous issuance — pure text diff, zero AI spend.

import { describe, it, expect, mock } from 'bun:test';

let mockItems = [];
let mockProducts = {};
mock.module('../api/_utils.js', () => ({
    fetchAlertById: async () => null,
    fetchAFDList: async () => mockItems,
    fetchAFDProduct: async (url) => mockProducts[url] || {},
    productUrlFromItem: (item) => item?.id || null,
}));
// feed.js imports changedParagraphs from changelog.js, which imports the AI
// SDK at module scope. Keep it inert — the feed must never call the model.
mock.module('ai', () => ({
    generateText: async () => { throw new Error('the feed must never call AI'); },
}));

const { default: feedHandler } = await import('../api/feed.js');

function createRes() {
    return {
        statusCode: 200, headers: {}, body: null, ended: false,
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(d) { this.body = d; this.ended = true; return this; },
        send(d) { this.body = d; this.ended = true; return this; },
        end() { this.ended = true; return this; },
    };
}
const createReq = (o = {}) => ({ method: 'GET', query: {}, ...o });

// Minimal but realistic classic-format AFD: WMO telegraph header + mast
// (both change every issuance) + SYNOPSIS + SHORT TERM.
function afd({ wmoTime, mastTime, synopsis, shortTerm }) {
    return `000
FXUS61 KOKX ${wmoTime}
AFDOKX

Area Forecast Discussion
National Weather Service New York NY
${mastTime}

.SYNOPSIS...
${synopsis}

&&

.SHORT TERM /THROUGH SATURDAY/...
${shortTerm}

&&

$$
`;
}

const SYNOPSIS_A = 'High pressure keeps the region dry and mild through the weekend with light winds and seasonable temperatures across the entire area.';
const SHORT_TERM_A = 'Dry weather continues today with highs in the mid 80s and comfortable humidity levels for early July across the region.';
const SHORT_TERM_B = 'A severe thunderstorm watch is now in effect for the entire area this evening as storms develop along an approaching cold front with damaging winds possible.';

// Newest first, matching the NWS list order.
function setFeedScenario(office, editions) {
    mockItems = editions.map(e => ({ id: e.id }));
    mockProducts = Object.fromEntries(editions.map(e => [e.id, {
        productText: e.text,
        issuanceTime: e.issuanceTime,
    }]));
    return { office };
}

function itemBlocks(rss) {
    return [...rss.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
}
function itemLinks(rss) {
    return itemBlocks(rss).map(b => b.match(/<link>([\s\S]*?)<\/link>/)[1]);
}
function itemTitles(rss) {
    return itemBlocks(rss).map(b => b.match(/<title>([\s\S]*?)<\/title>/)[1]);
}
function itemDescriptions(rss) {
    return itemBlocks(rss).map(b => b.match(/<description>([\s\S]*?)<\/description>/)[1]);
}

// Two same-day OKX issuances where the SHORT TERM was rewritten.
function twoEditionScenario() {
    return setFeedScenario('OKX', [
        {
            id: 'okx-350pm', issuanceTime: '2026-07-03T19:50:00+00:00',
            text: afd({ wmoTime: '031950', mastTime: '350 PM EDT Fri Jul 3 2026', synopsis: SYNOPSIS_A, shortTerm: SHORT_TERM_B }),
        },
        {
            id: 'okx-739am', issuanceTime: '2026-07-03T11:39:00+00:00',
            text: afd({ wmoTime: '031139', mastTime: '739 AM EDT Fri Jul 3 2026', synopsis: SYNOPSIS_A, shortTerm: SHORT_TERM_A }),
        },
    ]);
}

describe('GET /api/feed — unique per-edition permalinks', () => {
    it('every item links to its own /o/CODE/?edition= permalink (no reader dedupe)', async () => {
        twoEditionScenario();
        const res = createRes();
        await feedHandler(createReq({ query: { office: 'OKX' } }), res);
        expect(res.statusCode).toBe(200);
        const links = itemLinks(res.body);
        expect(links).toEqual([
            'https://plaincast.live/o/OKX/?edition=okx-350pm',
            'https://plaincast.live/o/OKX/?edition=okx-739am',
        ]);
        expect(new Set(links).size).toBe(links.length);
    });

    it('guid is the permalink itself, marked isPermaLink="true"', async () => {
        twoEditionScenario();
        const res = createRes();
        await feedHandler(createReq({ query: { office: 'OKX' } }), res);
        expect(res.body).toContain('<guid isPermaLink="true">https://plaincast.live/o/OKX/?edition=okx-350pm</guid>');
        expect(res.body).toContain('<guid isPermaLink="true">https://plaincast.live/o/OKX/?edition=okx-739am</guid>');
        expect(res.body).not.toContain('isPermaLink="false"');
    });

    it('URL-encodes edition ids in the permalink', async () => {
        setFeedScenario('OKX', [{
            id: 'urn:noaa:okx:1', issuanceTime: '2026-07-03T19:50:00+00:00',
            text: afd({ wmoTime: '031950', mastTime: '350 PM EDT Fri Jul 3 2026', synopsis: SYNOPSIS_A, shortTerm: SHORT_TERM_A }),
        }]);
        const res = createRes();
        await feedHandler(createReq({ query: { office: 'OKX' } }), res);
        expect(itemLinks(res.body)[0]).toBe('https://plaincast.live/o/OKX/?edition=urn%3Anoaa%3Aokx%3A1');
    });
});

describe('GET /api/feed — issuance-time titles', () => {
    it('same-day issuances get distinct titles with local time and zone', async () => {
        twoEditionScenario();
        const res = createRes();
        await feedHandler(createReq({ query: { office: 'OKX' } }), res);
        const titles = itemTitles(res.body);
        expect(titles).toEqual([
            'New York forecast — Fri, Jul 3, 3:50 PM EDT',
            'New York forecast — Fri, Jul 3, 7:39 AM EDT',
        ]);
        expect(new Set(titles).size).toBe(titles.length);
    });

    it("uses the office's own timezone (LOX renders in PDT)", async () => {
        setFeedScenario('LOX', [{
            id: 'lox-1', issuanceTime: '2026-07-03T19:50:00+00:00',
            text: afd({ wmoTime: '031950', mastTime: '1250 PM PDT Fri Jul 3 2026', synopsis: SYNOPSIS_A, shortTerm: SHORT_TERM_A }),
        }]);
        const res = createRes();
        await feedHandler(createReq({ query: { office: 'LOX' } }), res);
        expect(itemTitles(res.body)[0]).toBe('Los Angeles forecast — Fri, Jul 3, 12:50 PM PDT');
    });
});

describe('GET /api/feed — delta-first descriptions', () => {
    it('leads with "What changed:" + the changed paragraph, then the lede', async () => {
        twoEditionScenario();
        const res = createRes();
        await feedHandler(createReq({ query: { office: 'OKX' } }), res);
        const descs = itemDescriptions(res.body);
        expect(descs[0]).toMatch(/^What changed: A severe thunderstorm watch is now in effect/);
        // The unchanged SYNOPSIS is not part of the delta, but the lede follows.
        expect(descs[0]).toContain('High pressure keeps the region dry and mild');
    });

    it('falls back to the lede when nothing changed (only header/mast noise differs)', async () => {
        setFeedScenario('OKX', [
            {
                id: 'okx-noise-2', issuanceTime: '2026-07-03T19:50:00+00:00',
                text: afd({ wmoTime: '031950', mastTime: '350 PM EDT Fri Jul 3 2026', synopsis: SYNOPSIS_A, shortTerm: SHORT_TERM_A }),
            },
            {
                id: 'okx-noise-1', issuanceTime: '2026-07-03T11:39:00+00:00',
                text: afd({ wmoTime: '031139', mastTime: '739 AM EDT Fri Jul 3 2026', synopsis: SYNOPSIS_A, shortTerm: SHORT_TERM_A }),
            },
        ]);
        const res = createRes();
        await feedHandler(createReq({ query: { office: 'OKX' } }), res);
        const descs = itemDescriptions(res.body);
        expect(descs[0]).not.toContain('What changed:');
        expect(descs[0]).toMatch(/^High pressure keeps the region dry and mild/);
    });

    it('the oldest fetched issuance (nothing to diff against) falls back to the lede', async () => {
        twoEditionScenario();
        const res = createRes();
        await feedHandler(createReq({ query: { office: 'OKX' } }), res);
        const descs = itemDescriptions(res.body);
        expect(descs[1]).not.toContain('What changed:');
        expect(descs[1]).toMatch(/^High pressure keeps the region dry and mild/);
    });

    it('descriptions never contain FXUS/WMO junk, mast lines, or section headers', async () => {
        twoEditionScenario();
        const res = createRes();
        await feedHandler(createReq({ query: { office: 'OKX' } }), res);
        for (const d of itemDescriptions(res.body)) {
            expect(d).not.toContain('FXUS');
            expect(d).not.toMatch(/^000/);
            expect(d).not.toContain('AFDOKX');
            expect(d).not.toContain('Area Forecast Discussion');
            expect(d).not.toContain('National Weather Service New York');
            expect(d).not.toContain('SHORT TERM');
            expect(d).not.toContain('$$');
        }
    });
});

describe('GET /api/feed — shape preserved', () => {
    it('caps the feed at 10 items and keeps caching headers', async () => {
        const editions = [];
        for (let i = 0; i < 12; i++) {
            editions.push({
                id: `okx-many-${i}`,
                issuanceTime: new Date(Date.UTC(2026, 6, 3, 23 - i)).toISOString(),
                text: afd({ wmoTime: '031950', mastTime: '350 PM EDT Fri Jul 3 2026', synopsis: SYNOPSIS_A, shortTerm: SHORT_TERM_A }),
            });
        }
        setFeedScenario('OKX', editions);
        const res = createRes();
        await feedHandler(createReq({ query: { office: 'OKX' } }), res);
        expect(itemBlocks(res.body).length).toBe(10);
        expect(res.headers['content-type']).toContain('application/rss+xml');
        expect(res.headers['cache-control']).toContain('s-maxage=3600');
        expect(res.headers['cache-control']).toContain('stale-while-revalidate=7200');
    });
});
