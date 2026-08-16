// ─── AFD section parsing: Key Message format resilience ─────────────
// Real AFD fixtures captured from api.weather.gov on 2026-07-03:
//   okx-what-has-changed.txt  — OKX (New York): Key Message format,
//                               .WHAT HAS CHANGED first, no .SYNOPSIS
//   akq-key-messages.txt      — AKQ (Wakefield): Key Message format
//                               (first office migrated, Jan 2026)
//   lox-classic-synopsis.txt  — LOX (Los Angeles): classic .SYNOPSIS format

import { describe, it, expect, mock } from 'bun:test';
import { stripWmoHeader, extractSections, extractLede, sectionHealth } from '../api/_afd-sections.js';

const OKX = await Bun.file(new URL('./fixtures/afd/okx-what-has-changed.txt', import.meta.url)).text();
const AKQ = await Bun.file(new URL('./fixtures/afd/akq-key-messages.txt', import.meta.url)).text();
const LOX = await Bun.file(new URL('./fixtures/afd/lox-classic-synopsis.txt', import.meta.url)).text();

const FIXTURES = { OKX, AKQ, LOX };

// ─── stripWmoHeader ─────────────────────────────────────────────────
describe('stripWmoHeader', () => {
    it('removes the WMO telegraph preamble from every fixture', () => {
        for (const [name, text] of Object.entries(FIXTURES)) {
            const stripped = stripWmoHeader(text);
            expect(stripped).not.toContain('FXUS');
            expect(stripped).not.toMatch(/^000/);
            expect(stripped).not.toMatch(/^AFD[A-Z]{2,3}/m);
            expect(stripped.length).toBeGreaterThan(100);
        }
    });

    it('removes the trailing $$ and forecaster signature noise', () => {
        for (const text of Object.values(FIXTURES)) {
            const stripped = stripWmoHeader(text);
            expect(stripped).not.toContain('$$');
        }
        // LOX signature block (after $$) must be gone
        expect(stripWmoHeader(LOX)).not.toContain('weather.gov/losangeles');
        expect(stripWmoHeader(LOX)).not.toContain('SYNOPSIS...Ciliberti');
    });

    it('keeps the product mast and body', () => {
        expect(stripWmoHeader(OKX)).toMatch(/^Area Forecast Discussion/);
        expect(stripWmoHeader(OKX)).toContain('.WHAT HAS CHANGED...');
        expect(stripWmoHeader(LOX)).toContain('.SYNOPSIS...');
    });

    it('handles empty and non-string input', () => {
        expect(stripWmoHeader('')).toBe('');
        expect(stripWmoHeader(null)).toBe('');
        expect(stripWmoHeader(undefined)).toBe('');
    });
});

