// ─── shadcn edition: frontend repair (Sep 2026) ─────────────────────
// Pure logic behind the regressions fixed after the shadcn edition went to
// production: the ?view=changelog route, Key Messages list splitting, alert
// grouping, /api/conditions null handling, the shared title helper, the
// failure-telemetry helper, and the legacy theme-key fallback.

import { describe, it, expect, afterEach } from 'bun:test';

import { buildOfficeUrl, parseRoute } from '../shadcn/src/lib/route.js';
import { extractTakeaway, parseSections, splitTakeawayItems } from '../shadcn/src/lib/afd.js';
import { alertGroupKey, groupAlerts } from '../shadcn/src/lib/nws.js';
import { editionName, readingOrNull } from '../shadcn/src/lib/format.js';
import { OFFICES_WITHOUT_NORMAL } from '../shadcn/src/lib/almanac.js';
import { alertStatusVariants } from '../shadcn/src/lib/alert-status.js';
import { changelogTitle, officeCanonical, officeFeedHref, officeTitle } from '../shadcn/src/lib/seo.js';
import { officeTitle as ssrOfficeTitle } from '../scripts/build-offices.mjs';
import { track } from '../shadcn/src/lib/track.js';
import { storedTheme } from '../shadcn/src/lib/theme.js';

const read = (p) => Bun.file(new URL(`../${p}`, import.meta.url)).text();

describe('route: ?view=changelog', () => {
    it('reads view, office and edition from the URL', () => {
        expect(parseRoute('https://plaincast.live/o/LOT/?view=changelog'))
            .toEqual({ office: 'LOT', edition: null, view: 'changelog' });
        expect(parseRoute('https://plaincast.live/o/lot/?edition=AFD-X'))
            .toEqual({ office: 'LOT', edition: 'AFD-X', view: null });
        expect(parseRoute('https://plaincast.live/?office=okx').office).toBe('OKX');
    });

    it('ignores unknown views', () => {
        expect(parseRoute('https://plaincast.live/o/LOT/?view=bogus').view).toBe(null);
    });

    it('never carries view into an unrelated URL', () => {
        const base = 'https://plaincast.live/o/LOT/?view=changelog#x';
        expect(buildOfficeUrl(base, 'OKX').toString()).toBe('https://plaincast.live/o/OKX/');
        expect(buildOfficeUrl(base, 'LOT', { edition: 'AFD-1' }).toString())
            .toBe('https://plaincast.live/o/LOT/?edition=AFD-1');
    });

    it('mints the ledger URL without a stale edition', () => {
        const base = 'https://plaincast.live/o/LOT/?edition=AFD-1&office=LOT';
        expect(buildOfficeUrl(base, 'LOT', { view: 'changelog' }).toString())
            .toBe('https://plaincast.live/o/LOT/?view=changelog');
    });
});

