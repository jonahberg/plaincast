// ─── Frontend audit fixes (Sep 28 2026) ──────────────────────────────
// Pure helpers are driven directly; React-internal fixes are pinned by
// source assertions (same convention as tests/shadcn-frontend.test.js).

import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

import { HOME_CANONICAL, HOME_MARKDOWN_HREF, HOME_TITLE, headFor, officeCanonical, officeTitle, changelogTitle } from '../shadcn/src/lib/seo.js';
import { badgeRepeatsEvent, dropExpiredAlerts } from '../shadcn/src/lib/nws.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('head tags follow the route (Back to / restores the homepage)', () => {
    it('home constants are the literal strings in shadcn/index.html', () => {
        const html = read('shadcn/index.html');
        expect(html).toContain(`<title>${HOME_TITLE}</title>`);
        expect(html).toContain(`<meta property="og:title" content="${HOME_TITLE}">`);
        expect(html).toContain(`<link rel="canonical" href="${HOME_CANONICAL}">`);
        expect(html).toContain(`<meta property="og:url" content="${HOME_CANONICAL}">`);
        expect(html).toContain(`<link rel="alternate" type="text/markdown" href="${HOME_MARKDOWN_HREF}">`);
    });

    it('headFor(null office) is the homepage; an office gets its own', () => {
        expect(headFor({ office: null, city: 'Chicago' })).toEqual({ title: HOME_TITLE, canonical: HOME_CANONICAL, markdown: HOME_MARKDOWN_HREF });
        expect(headFor({ office: 'LOT', city: 'Chicago' })).toEqual({ title: officeTitle('Chicago'), canonical: officeCanonical('LOT'), markdown: officeCanonical('LOT') });
        expect(headFor({ office: 'LOT', city: 'Chicago', changelog: true }).title).toBe(changelogTitle('Chicago'));
    });

    it('App tracks whether the URL names an office and applies it on popstate', () => {
        const app = read('shadcn/src/App.jsx');
        expect(app).toContain('atHome: !route.office');
        expect(app).toMatch(/headFor\(\{ office: fromUrl \? office : null/);
        expect(app).toContain('[office, inChangelog, fromUrl]');
    });

    it('load() resets per-office editions and severe posture', () => {
        const app = read('shadcn/src/App.jsx');
        const load = app.slice(app.indexOf('const load = useCallback'), app.indexOf('const toState'));
        expect(load).toContain('setEditions([]);');
        expect(load).toContain('setSevere(false);');
    });
});

