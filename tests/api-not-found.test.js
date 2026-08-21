import { describe, it, expect } from 'bun:test';
import handler, { MARKDOWN_BODY, HTML_BODY } from '../api/not-found.js';
import { VARY } from '../api/_negotiate.js';

function mockRes() {
    const res = { headers: {}, code: 200, body: null };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
    res.getHeader = (k) => res.headers[k.toLowerCase()];
    res.status = (c) => { res.code = c; return res; };
    res.send = (b) => { res.body = b; return res; };
    return res;
}

describe('agent-friendly 404', () => {
    it('returns a real 404, never a 200 with an app shell', async () => {
        for (const accept of [undefined, 'text/markdown', '*/*']) {
            const res = mockRes();
            await handler({ method: 'GET', headers: accept ? { accept } : {} }, res);
            expect(res.code).toBe(404);
        }
    });

    it('the Markdown body points an agent at every recovery route', async () => {
        const res = mockRes();
        await handler({ method: 'GET', headers: { accept: 'text/markdown' } }, res);
        expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
        expect(res.body.startsWith('# 404')).toBe(true);
        for (const target of [
            'https://plaincast.live/',
            'https://plaincast.live/national/',
            'https://plaincast.live/sitemap.xml',
            'https://plaincast.live/llms.txt',
            'https://plaincast.live/robots.txt',
            '/o/<CODE>/',
        ]) {
            expect(res.body).toContain(target);
        }
    });

    it('is short enough to be a signpost rather than a page', () => {
        expect(MARKDOWN_BODY.length).toBeLessThan(2000);
        expect(MARKDOWN_BODY.length).toBeGreaterThan(300);
    });

    it('serves a styled HTML 404 to browsers, marked noindex', async () => {
        const res = mockRes();
        await handler({ method: 'GET', headers: { accept: 'text/html' } }, res);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.body).toContain('<meta name="robots" content="noindex">');
        expect(res.body).toContain('/sitemap.xml');
    });

    it('the HTML twin names the same recovery routes as the Markdown one', () => {
        for (const href of ['/national/', '/sitemap.xml', '/llms.txt', '/robots.txt', '/o/OKX/']) {
            expect(HTML_BODY).toContain(href);
        }
    });

    it('sets Vary and a CDN window, so a flood on one bad path costs one invocation', async () => {
        const res = mockRes();
        await handler({ method: 'GET', headers: {} }, res);
        expect(res.headers.vary).toBe(VARY);
        expect(res.headers['cache-control']).toContain('s-maxage=3600');
    });

    it('406s an Accept it cannot satisfy rather than lying with a 404 body', async () => {
        const res = mockRes();
        await handler({ method: 'GET', headers: { accept: 'application/pdf' } }, res);
        expect(res.code).toBe(406);
    });
});
