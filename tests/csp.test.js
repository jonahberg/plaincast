import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_JS = join(ROOT, 'docs', 'js', 'app.js');
const VERCEL_JSON = join(ROOT, 'vercel.json');

describe('CSP compatibility', () => {
    it('script-src stays locked to \'self\' with no \'unsafe-inline\'', () => {
        const csp = JSON.parse(readFileSync(VERCEL_JSON, 'utf8'));
        const cspHeader = JSON.stringify(csp);
        expect(cspHeader).toContain("script-src 'self'");
        // If a future change re-adds 'unsafe-inline' to script-src, this assertion
        // documents the intent — inline handlers below would then be permitted.
        expect(/script-src 'self'\s*;/.test(cspHeader) || /script-src 'self'"/.test(cspHeader)).toBe(true);
    });

    it('app.js emits no inline on*= event-handler attributes (refused under CSP)', () => {
        const src = readFileSync(APP_JS, 'utf8');
        // Match inline HTML event handlers like onclick="...", onload='...' emitted
        // inside string literals. These are silently blocked by script-src 'self'.
        const inlineHandlers = src.match(/\son(?:click|load|error|change|submit|input|mouseover|focus|blur|keydown|keyup)\s*=\s*["'][^"']*["']/gi) || [];
        expect(inlineHandlers).toEqual([]);
    });
});
