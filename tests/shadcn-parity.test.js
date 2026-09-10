// ─── Fork-drift guard: shadcn edition ───────────────────────────────
// shadcn/src/lib/{afd,ai,almanac}.js port pure functions out of
// docs/js/app.js so the React app can share the vanilla client's exact
// behavior. Same hazard, same guard as tests/helpers-parity.test.js: read
// both sources as text and assert the forked function BODIES are
// code-identical (comments/whitespace normalized away), so a fix applied to
// one copy but not the other trips loudly.
//
// translateToPlainEnglish and extractTakeaway intentionally differ in the
// port (timezone parameter instead of the `currentOffice` global) and are
// covered behaviorally in tests/shadcn-afd.test.js instead.

import { describe, it, expect } from 'bun:test';

const APP = await Bun.file(new URL('../docs/js/app.js', import.meta.url)).text();
const SHADCN_AFD = await Bun.file(new URL('../shadcn/src/lib/afd.js', import.meta.url)).text();
const SHADCN_AI = await Bun.file(new URL('../shadcn/src/lib/ai.js', import.meta.url)).text();
const SHADCN_ALMANAC = await Bun.file(new URL('../shadcn/src/lib/almanac.js', import.meta.url)).text();

// Extract a function body (the outermost { … } block) by name. Regex
// quantifier braces like {2,3} are balanced pairs, so brace-counting stays
// correct (same technique as helpers-parity.test.js).
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

function normalize(body) {
    return body
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

const FORKS = [
    [SHADCN_AFD, 'shadcn/src/lib/afd.js', ['parseSections', 'stripAIArtifacts', 'escapeHTML', 'stripNWSArtifacts', 'hasRealAlerts', 'reorderSections']],
    [SHADCN_AI, 'shadcn/src/lib/ai.js', ['formatTranslationHTML']],
    [SHADCN_ALMANAC, 'shadcn/src/lib/almanac.js', ['sunTimes', 'moonPhase']],
];

describe('shadcn lib forks stay in lockstep with docs/js/app.js', () => {
    for (const [src, file, names] of FORKS) {
        for (const name of names) {
            it(`${name}() body is identical in app.js and ${file}`, () => {
                const app = normalize(fnBody(APP, name));
                const fork = normalize(fnBody(src, name));
                expect(fork).toBe(app);
            });
        }
    }
});