describe('Key takeaway list splitting', () => {
    const LOT = '- Occasional sprinkles are expected in the\n  area this morning.\n\n- Near normal temperatures are forecasted over\n  the next several days.\n\n- The next chance for rain won\'t come\n  until next week.';
    const OKX = '1) An early season nor\'easter will bring\nstrong winds and rainfall.\n\n2) Coastal flooding impacts expected.\nGreatest impacts Saturday. \n\n3) High surf and rip current risk.';

    it('splits dash bullets into items, joining wrapped lines', () => {
        const list = splitTakeawayItems(LOT);
        expect(list.ordered).toBe(false);
        expect(list.items).toHaveLength(3);
        expect(list.items[0]).toBe('Occasional sprinkles are expected in the area this morning.');
    });

    it('splits numbered items and keeps them ordered', () => {
        const list = splitTakeawayItems(OKX);
        expect(list.ordered).toBe(true);
        expect(list.items).toHaveLength(3);
        expect(list.items[1]).toBe('Coastal flooding impacts expected. Greatest impacts Saturday.');
    });

    it('leaves prose (and a wrapped line that starts with a number) alone', () => {
        expect(splitTakeawayItems('Warm and dry through the week.')).toBe(null);
        expect(splitTakeawayItems('1) Highs near\n70. Then cooler.')).toBe(null);
        expect(splitTakeawayItems('- only one item')).toBe(null);
    });

    it('renders the Messages section as a real list', () => {
        const html = extractTakeaway([{ key: 'Messages', text: LOT }], 'America/Chicago');
        expect(html.startsWith('<ul class="takeaway-list"><li>')).toBe(true);
        expect(html.match(/<li>/g)).toHaveLength(3);
        expect(html).not.toContain('- ');
        const ol = extractTakeaway([{ key: 'Messages', text: OKX }], 'America/New_York');
        expect(ol.startsWith('<ol class="takeaway-list">')).toBe(true);
        expect(ol).not.toMatch(/\b\d\)/);
    });

    it('still takes the synopsis when there is no Messages section', async () => {
        const fixture = await read('tests/fixtures/afd/lox-classic-synopsis.txt');
        const html = extractTakeaway(parseSections(fixture).sections, 'America/Los_Angeles');
        expect(html).not.toContain('<ul');
        expect(html.length).toBeGreaterThan(20);
    });
});

describe('alert grouping', () => {
    const watch = (zone, extra = {}) => ({
        id: `id-${zone}`, event: 'Tropical Storm Watch', ends: '', expires: '2026-09-25T13:00:00-10:00',
        areaDesc: zone, description: `Watch text for ${zone}`, ...extra,
    });

    it('collapses identical event + end time into one row with a count', () => {
        const alerts = [watch('Kona'), watch('Kohala'), watch('Kona'),
            { id: 'w', event: 'Tropical Storm Warning', expires: '2026-09-25T13:00:00-10:00', areaDesc: 'Oahu' }];
        const groups = groupAlerts(alerts);
        expect(groups).toHaveLength(2);
        expect(groups[0].count).toBe(3);
        expect(groups[0].members).toHaveLength(3);
        expect(groups[0].areas).toEqual(['Kona', 'Kohala']);
        expect(groups[0].descriptions).toHaveLength(2);
        expect(groups[0].id).toBe('id-Kona'); // lead alert stands for the group
        expect(groups[1].count).toBe(1);
    });

    it('keys on ends first, then expires, and keeps distinct end times apart', () => {
        expect(alertGroupKey({ event: 'X', ends: 'A', expires: 'B' })).toBe('X|A');
        expect(alertGroupKey({ event: 'X', ends: null, expires: 'B' })).toBe('X|B');
        const groups = groupAlerts([watch('a'), watch('b', { expires: '2026-09-26T13:00:00-10:00' })]);
        expect(groups).toHaveLength(2);
    });

    it('handles an empty list', () => {
        expect(groupAlerts([])).toEqual([]);
        expect(groupAlerts(undefined)).toEqual([]);
    });
});

describe('/api/conditions readings', () => {
    it('treats null/undefined/empty as absent, never 0°', () => {
        expect(readingOrNull(null)).toBe(null);
        expect(readingOrNull(undefined)).toBe(null);
        expect(readingOrNull('')).toBe(null);
        expect(readingOrNull('n/a')).toBe(null);
    });
    it('keeps real readings, including 0°', () => {
        expect(readingOrNull(0)).toBe(0);
        expect(readingOrNull(81)).toBe(81);
        expect(readingOrNull('72')).toBe(72);
    });

    it('the strip never reserves a normal-high cell the server can never fill', async () => {
        const { CLIMATE_NORMALS } = await import('../api/_climate-normals.js');
        const { OFFICE_NAMES } = await import('../docs/js/offices.js');
        const missing = Object.keys(OFFICE_NAMES).filter(c => !CLIMATE_NORMALS[c]).sort();
        expect([...OFFICES_WITHOUT_NORMAL].sort()).toEqual(missing);
    });

    it('an empty reading drops its cell instead of showing a dash', async () => {
        const intro = await read('shadcn/src/components/PageIntro.jsx');
        const almanac = intro.slice(intro.indexOf('function Almanac('), intro.indexOf('function AlertStatus('));
        expect(almanac).not.toContain("'—'");
        expect(almanac).toContain("else if (!conditions) out.push({ label, value: '\\u00a0' });");
        expect(almanac).toContain("if (!OFFICES_WITHOUT_NORMAL.has(office)) live('Normal high', normal);");
    });
});