describe('ChangelogView "Earlier editions" race', () => {
    const src = read('shadcn/src/components/ChangelogView.jsx');
    it('drops stale loadMore results and never concats onto a non-ready state', () => {
        expect(src).toContain('generation.current++');
        expect(src).toContain('if (gen !== generation.current');
        expect(src).toContain("if (s.status !== 'ready') return s;");
    });

    it('views sit in scoped error boundaries that reset on office change', () => {
        const app = read('shadcn/src/App.jsx');
        expect(app).toContain('<ErrorBoundary scoped resetKey={`changelog|${office}`}>');
        expect(app).toMatch(/<ErrorBoundary scoped resetKey=\{`forecast\|/);
        expect(read('shadcn/src/components/ErrorBoundary.jsx')).toContain('prevProps.resetKey !== this.props.resetKey');
    });
});

describe('ForecastSection AI status', () => {
    const src = read('shadcn/src/components/ForecastSection.jsx');
    it('starts idle; "Summarizing…" only once the request starts', () => {
        expect(src).toContain("status: aiEligible ? 'idle' : 'off'");
        expect(src).not.toContain("status: aiEligible ? 'pending'");
        expect(src).toContain("setAi({ status: 'pending', html: null });");
    });

    it('the header title can wrap and shrink (no 320px overflow)', () => {
        expect(src).toMatch(/<CardTitle className="flex min-w-0 flex-wrap/);
    });

    it('passes the issuance time to the regex translation (Zulu dating)', () => {
        expect(src).toContain('translateToPlainEnglish(section.text, tz, issuanceTime)');
    });
});

describe('alerts', () => {
    it('badge is hidden from the accessible name when the event repeats it', () => {
        expect(badgeRepeatsEvent('Coastal Flood Advisory', 'Advisory')).toBe(true);
        expect(badgeRepeatsEvent('Special Weather Statement', 'Statement')).toBe(true);
        expect(badgeRepeatsEvent('Tsunami Warning', 'Watch')).toBe(false);
        expect(badgeRepeatsEvent('', 'Warning')).toBe(false);
        expect(read('shadcn/src/components/AlertsSection.jsx')).toContain('aria-hidden={badgeRepeatsEvent(group.event, meta.label) || undefined}');
    });

    it('drops expired alerts (a cached offline response must not show them live)', () => {
        const now = Date.parse('2026-09-28T12:00:00Z');
        const alerts = [
            { id: 'live', expires: '2026-09-28T18:00:00Z', ends: '2026-09-29T00:00:00Z' },
            { id: 'expired', expires: '2026-09-28T06:00:00Z', ends: '' },
            { id: 'ended', expires: '2026-09-28T18:00:00Z', ends: '2026-09-28T11:00:00Z' },
            { id: 'open-ended', expires: '', ends: '' },
            { id: 'garbage-date', expires: 'soon', ends: '' },
        ];
        expect(dropExpiredAlerts(alerts, now).map(a => a.id)).toEqual(['live', 'open-ended', 'garbage-date']);
    });

    it('fetchAlerts applies the filter; the SW cache namespace was bumped', () => {
        expect(read('shadcn/src/lib/nws.js')).toContain('alerts = dropExpiredAlerts(alerts);');
        expect(read('shadcn/public/sw.js')).not.toContain("'plaincast-shadcn-v3'");
    });
});

describe('deployed statics', () => {
    it('prepare-deploy copies /.well-known and requires the icons', () => {
        const src = read('scripts/prepare-deploy.mjs');
        expect(src).toContain("['.well-known', '.well-known']");
        expect(src).toContain("'favicon.ico'");
        expect(src).toContain("'apple-touch-icon.png'");
    });

    it('security.txt is RFC 9116 valid: Contact + a future Expires under a year out', () => {
        const txt = read('docs/.well-known/security.txt');
        expect(txt).toMatch(/^Contact: https:\/\//m);
        const m = txt.match(/^Expires: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/m);
        expect(m).not.toBe(null);
        const expires = Date.parse(m[1]);
        // Fixed audit date: the check must not start failing by itself; the
        // file just needs renewing before it lapses.
        const written = Date.parse('2026-09-28T00:00:00Z');
        expect(expires).toBeGreaterThan(written);
        expect(expires - written).toBeLessThanOrEqual(366 * 86400000);
    });

    it('favicon.ico + apple-touch-icon.png exist and the shell links them', () => {
        const ico = readFileSync(new URL('../shadcn/public/favicon.ico', import.meta.url));
        expect([ico[0], ico[1], ico[2], ico[3]]).toEqual([0, 0, 1, 0]); // ICO header
        const png = readFileSync(new URL('../shadcn/public/apple-touch-icon.png', import.meta.url));
        expect(png.readUInt32BE(16)).toBe(180); // IHDR width
        expect(png.readUInt32BE(20)).toBe(180);
        for (const p of ['shadcn/index.html', 'api/_home-shell.html', 'docs/o/LOX/index.html']) {
            const html = read(p);
            expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
            expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32">');
        }
    });

    it('legacy-chrome header drops the duplicate Forecast link at ≤380px', () => {
        const css = read('docs/styles.css');
        const block = css.slice(css.indexOf('@media (max-width: 380px)'));
        expect(block).toMatch(/\.site-nav a\[href="\/"\]:not\(\[aria-current="page"\]\) \{ display: none; \}/);
    });
});
