import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICE_NAMES } from '../docs/js/offices.js';
import { CODES } from '../api/_errors.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(join(ROOT, 'docs', 'openapi.json'), 'utf8'));
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));

describe('OpenAPI spec', () => {
    it('is OpenAPI 3.1 with the required info block', () => {
        expect(spec.openapi).toBe('3.1.0');
        expect(spec.info.title).toBe('Plaincast');
        expect(spec.info.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(spec.info.contact.name).toBe('Jonah Berg');
        expect(spec.servers[0].url).toBe('https://plaincast.live');
    });

    // Standing rule: the public name is "Jonah Berg", never the hyphenated form.
    it('never uses the hyphenated surname', () => {
        expect(JSON.stringify(spec)).not.toContain('Berg-Ganzarain');
    });

    it('declares no authentication, because there genuinely is none', () => {
        expect(spec.security).toEqual([]);
        expect(spec.info.description).toContain('No API key');
    });

    it('every documented path resolves to a real route', () => {
        const rewrites = vercel.rewrites.map(r => r.source);
        for (const p of Object.keys(spec.paths)) {
            if (p === '/') { expect(rewrites).toContain('/'); continue; }
            if (p.startsWith('/api/')) {
                // /api/* is served by the file at api/<name>.js
                const name = p.slice('/api/'.length);
                expect(() => readFileSync(join(ROOT, 'api', `${name}.js`))).not.toThrow();
                continue;
            }
            // page paths: /o/{code}/ and /national/ map to parameterised rewrites
            const asRewrite = p.replace('{code}', ':code');
            expect(rewrites).toContain(asRewrite);
        }
    });

    it('lists all 68 office codes, straight from OFFICE_NAMES', () => {
        const codes = Object.keys(OFFICE_NAMES);
        const enums = JSON.stringify(spec).match(/"enum":\["[A-Z]{3}"[^\]]*\]/g) || [];
        expect(enums.length).toBeGreaterThan(0);
        for (const e of enums) {
            const listed = JSON.parse(e.slice('"enum":'.length));
            expect(listed).toEqual(codes);
        }
    });

    it('documents the Markdown contract on the page endpoints', () => {
        for (const p of ['/', '/o/{code}/', '/national/']) {
            const ok = spec.paths[p].get.responses['200'].content;
            expect(Object.keys(ok)).toContain('text/markdown');
            expect(Object.keys(ok)).toContain('text/html');
            expect(spec.paths[p].get.responses['406']).toBeTruthy();
        }
    });

    it('the Error schema matches the codes api/_errors.js actually emits', () => {
        const declared = spec.components.schemas.Error.properties.code.enum;
        expect(declared.sort()).toEqual(Object.keys(CODES).sort());
        expect(spec.components.schemas.Error.required).toContain('code');
        expect(spec.components.schemas.Error.required).toContain('hint');
    });

    it('every JSON endpoint documents at least one structured error response', () => {
        for (const [p, ops] of Object.entries(spec.paths)) {
            if (!p.startsWith('/api/')) continue;
            const codes = Object.keys(ops.get.responses).filter(c => c.startsWith('4') || c.startsWith('5'));
            expect(codes.length).toBeGreaterThan(0);
        }
    });

    // The AI endpoints spend model budget per call and are rate-limited per IP.
    // Publishing them in the spec would advertise them as a third-party API.
    it('does not advertise the AI backend', () => {
        const paths = Object.keys(spec.paths).join(' ');
        for (const internal of ['translate', 'changelog', 'explain-alert', 'national-lede']) {
            expect(paths).not.toContain(internal);
        }
        expect(spec.info.description).toContain('not supported');
    });

    it('is served as a static file, so no rewrite can shadow it', () => {
        // docs/ is outputDirectory; docs/openapi.json therefore resolves at
        // /openapi.json during `handle: filesystem`, before every rewrite.
        expect(() => readFileSync(join(ROOT, 'docs', 'openapi.json'))).not.toThrow();
        const ignored = readFileSync(join(ROOT, '.vercelignore'), 'utf8');
        expect(ignored).not.toMatch(/^docs\/openapi\.json$/m);
    });
});
