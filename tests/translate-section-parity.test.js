import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { parseSections } from '../shadcn/src/lib/afd.js';
import { buildSectionIndex, findMatchingSection, canonicalSectionKey } from '../api/translate.js';

// Parity lock for /api/translate's exact-section verification (Sep 28 2026
// audit). The React client POSTs `section.text` straight from parseSections()
// (shadcn/src/lib/afd.js). Every such section must verify, or real readers get
// a 403 and lose the AI translation.
//
// Measured on the live latest AFD of all 68 offices (Sep 28 2026): 319/319
// client sections verified, 0 false rejects. extractSections() ALONE would
// have rejected 12 of them across 6 offices (it keeps forecaster signatures
// such as "-TAD" / "Smith" that the client strips), which is why the server
// index is built from the client parser first. Those 6 products are the
// live-2026-09-28 fixtures below.
const LIVE_DIR = new URL('./fixtures/afd/live-2026-09-28/', import.meta.url);
const live = readdirSync(LIVE_DIR).filter(f => f.endsWith('.json')).map(f => ({
    name: f,
    ...JSON.parse(readFileSync(new URL(f, LIVE_DIR), 'utf8')),
}));
const CLASSIC_DIR = new URL('./fixtures/afd/', import.meta.url);
const classic = readdirSync(CLASSIC_DIR).filter(f => f.endsWith('.txt')).map(f => ({
    name: f,
    productText: readFileSync(new URL(f, CLASSIC_DIR), 'utf8'),
}));
const ALL = [...live, ...classic];

// Exactly what ForecastSection → translateSection → fetchAITranslation sends.
function clientPosts(productText) {
    return parseSections(productText).sections
        .filter(s => s.key !== 'Active Alerts') // aiEligible === false
        .map(s => JSON.parse(JSON.stringify({ text: s.text, section: s.key })))
        .filter(b => b.text.length >= 20); // shorter bodies 400 before verification
}

const norm = s => String(s).replace(/\$\$|&&/g, ' ').replace(/\s+/g, ' ').trim();

describe('translate verification ⇄ client parser parity', () => {
    it('has the live divergence fixtures', () => {
        expect(live.length).toBeGreaterThanOrEqual(6);
    });

    for (const fx of ALL) {
        it(`${fx.name}: every section the client sends verifies, under its own label`, () => {
            const products = [{ sections: buildSectionIndex(fx.productText), issuanceTime: fx.issuanceTime || null }];
            const posts = clientPosts(fx.productText);
            expect(posts.length).toBeGreaterThan(0);
            for (const body of posts) {
                const m = findMatchingSection(body.text, products);
                expect(m).not.toBeNull();
                expect(m.sectionKey).toBe(canonicalSectionKey(body.section));
            }
        });

        it(`${fx.name}: a 20-char mid-section substring never verifies`, () => {
            const products = [{ sections: buildSectionIndex(fx.productText) }];
            for (const body of clientPosts(fx.productText)) {
                const n = norm(body.text);
                if (n.length < 60) continue;
                const mid = n.slice(Math.floor(n.length / 2) - 10, Math.floor(n.length / 2) + 10);
                expect(findMatchingSection(mid, products)).toBeNull();
            }
        });
    }

});