// ─── extractSections ────────────────────────────────────────────────
describe('extractSections', () => {
    it('parses the OKX Key Message format (WHAT HAS CHANGED first, no SYNOPSIS)', () => {
        const keys = extractSections(OKX).map(s => s.key);
        expect(keys).toEqual([
            'WHAT HAS CHANGED',
            'KEY MESSAGES',
            'DISCUSSION',
            'AVIATION',
            'MARINE',
            'WATCHES/WARNINGS/ADVISORIES',
        ]);
    });

    it('parses the AKQ Key Message format', () => {
        const keys = extractSections(AKQ).map(s => s.key);
        expect(keys).toEqual([
            'WHAT HAS CHANGED',
            'KEY MESSAGES',
            'DISCUSSION',
            'AVIATION',
            'EQUIPMENT',
            'WATCHES/WARNINGS/ADVISORIES',
        ]);
    });

    it('parses the LOX classic format (SYNOPSIS + slash/paren headers)', () => {
        const keys = extractSections(LOX).map(s => s.key);
        expect(keys).toEqual([
            'SYNOPSIS',
            'SHORT TERM',
            'LONG TERM',
            'AVIATION',
            'MARINE',
            'WATCHES/WARNINGS/ADVISORIES',
        ]);
    });

    it('keeps .KEY MESSAGE N pseudo-headers inside the DISCUSSION body', () => {
        const discussion = extractSections(OKX).find(s => s.key === 'DISCUSSION');
        expect(discussion.text).toContain('KEY MESSAGE 1');
        expect(discussion.text).toContain('Dangerous heat will continue this afternoon through Saturday.');
    });

    it('captures section body text without && markers', () => {
        for (const text of Object.values(FIXTURES)) {
            for (const s of extractSections(text)) {
                expect(s.text).not.toMatch(/^&&$/m);
            }
        }
        const synopsis = extractSections(LOX).find(s => s.key === 'SYNOPSIS');
        expect(synopsis.text).toContain('Onshore flow will continue');
    });

    it('returns [] for garbage input', () => {
        expect(extractSections('')).toEqual([]);
        expect(extractSections('no headers here, just prose')).toEqual([]);
    });

    // ─── Broadened header regex (mixed-case + digit-bearing) ────────
    // Verified against live products: the old [A-Z\s\/] capture class rejected
    // mixed-case ".Previous Discussion..." (KOUN) and digit-bearing
    // ".OUTLOOK FOR 18Z FRIDAY..." (KOKX), silently merging them into the
    // preceding section. Both must now parse as their own sections.
    it('parses a mixed-case ".Previous Discussion..." header as its own section (KOUN)', () => {
        const product = `000\nFXUS64 KOUN 032349\nAFDOUN\n\n.SHORT TERM...\nStrong storms move through this evening.\n\n.Previous Discussion...\nIssued 12 hours ago. Stale content that must not merge into Short Term.\n\n&&\n\n$$\n`;
        const sections = extractSections(product);
        const keys = sections.map(s => s.key);
        expect(keys).toContain('SHORT TERM');
        expect(keys).toContain('Previous Discussion');
        const shortTerm = sections.find(s => s.key === 'SHORT TERM');
        expect(shortTerm.text).not.toContain('Stale content');
        const prev = sections.find(s => s.key === 'Previous Discussion');
        expect(prev.text).toContain('Stale content');
    });

    it('parses a digit-bearing ".OUTLOOK FOR 18Z FRIDAY..." header, not swallowed into AVIATION (KOKX)', () => {
        const product = `000\nFXUS61 KOKX 032349\nAFDOKX\n\n.AVIATION /00Z SATURDAY THROUGH WEDNESDAY/...\nVFR conditions expected through the period.\n\n.OUTLOOK FOR 18Z FRIDAY THROUGH TUESDAY...\nElevated fire weather conditions possible.\n\n&&\n\n$$\n`;
        const sections = extractSections(product);
        const keys = sections.map(s => s.key);
        expect(keys).toContain('AVIATION');
        expect(keys).toContain('OUTLOOK FOR 18Z FRIDAY THROUGH TUESDAY');
        const aviation = sections.find(s => s.key === 'AVIATION');
        expect(aviation.text).toContain('VFR conditions');
        expect(aviation.text).not.toContain('OUTLOOK');
        expect(aviation.text).not.toContain('fire weather');
    });
});

// ─── extractLede ────────────────────────────────────────────────────
describe('extractLede', () => {
    it('never returns WMO header junk for any fixture', () => {
        for (const text of Object.values(FIXTURES)) {
            const lede = extractLede(text);
            expect(lede.length).toBeGreaterThan(40);
            expect(lede).not.toMatch(/^\d/);
            expect(lede).not.toContain('FXUS');
            expect(lede).not.toMatch(/^AFD/);
        }
    });

    it('uses KEY MESSAGES (bullets joined into prose) when there is no SYNOPSIS (OKX)', () => {
        const lede = extractLede(OKX);
        expect(lede).toMatch(/^Dangerous heat and humidity continues/);
        expect(lede).toContain('A severe thunderstorm watch is in effect');
        expect(lede).not.toMatch(/^\s*1\)/m); // bullet markers stripped
    });

    it('uses KEY MESSAGES for AKQ', () => {
        const lede = extractLede(AKQ);
        expect(lede).toMatch(/^A prolonged and widespread heat wave/);
    });

    it('prefers SYNOPSIS in the classic format and strips the header timestamp (LOX)', () => {
        const lede = extractLede(LOX);
        expect(lede).toMatch(/^Onshore flow will continue/);
        expect(lede).not.toContain('03/428'); // ".SYNOPSIS...03/428 PM." remnant
    });

    it('caps at ~500 chars on a sentence boundary', () => {
        for (const text of Object.values(FIXTURES)) {
            const lede = extractLede(text);
            expect(lede.length).toBeLessThanOrEqual(500);
            expect(lede).toMatch(/[.!?]\)?$/);
        }
    });

    it('falls back to WHAT HAS CHANGED when KEY MESSAGES and SYNOPSIS are missing', () => {
        const product = `000\nFXUS61 KOKX 032349\nAFDOKX\n\n.WHAT HAS CHANGED...\nA severe thunderstorm watch is in effect for the Lower Hudson\nValley this evening.\n\n&&\n\n$$\n`;
        expect(extractLede(product)).toMatch(/^A severe thunderstorm watch/);
    });

    it('falls back to the first substantial paragraph when no sections parse', () => {
        const product = `000\nFXUS61 KSEW 032349\nAFDSEW\n\nArea Forecast Discussion\nNational Weather Service Seattle WA\n449 PM PDT Fri Jul 3 2026\n\nA weak front brings light rain to the coast tonight followed by\ngradual clearing and warmer temperatures over the weekend.\n\n$$\n`;
        const lede = extractLede(product);
        expect(lede).toMatch(/^A weak front brings light rain/);
        expect(lede).not.toContain('FXUS');
    });

    it('returns empty string rather than junk when nothing usable exists', () => {
        expect(extractLede('')).toBe('');
        expect(extractLede('000\nFXUS61 KSEW 032349\nAFDSEW\n\nshort\n\n$$\n')).toBe('');
    });
});