describe('alert status line variants', () => {
    const a = (event, extra = {}) => ({ id: `${event}-${Math.random()}`, event, ends: '2026-11-19T00:00:00Z', severity: 'Moderate', ...extra });

    it('condenses by whole names, longest first, each with an accurate "+N"', () => {
        const alerts = [a('Flood Watch'), a('Wind Advisory'), a('High Surf Advisory'), a('Coastal Flood Advisory')];
        expect(alertStatusVariants(alerts)).toEqual([
            '4 active alerts: Flood Watch, Wind Advisory +2',
            '4 active alerts: Flood Watch +3',
            '4 active alerts',
        ]);
    });

    it('has no duplicate variants when there is only one event', () => {
        expect(alertStatusVariants([a('Frost Advisory')])).toEqual(['1 active alert: Frost Advisory', '1 active alert']);
        expect(alertStatusVariants([])).toEqual([]);
    });
});

describe('titles and head links', () => {
    it('document.title uses the exact SSR format', () => {
        expect(officeTitle('Chicago')).toBe('Chicago NWS Forecast in Plain English · Plaincast');
        expect(ssrOfficeTitle).toBe(officeTitle); // one helper, shared
        expect(changelogTitle('Chicago')).toBe('Forecast Changelog · Chicago · Plaincast');
    });
    it('the baked office page carries the same title', async () => {
        const html = await read('docs/o/LOT/index.html');
        expect(html).toContain(`<title>${officeTitle('Chicago')}</title>`);
    });
    it('canonical + feed hrefs', () => {
        expect(officeCanonical('LOT')).toBe('https://plaincast.live/o/LOT/');
        expect(officeFeedHref('LOT')).toBe('/api/feed?office=LOT');
    });
    it('edition names follow the local issuance hour', () => {
        expect(editionName(4)).toBe('Morning');
        expect(editionName(12)).toBe('Midday');
        expect(editionName(16)).toBe('Evening');
        expect(editionName(23)).toBe('Late');
    });
});

describe('failure telemetry', () => {
    afterEach(() => { delete globalThis.window; });

    it('reports through window.va and never throws', () => {
        const calls = [];
        globalThis.window = { va: (...args) => calls.push(args) };
        track('afd-fetch-fail', { office: 'LOT' });
        expect(calls).toEqual([['event', { name: 'afd-fetch-fail', data: { office: 'LOT' } }]]);
        globalThis.window = { va: () => { throw new Error('boom'); } };
        expect(() => track('afd-parse-empty')).not.toThrow();
        globalThis.window = {};
        expect(() => track('ai-translate-fail')).not.toThrow();
    });

    it('the app fires every legacy event name', async () => {
        const src = (await Promise.all([
            read('shadcn/src/App.jsx'),
            read('shadcn/src/components/ForecastSection.jsx'),
            read('shadcn/src/components/ChangelogView.jsx'),
        ])).join('\n');
        for (const name of ['afd-fetch-fail', 'afd-parse-empty', 'ai-translate-fail', 'changelog-view-fail']) {
            expect(src).toContain(`track('${name}'`);
        }
    });

    it('the shell loads Web Analytics + Speed Insights (and so do the baked pages)', async () => {
        for (const p of ['shadcn/index.html', 'api/_home-shell.html', 'docs/o/HFO/index.html']) {
            const html = await read(p);
            expect(html).toContain('<script defer src="/_vercel/insights/script.js"></script>');
            expect(html).toContain('<script defer src="/_vercel/speed-insights/script.js"></script>');
        }
    });
});

