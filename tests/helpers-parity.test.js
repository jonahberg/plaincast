// ─── Fork-drift guard ───────────────────────────────────────────────
// tests/helpers.js hand-copies several pure functions out of docs/js/app.js so
// they can run without a DOM. That duplication is a standing hazard: a fix
// applied to one copy but not the other silently rots the tests (they would
// keep asserting old behavior). This suite reads both source files as text and
// asserts the forked function BODIES are code-identical — comments and
// whitespace are normalized away, so only logic drift trips it, and it trips
// loudly the moment app.js and helpers.js disagree.

import { describe, it, expect } from 'bun:test';

const APP = await Bun.file(new URL('../docs/js/app.js', import.meta.url)).text();
const HELPERS = await Bun.file(new URL('./helpers.js', import.meta.url)).text();

// Extract a function body (the outermost { … } block) by name. Regex quantifier
// braces like {2,3} are balanced pairs, so brace-counting stays correct; none of
// the forked bodies contain an unbalanced or string-embedded brace.
function fnBody(src, name) {
    const sig = new RegExp(`function\\s+${name}\\s*\\(`);
    const m = sig.exec(src);
    if (!m) throw new Error(`function ${name}() not found in source`);
    const open = src.indexOf('{', m.index);
    if (open < 0) throw new Error(`no opening brace for ${name}()`);
    let depth = 0;
    for (let j = open; j < src.length; j++) {
        const c = src[j];
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return src.slice(open, j + 1);
    }
    throw new Error(`unbalanced braces for ${name}()`);
}

// Strip comments + collapse whitespace so cosmetic differences don't false-fail.
// (No forked body contains a literal "//", "/*", or "*/" inside a regex/string,
// so comment stripping is safe here.)
function normalize(body) {
    return body
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Functions that MUST stay byte-for-byte (logic-wise) identical across the fork.
const FORKED = ['parseSections', 'stripAIArtifacts', 'stripNWSArtifacts', 'hasRealAlerts', 'reorderSections', 'escapeHTML'];

describe('helpers.js forks stay in lockstep with docs/js/app.js', () => {
    for (const name of FORKED) {
        it(`${name}() body is identical in both files`, () => {
            const app = normalize(fnBody(APP, name));
            const helper = normalize(fnBody(HELPERS, name));
            expect(helper).toBe(app);
        });
    }

    it('ALERT_PATTERN regex is identical in both files', () => {
        const grab = (src) => {
            const m = src.match(/const ALERT_PATTERN\s*=\s*(.+);\s*$/m);
            if (!m) throw new Error('ALERT_PATTERN not found');
            return m[1].trim();
        };
        expect(grab(HELPERS)).toBe(grab(APP));
    });
});