// ─── sectionHealth ──────────────────────────────────────────────────
describe('sectionHealth', () => {
    it('detects the Key Message format (OKX, AKQ)', () => {
        for (const text of [OKX, AKQ]) {
            const health = sectionHealth(text);
            expect(health.format).toBe('key-messages');
            expect(health.sectionCount).toBe(6);
            expect(health.hasLede).toBe(true);
        }
    });

    it('detects the classic format (LOX)', () => {
        const health = sectionHealth(LOX);
        expect(health.format).toBe('classic');
        expect(health.sectionCount).toBe(6);
        expect(health.hasLede).toBe(true);
    });

    it('reports unknown format with zero sections for unparseable text', () => {
        const health = sectionHealth('just some prose without any NWS headers');
        expect(health.format).toBe('unknown');
        expect(health.sectionCount).toBe(0);
    });
});

// ─── /api/feed + /api/og handlers with real fixtures ────────────────
let mockItems = [];
let mockProducts = {};
let mockListError = null;   // set to make fetchAFDList throw (og fallback tests)
let productCalls = [];      // product urls fetched — verifies edition pinning
mock.module('../api/_utils.js', () => ({
    // A module mock replaces the WHOLE module process-wide (Bun mocks are
    // global), so the National Desk fetchers must be stubbed here too —
    // omitting them makes api/national-desk.js fail to link when this file
    // loads first. Stub every export of _utils.js, always.
    fetchSevereAlerts: async () => [],
    fetchAlertTotals: async () => null,
    fetchSpcDy1: async () => null,
    fetchAlertById: async () => null,
    fetchAFDList: async () => {
        if (mockListError) throw mockListError;
        return mockItems;
    },
    fetchAFDProduct: async (url) => {
        productCalls.push(url);
        return mockProducts[url] || {};
    },
    productUrlFromItem: (item) => item?.id || null,
}));

const { default: feedHandler } = await import('../api/feed.js');
const { default: ogHandler, buildCardElement, buildDateline, clampTakeaway } = await import('../api/og.js');

function createRes() {
    return {
        statusCode: 200, headers: {}, body: null, ended: false, redirected: null,
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(d) { this.body = d; this.ended = true; return this; },
        send(d) { this.body = d; this.ended = true; return this; },
        redirect(code, url) { this.redirected = { code, url }; this.ended = true; return this; },
        end() { this.ended = true; return this; },
    };
}
const createReq = (o = {}) => ({ method: 'GET', query: {}, ...o });

function setProduct(office, productText, id) {
    mockItems = [{ id }];
    mockProducts = { [id]: { productText, issuanceTime: '2026-07-03T23:49:00+00:00' } };
    mockListError = null;
    productCalls = [];
}

function itemDescriptions(rss) {
    // Skip the channel-level <description>; return item-level ones.
    const all = [...rss.matchAll(/<description>([\s\S]*?)<\/description>/g)].map(m => m[1]);
    return all.slice(1);
}