describe('theme key migration', () => {
    const store = (init) => {
        const m = new Map(Object.entries(init));
        return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), m };
    };
    it('prefers plaincast-theme', () => {
        expect(storedTheme(store({ 'plaincast-theme': 'light', theme: 'dark' }))).toBe('light');
    });
    it('falls back to the legacy key once, copying it forward', () => {
        const s = store({ theme: 'dark' });
        expect(storedTheme(s)).toBe('dark');
        expect(s.m.get('plaincast-theme')).toBe('dark');
    });
    it('returns null when nothing valid is stored', () => {
        expect(storedTheme(store({ theme: 'sepia' }))).toBe(null);
    });
    it('the pre-paint script applies the same fallback', async () => {
        const js = await read('shadcn/public/theme-init.js');
        expect(js).toContain("localStorage.getItem('plaincast-theme')");
        expect(js).toContain("localStorage.getItem('theme')");
    });
});

// A document from another deployment asks for /assets/ files that 404 there
// (hashed names are per build; the old stable names are gone). theme-init.js
// keeps one stable name, so it carries the reload-once recovery.
describe('theme-init.js: reload once when the page\'s own assets are missing', () => {
    const run = async ({ stored = null, now = 1_000_000 } = {}) => {
        const js = await read('shadcn/public/theme-init.js');
        const listeners = [];
        const session = new Map(stored === null ? [] : [['plaincast-asset-reload', String(stored)]]);
        let reloads = 0;
        const env = {
            window: null,
            localStorage: { getItem: () => null, setItem() {} },
            sessionStorage: { getItem: k => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, String(v)) },
            matchMedia: () => ({ matches: false }),
            document: { documentElement: { classList: { add() {} } } },
            location: { origin: 'https://plaincast.live', reload: () => { reloads++; } },
            addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
            Date: { now: () => now },
            Number, String,
        };
        env.window = env;
        new Function(...Object.keys(env), js)(...Object.values(env));
        const fire = (target) => listeners.filter(l => l.type === 'error').forEach(l => l.fn({ target }));
        return { listeners, fire, reloads: () => reloads, session, env };
    };
    const script = (src) => ({ tagName: 'SCRIPT', src });
    const sheet = (href) => ({ tagName: 'LINK', rel: 'stylesheet', href });

    it('listens in the capture phase (element load errors do not bubble)', async () => {
        const { listeners } = await run();
        expect(listeners).toEqual([{ type: 'error', fn: expect.any(Function), capture: true }]);
    });
    it('reloads once when the app script or stylesheet 404s', async () => {
        const a = await run();
        a.fire(script('https://plaincast.live/assets/app.js'));
        expect(a.reloads()).toBe(1);
        a.fire(sheet('https://plaincast.live/assets/app-OLDHASH.css')); // same page, moments later
        expect(a.reloads()).toBe(1);
        const b = await run();
        b.fire(sheet('https://plaincast.live/assets/app.css'));
        expect(b.reloads()).toBe(1);
    });
    it('does not loop: a reload that just happened is not repeated, a later one is allowed', async () => {
        const recent = await run({ stored: 1_000_000 - 5_000 });
        recent.fire(script('https://plaincast.live/assets/app.js'));
        expect(recent.reloads()).toBe(0);
        const later = await run({ stored: 1_000_000 - 120_000 });
        later.fire(script('https://plaincast.live/assets/app.js'));
        expect(later.reloads()).toBe(1);
    });
    it('ignores everything that is not one of the page\'s own /assets/ tags', async () => {
        const { fire, reloads, env } = await run();
        fire(script('https://plaincast.live/_vercel/insights/script.js'));
        fire(script('https://example.com/assets/app.js'));
        fire({ tagName: 'IMG', src: 'https://plaincast.live/assets/x.png' });
        fire({ tagName: 'LINK', rel: 'modulepreload', href: 'https://plaincast.live/assets/vendor.js' });
        fire(env); // a runtime error on window itself
        fire(null);
        expect(reloads()).toBe(0);
    });
});
