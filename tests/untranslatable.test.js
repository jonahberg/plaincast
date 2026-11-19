// ─── Sections that are never AI-translated: one shared rule ─────────
// docs/js/untranslatable.js isUntranslatable(key, text): tables
// (docs/js/tabular.js) and sections under 25 words once their stamp is
// removed. Measured on real model output (Nov 18 2026), short notes came
// back padded to 2-5 times their length, or as commentary about the
// document; they are already plain English. One predicate, so the four call
// sites cannot drift: the server's selection (edition path, poller, the
// COMPLETE rule), the single-section endpoint, and both clients.

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
    MIN_TRANSLATABLE_WORDS, isShortSection, isUntranslatable, sectionWordCount, stripHeaderStamp,
} from '../docs/js/untranslatable.js';
import { stripHeaderStamp as translateStrip, buildSectionIndex, findMatchingSection } from '../api/translate.js';
import { translatableSections, untranslatableDisplayKeys } from '../api/_translatable.js';
import { translateEdition } from '../api/translate-issuance.js';
import { pickTranslations } from '../api/_boot.js';
import { parseSections } from '../shadcn/src/lib/afd.js';

const live = (code) => JSON.parse(readFileSync(new URL(`./fixtures/afd/live-2026-11-18/${code}.json`, import.meta.url), 'utf8'));
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('the short-section rule', () => {
    it('counts words; fewer than 25 is short', () => {
        expect(MIN_TRANSLATABLE_WORDS).toBe(25);
        expect(sectionWordCount(words(24))).toBe(24);
        expect(isShortSection(words(24))).toBe(true);
        expect(isShortSection(words(25))).toBe(false);
    });

    it('does not count the stamp or the "Issued at" line (stripHeaderStamp semantics)', () => {
        expect(sectionWordCount(`18/104 PM.\n\n${words(24)}`)).toBe(24);
        expect(sectionWordCount(`Issued at 528 PM CST Wed Nov 18 2026\n\n${words(24)}`)).toBe(24);
        expect(isShortSection(`Issued at 528 PM CST Wed Nov 18 2026\n\n${words(24)}`)).toBe(true);
        // a qualifier line is content and counts
        expect(sectionWordCount(`(00Z TAFS)\nIssued at 528 PM CST Wed Nov 18 2026\n${words(23)}`)).toBe(25);
    });

    it('splits on NWS "..." and ignores tokens with no letter or digit', () => {
        expect(sectionWordCount('Updated...No changes - && to the forecast.')).toBe(6);
    });

    it('the real short notes of Nov 18 2026', () => {
        expect(isShortSection('Updated aviation section for the 00Z TAFs. No changes to the forecast.')).toBe(true);
        expect(isShortSection('Spotter activation is not expected at this time.')).toBe(true);
        expect(isShortSection('No significant changes.')).toBe(true);
    });

    it('is the same stripHeaderStamp the prompt uses (one copy)', () => {
        expect(translateStrip).toBe(stripHeaderStamp);
    });
});

describe('isUntranslatable: tables or short sections, by raw or display key', () => {
    it('catches a table by name with either key form, and by shape', () => {
        const table = 'TLH  70  50  72  55 /  10   0   0  10\nVLD  71  52  74  56 /  10   0   0  10\nABY  69  49  71  53 /   0   0   0  10';
        expect(isUntranslatable('PRELIMINARY POINT TEMPS/POPS', words(40))).toBe(true);
        expect(isUntranslatable('Preliminary point temps/pops', words(40))).toBe(true);
        expect(isUntranslatable('City forecasts', table)).toBe(true);
    });

    it('a long prose section is translated', () => {
        expect(isUntranslatable('Discussion', words(30))).toBe(false);
        expect(isUntranslatable('DISCUSSION', words(30))).toBe(false);
    });
});

describe('real products (Nov 18 2026): the server selection', () => {
    it('PHI: the 12-word "What has changed" and 23-word Key Messages are not sent', () => {
        const { productText } = live('PHI');
        expect(translatableSections(productText).map(s => s.key)).toEqual(['Discussion', 'Aviation', 'Marine']);
        expect([...untranslatableDisplayKeys(productText)]).toEqual(expect.arrayContaining(['What has changed', 'Messages']));
    });

    it('FWD: the 8-word spotter statement and the table are not sent', () => {
        expect(translatableSections(live('FWD').productText).map(s => s.key))
            .toEqual(['Messages', 'Short Term', 'Long Term', 'Aviation']);
    });

    it('an edition missing only its excluded sections is COMPLETE (endpoint, poller, page)', async () => {
        const { id, issuanceTime, productText } = live('PHI');
        // Stored reuse text stands in for the model: no call is made.
        const sections = translatableSections(productText).map(s => ({ ...s, reused: `Summary of ${s.key}.` }));
        const payload = await translateEdition({ office: 'PHI', id, issuanceTime, productText, sections });
        expect(payload.complete).toBe(true);
        expect(Object.keys(payload.sections)).toEqual(['Discussion', 'Aviation', 'Marine']);
    });

    it('boot data drops a stored translation of an excluded section (one from before the rule)', () => {
        const { id, productText } = live('PHI');
        const stored = { office: 'PHI', id, complete: true, sections: { 'What has changed': 'Padded.', Discussion: 'Rain Sunday.' } };
        const { translations, complete } = pickTranslations(stored, 'PHI', id, productText);
        expect(translations).toEqual({ Discussion: 'Rain Sunday.' });
        expect(complete).toBe(true);
    });
});

describe('/api/translate: an excluded section is never indexed (an old client gets the 403)', () => {
    for (const code of ['PHI', 'FWD', 'SGX']) {
        it(`${code}: each client section verifies exactly when the rule translates it`, () => {
            const { productText } = live(code);
            const products = [{ sections: buildSectionIndex(productText) }];
            for (const s of parseSections(productText).sections) {
                if (s.key === 'Active Alerts') continue;
                const match = findMatchingSection(s.text, products);
                if (isUntranslatable(s.key, s.text)) expect(match).toBeNull();
                else expect(match).not.toBeNull();
            }
        });
    }
});

describe('both clients ask only for sections the rule translates', () => {
    it('shadcn: aiEligible excludes the shared rule\'s sections', () => {
        const app = read('shadcn/src/App.jsx');
        expect(app).toContain("import { isUntranslatable } from '@data/untranslatable.js';");
        expect(app).toMatch(/filter\(s => isUntranslatable\(s\.key, s\.text\)\)/);
        expect(app).toContain("aiEligible={section.key !== 'Active Alerts' && !state.offline && !untranslatable.has(section.key)}");
        // An ineligible section starts 'off': no "Summarizing…", no "via Claude", nothing to swap.
        const card = read('shadcn/src/components/ForecastSection.jsx');
        expect(card).toContain("status: aiEligible ? 'idle' : 'off'");
        expect(card).toContain("ai.status !== 'off' && (");
    });

    it('legacy: no request and no "Summarizing…" for the shared rule\'s sections', () => {
        const app = read('docs/js/app.js');
        expect(app).toContain("import { isUntranslatable } from './untranslatable.js';");
        expect(app).toContain("const toTranslate = sections.filter(s => s.key !== 'Active Alerts' && !isUntranslatable(s.key, s.text));");
        expect(app).toMatch(/\} else if \(isUntranslatable\(s\.key, s\.text\)\) \{\n\s+plainHtml = translateToPlainEnglish\(s\.text, productContext\.issuanceTime\);/);
    });
});