describe('GET /api/feed with Key Message format AFDs', () => {
    it('OKX (WHAT HAS CHANGED format): description is real forecast text, not WMO header', async () => {
        setProduct('OKX', OKX, 'feed-okx-1');
        const res = createRes();
        await feedHandler(createReq({ query: { office: 'OKX' } }), res);
        expect(res.statusCode).toBe(200);
        const descs = itemDescriptions(res.body);
        expect(descs.length).toBe(1);
        expect(descs[0]).toMatch(/Dangerous heat and humidity/);
        expect(descs[0]).not.toContain('FXUS');
        expect(descs[0]).not.toMatch(/^000/);
        expect(res.body).not.toContain('FXUS');
    });

    it('AKQ-style Key Message product: description comes from KEY MESSAGES', async () => {
        // AKQ itself is not one of Plaincast's 68 offices; serve its product
        // (the first office migrated to the Key Message format) under a
        // valid office code to exercise the format through the handler.
        setProduct('PHI', AKQ, 'feed-akq-1');
        const res = createRes();
        await feedHandler(createReq({ query: { office: 'PHI' } }), res);
        expect(res.statusCode).toBe(200);
        const descs = itemDescriptions(res.body);
        expect(descs[0]).toMatch(/prolonged and widespread heat wave/);
        expect(descs[0]).not.toContain('FXUS');
    });

    it('LOX (classic format): description still comes from SYNOPSIS', async () => {
        setProduct('LOX', LOX, 'feed-lox-1');
        const res = createRes();
        await feedHandler(createReq({ query: { office: 'LOX' } }), res);
        expect(res.statusCode).toBe(200);
        const descs = itemDescriptions(res.body);
        expect(descs[0]).toMatch(/Onshore flow will continue/);
        expect(descs[0]).not.toContain('03/428');
        expect(descs[0]).not.toContain('FXUS');
    });

    it('preserves RSS structure and caching headers', async () => {
        setProduct('OKX', OKX, 'feed-okx-2');
        const res = createRes();
        await feedHandler(createReq({ query: { office: 'OKX' } }), res);
        expect(res.headers['content-type']).toContain('application/rss+xml');
        expect(res.headers['cache-control']).toContain('s-maxage=3600');
        expect(res.body).toContain('<rss version="2.0"');
        expect(res.body).toContain('<guid isPermaLink="true">https://plaincast.live/o/OKX/?edition=feed-okx-2</guid>');
    });

    it('warns once per office when zero sections parse (format drift)', async () => {
        const drifted = 'Plain prose without any NWS section headers at all, but long enough to serve as a fallback description paragraph for the feed.';
        setProduct('SEW', drifted, 'feed-sew-1');
        const warns = [];
        const origWarn = console.warn;
        console.warn = (...args) => { warns.push(args.join(' ')); };
        try {
            await feedHandler(createReq({ query: { office: 'SEW' } }), createRes());
            const res = createRes();
            await feedHandler(createReq({ query: { office: 'SEW' } }), res);
            // Description still safe: paragraph fallback, no WMO junk
            expect(itemDescriptions(res.body)[0]).toMatch(/^Plain prose/);
        } finally {
            console.warn = origWarn;
        }
        expect(warns.filter(w => w.includes('SEW')).length).toBe(1);
    });
});

