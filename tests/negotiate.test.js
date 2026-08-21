import { describe, it, expect } from 'bun:test';
import {
    parseAccept, selectRepresentation, wantsMarkdown, setVary, send406,
    sendNegotiated, HTML, MARKDOWN, VARY,
} from '../api/_negotiate.js';

function mockRes() {
    const res = { headers: {}, code: 200, body: null };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
    res.getHeader = (k) => res.headers[k.toLowerCase()];
    res.status = (c) => { res.code = c; return res; };
    res.send = (b) => { res.body = b; return res; };
    return res;
}

// The published test vectors from acceptmarkdown.com/guides/accept-parsing,
// transcribed verbatim. If one of these ever fails the site is no longer
// compliant, regardless of what the rest of the suite says.
describe('acceptmarkdown.com published test vectors', () => {
    const BOTH = [HTML, MARKDOWN]; // default (HTML) first

    it('`text/markdown` → markdown', () => {
        expect(selectRepresentation('text/markdown', BOTH)).toBe(MARKDOWN);
    });
    it('`text/markdown, text/html;q=0.8` → markdown', () => {
        expect(selectRepresentation('text/markdown, text/html;q=0.8', BOTH)).toBe(MARKDOWN);
    });
    it('`text/html` → html', () => {
        expect(selectRepresentation('text/html', BOTH)).toBe(HTML);
    });
    it('`text/markdown;q=0, text/html` → html', () => {
        expect(selectRepresentation('text/markdown;q=0, text/html', BOTH)).toBe(HTML);
    });
    it('`text/markdown;q=0` with markdown as the only representation → 406', () => {
        expect(selectRepresentation('text/markdown;q=0', [MARKDOWN])).toBe(null);
    });
    it('no Accept header → html (the default)', () => {
        expect(selectRepresentation(undefined, BOTH)).toBe(HTML);
        expect(selectRepresentation('', BOTH)).toBe(HTML);
    });
    it('`*/*` → html (the default)', () => {
        expect(selectRepresentation('*/*', BOTH)).toBe(HTML);
    });
});

describe('real-world Accept headers', () => {
    // The exact header the parsing guide names as the one that breaks
    // startsWith()/includes() implementations.
    const CHROME = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';

    it('a real Chrome header serves HTML, never markdown', () => {
        expect(selectRepresentation(CHROME, [HTML, MARKDOWN])).toBe(HTML);
        expect(wantsMarkdown(CHROME)).toBe(false);
    });
    it('agent header with a plain-text fallback still prefers markdown', () => {
        expect(wantsMarkdown('text/markdown, text/plain;q=0.5, */*;q=0.1')).toBe(true);
    });
    it('`text/*` matches markdown by subtype wildcard but loses to an exact html match', () => {
        expect(selectRepresentation('text/*', [HTML, MARKDOWN])).toBe(HTML);
        expect(selectRepresentation('text/*;q=0.5, text/markdown', [HTML, MARKDOWN])).toBe(MARKDOWN);
    });
    it('an exact q=0 beats a permissive wildcard (specificity tie-break)', () => {
        expect(selectRepresentation('*/*, text/markdown;q=0', [MARKDOWN])).toBe(null);
        expect(selectRepresentation('*/*, text/markdown;q=0', [HTML, MARKDOWN])).toBe(HTML);
    });
    it('unsatisfiable Accept → null (→ 406)', () => {
        expect(selectRepresentation('application/pdf', [HTML, MARKDOWN])).toBe(null);
        expect(selectRepresentation('image/png, application/zip', [HTML, MARKDOWN])).toBe(null);
    });
    it('case and whitespace are insensitive', () => {
        expect(selectRepresentation('  TEXT/MARKDOWN ; Q=1.0 ', [HTML, MARKDOWN])).toBe(MARKDOWN);
    });
    it('a malformed header degrades to the default rather than 406', () => {
        expect(selectRepresentation('garbage', [HTML, MARKDOWN])).toBe(HTML);
        expect(selectRepresentation(',,,', [HTML, MARKDOWN])).toBe(HTML);
        expect(selectRepresentation('text/markdown;q=notanumber', [HTML, MARKDOWN])).toBe(MARKDOWN);
    });
});

describe('parseAccept', () => {
    it('reads q-values and specificity', () => {
        expect(parseAccept('text/markdown, text/html;q=0.8, */*;q=0.1')).toEqual([
            { type: 'text', subtype: 'markdown', q: 1, specificity: 2, index: 0 },
            { type: 'text', subtype: 'html', q: 0.8, specificity: 2, index: 1 },
            { type: '*', subtype: '*', q: 0.1, specificity: 0, index: 2 },
        ]);
    });
    it('clamps q outside 0..1 and drops entries with no subtype', () => {
        expect(parseAccept('text/markdown;q=9')[0].q).toBe(1);
        expect(parseAccept('text/markdown;q=-3')[0].q).toBe(0);
        expect(parseAccept('nonsense')).toEqual([]);
    });
});

describe('Vary', () => {
    it('sets Accept and Accept-Encoding', () => {
        const res = mockRes();
        setVary(res);
        expect(res.headers.vary).toBe(VARY);
        expect(VARY).toContain('Accept');
    });
    it('merges into an existing Vary without duplicating', () => {
        const res = mockRes();
        res.setHeader('Vary', 'Accept-Encoding');
        setVary(res);
        expect(res.headers.vary).toBe('Accept-Encoding, Accept');
    });
});

describe('406 responses', () => {
    it('lists the available representations and is never cached', () => {
        const res = mockRes();
        send406(res, [HTML, MARKDOWN], 'application/pdf');
        expect(res.code).toBe(406);
        expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers.vary).toBe(VARY);
        expect(res.body).toContain('- text/html');
        expect(res.body).toContain('- text/markdown');
        expect(res.body).toContain('You requested: application/pdf');
    });
});

describe('sendNegotiated', () => {
    const bodies = { [HTML]: '<h1>hi</h1>', [MARKDOWN]: '# hi' };

    it('serves HTML by default, with Vary on the response', () => {
        const res = mockRes();
        sendNegotiated({ headers: {} }, res, bodies, { cacheControl: 'public, s-maxage=60' });
        expect(res.code).toBe(200);
        expect(res.body).toBe('<h1>hi</h1>');
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.headers.vary).toBe(VARY);
        expect(res.headers['cache-control']).toBe('public, s-maxage=60');
    });
    it('serves markdown when asked, with the RFC 7763 media type', () => {
        const res = mockRes();
        sendNegotiated({ headers: { accept: 'text/markdown' } }, res, bodies);
        expect(res.body).toBe('# hi');
        expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
        expect(res.headers.vary).toBe(VARY);
    });
    it('406s when nothing offered is acceptable', () => {
        const res = mockRes();
        sendNegotiated({ headers: { accept: 'application/pdf' } }, res, bodies);
        expect(res.code).toBe(406);
        expect(res.headers.vary).toBe(VARY);
    });
    it('carries a non-200 status through (404 pages negotiate too)', () => {
        const res = mockRes();
        sendNegotiated({ headers: { accept: 'text/markdown' } }, res, bodies, { status: 404 });
        expect(res.code).toBe(404);
        expect(res.body).toBe('# hi');
    });
});