describe('GET /api/og (raster share cards)', () => {
    const PNG_MAGIC = '89504e470d0a1a0a';

    it('OKX: renders a real 1200×630 PNG with latest-edition caching', async () => {
        setProduct('OKX', OKX, 'og-okx-1');
        const res = createRes();
        await ogHandler(createReq({ query: { office: 'OKX' } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('image/png');
        expect(res.headers['cache-control']).toContain('s-maxage=3600');
        expect(Buffer.isBuffer(res.body)).toBe(true);
        expect(res.body.subarray(0, 8).toString('hex')).toBe(PNG_MAGIC);
        expect(res.body.readUInt32BE(16)).toBe(1200); // IHDR width
        expect(res.body.readUInt32BE(20)).toBe(630);  // IHDR height
    });

    it('pinned edition: renders the id-named issuance (not the latest) and caches for a day', async () => {
        setProduct('LOX', LOX, 'og-lox-old');
        mockItems = [{ id: 'og-lox-new' }, { id: 'og-lox-old' }];
        mockProducts['og-lox-new'] = { productText: OKX, issuanceTime: '2026-07-04T10:00:00+00:00' };
        const res = createRes();
        await ogHandler(createReq({ query: { office: 'LOX', id: 'og-lox-old' } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('image/png');
        expect(res.headers['cache-control']).toContain('s-maxage=86400');
        expect(productCalls).toEqual(['og-lox-old']); // the pinned edition was fetched
    });

    it('unknown edition id: 302 to the static fallback, never a 404', async () => {
        setProduct('LOX', LOX, 'og-lox-1');
        const res = createRes();
        await ogHandler(createReq({ query: { office: 'LOX', id: 'og-not-retained' } }), res);
        expect(res.redirected).toEqual({ code: 302, url: '/og-image.png' });
    });

    it('invalid office: 302 to the static fallback with day-long caching', async () => {
        const res = createRes();
        await ogHandler(createReq({ query: { office: 'ZZZ' } }), res);
        expect(res.redirected).toEqual({ code: 302, url: '/og-image.png' });
        expect(res.headers['cache-control']).toContain('s-maxage=86400');
    });

    it('malformed edition id: 302 to the static fallback', async () => {
        setProduct('LOX', LOX, 'og-lox-1');
        for (const id of ['bad id!', 'a'.repeat(65), '../../etc']) {
            const res = createRes();
            await ogHandler(createReq({ query: { office: 'LOX', id } }), res);
            expect(res.redirected).toEqual({ code: 302, url: '/og-image.png' });
        }
    });

    it('NWS failure: 302 to the static fallback (unfurls must never 404)', async () => {
        setProduct('OKX', OKX, 'og-okx-err');
        mockListError = new Error('NWS API error: 503');
        try {
            const res = createRes();
            await ogHandler(createReq({ query: { office: 'OKX' } }), res);
            expect(res.redirected).toEqual({ code: 302, url: '/og-image.png' });
        } finally {
            mockListError = null;
        }
    });
});

describe('OG card element tree (pure builder — text content the PNG cannot expose)', () => {
    it('carries the Dispatch identity: paper, ink, wordmark, city, dateline, takeaway, folio', () => {
        const el = buildCardElement({
            city: 'New York',
            dateline: buildDateline('2026-07-03T23:49:00+00:00', 'OKX'),
            takeaway: clampTakeaway(extractLede(OKX)),
        });
        const flat = JSON.stringify(el);
        expect(flat).toContain('Plaincast');
        expect(flat).toContain('New York');
        expect(flat).toContain('AREA FORECAST DISCUSSION · FRI, JUL 3, 7:49 PM EDT');
        expect(flat).toContain('Dangerous heat and humidity');
        expect(flat).not.toContain('FXUS');
        expect(flat).toContain('plaincast.live');
        expect(flat).toContain('#f7f3ea'); // warm paper
        expect(flat).toContain('#211d17'); // ink
        expect(flat).toContain('#d8cdb6'); // hairline rule
        expect(flat).not.toMatch(/gradient/i);
    });

    it('LOX classic SYNOPSIS takeaway flows through, clamped to 3 lines', () => {
        const takeaway = clampTakeaway(extractLede(LOX));
        expect(takeaway).toContain('Onshore flow will continue');
        expect(takeaway).not.toContain('03/428');
        const flat = JSON.stringify(buildCardElement({ city: 'Los Angeles', dateline: 'x', takeaway }));
        expect(flat).toContain('"lineClamp":3');
    });

    it('buildDateline renders office-local time and degrades without an issuance time', () => {
        expect(buildDateline('2026-07-03T23:49:00+00:00', 'LOX')).toBe('Area Forecast Discussion · Fri, Jul 3, 4:49 PM PDT');
        expect(buildDateline(null, 'LOX')).toBe('Area Forecast Discussion');
        expect(buildDateline('garbage', 'LOX')).toBe('Area Forecast Discussion');
    });

    it('clampTakeaway caps long ledes on a sentence boundary under 240 chars', () => {
        const long = 'This sentence is repeated to build a very long lede. '.repeat(12);
        const clamped = clampTakeaway(long);
        expect(clamped.length).toBeLessThanOrEqual(240);
        expect(clamped.endsWith('.')).toBe(true);
    });
});
