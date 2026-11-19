// The Markdown representation of a Plaincast edition — what an agent gets when
// it asks a page for `Accept: text/markdown`.
//
// WHY THIS EXISTS: the HTML edition is a typeset broadsheet — masthead, folios,
// a two-column facsimile, a jargon layer. An agent wants none of that; it wants
// the forecaster's reasoning as prose. This renders the SAME decoded content
// the server already puts in #sections, with the chrome removed.
//
// NO AI BY DEFAULT. Everything below is the National Weather Service's own
// text run through regexTranslate (abbreviation expansion only), unless
// PLAINCAST_AI_FOR_AGENTS=1 and the page holds a complete, stored
// translation of this exact edition (api/office-page.js aiForSections). Then
// each section leads with the AI summary, labelled as written by Claude from
// the NWS text, followed by that text labelled as the original, and the
// preamble says so for this response. A render never triggers model spend:
// the AI text is read from the store, never generated here.
//
// Files prefixed with `_` are not treated as endpoints by Vercel.

import { OFFICE_NAMES, SECTION_NAMES } from '../docs/js/offices.js';
import { regexTranslate } from './_afd-sections.js';
import { aiMarkdownParagraphs } from './_ai-text.js';

const FOOTER_LINKS = '[Home](https://plaincast.live/) · '
    + '[The National Desk](https://plaincast.live/national/) · '
    + '[About](https://plaincast.live/about) · '
    + '[Contact](https://plaincast.live/contact) · '
    + '[Privacy](https://plaincast.live/privacy) · '
    + '[llms.txt](https://plaincast.live/llms.txt)';

function titleCase(key) {
    return String(key).toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
}

// A section heading is untrusted upstream text landing at the start of a line.
// Markdown has no escaping story for that, so the key is reduced to a safe
// label: no newlines, no leading punctuation that could start a block.
function safeHeading(key) {
    return String(SECTION_NAMES[key] || titleCase(key))
        .replace(/[\r\n]+/g, ' ')
        .replace(/^[^\w(]+/, '')
        .replace(/\s+/g, ' ')
        .trim() || 'Discussion';
}

// The preamble line, per response: whether THIS body carries AI text.
export const PREAMBLE_NO_AI = 'This is the National Weather Service\'s own discussion with its shorthand expanded — '
    + 'no AI summary, no editing. Discussions are reissued 3 to 4 times a day.';
export const PREAMBLE_AI = 'This response includes AI-generated text: each section opens with a plain-English summary '
    + 'written by Claude, an AI model, from the National Weather Service\'s text, followed by that text itself '
    + '(the original, with its shorthand expanded). The original is authoritative. Discussions are reissued '
    + '3 to 4 times a day.';
export const HOME_NO_AI = 'This edition is the National Weather Service\'s own text with its shorthand expanded; '
    + 'no AI summary is included in this response.';
export const AI_LABEL_MD = '**AI summary** (written by Claude from the National Weather Service text below):';
export const NWS_LABEL_MD = '**Original National Weather Service text** (shorthand expanded):';

// One section's body lines: the NWS paragraphs, or (with `s.ai`) the
// labelled AI summary, then the labelled original.
function sectionLines(s) {
    const lines = [];
    if (s.ai) {
        lines.push(AI_LABEL_MD, '');
        for (const p of aiMarkdownParagraphs(s.ai)) lines.push(p, '');
        lines.push(NWS_LABEL_MD, '');
    }
    for (const p of s.paras) {
        lines.push(regexTranslate(p));
        lines.push('');
    }
    lines.pop();
    return lines;
}

// "issued <date>", with the ISO instant after it when asked (AI switch on).
function issuedText(issued, issuedIso) {
    if (!issued) return '';
    const iso = typeof issuedIso === 'string' && Number.isFinite(Date.parse(issuedIso)) ? issuedIso : null;
    return iso ? `${issued} (${iso})` : issued;
}

// One decoded AFD, as Markdown. `sections` is the already-picked,
// already-paragraphed shape the SSR HTML uses: [{ key, paras: [string], ai? }].
// `aiIncluded` and `issuedIso` are passed only with PLAINCAST_AI_FOR_AGENTS=1.
export function renderEditionMarkdown({
    code, city, sections, issued, changelogNote, canonical, moreHref, aiIncluded = false, issuedIso = null,
}) {
    const lines = [];
    lines.push(`# ${city} (${code}) — the NWS forecast in plain English`);
    lines.push('');
    lines.push(`> Area Forecast Discussion · National Weather Service ${city} (${code})`
        + `${issued ? ` · issued ${issuedText(issued, issuedIso)}` : ''}.`);
    lines.push('');
    lines.push(aiIncluded ? PREAMBLE_AI : PREAMBLE_NO_AI);
    if (changelogNote) {
        lines.push('');
        lines.push(changelogNote);
    }

    for (const s of sections) {
        lines.push('');
        lines.push(`## ${safeHeading(s.key)}`);
        lines.push('');
        lines.push(...sectionLines(aiIncluded ? s : { ...s, ai: null }));
    }

    lines.push('');
    lines.push('---');
    lines.push('');
    if (moreHref) {
        lines.push(`Full edition, with the AI plain-English summary beside the annotated original: [${moreHref}](${moreHref})`);
        lines.push('');
    }
    lines.push(`Source: [National Weather Service](https://www.weather.gov) ${city} (${code}). `
        + `Every office: [/sitemap.xml](https://plaincast.live/sitemap.xml). `
        + `RSS: \`https://plaincast.live/api/feed?office=${code}\`.`);
    lines.push('');
    lines.push(`_Canonical: ${canonical}_`);
    lines.push('');
    lines.push(FOOTER_LINKS);
    lines.push('');
    return lines.join('\n');
}

// The homepage's Markdown: what Plaincast is, then today's edition. An agent
// that lands on `/` with no other context should be able to answer "what is
// this site, and should I use it" from this alone.
// `aiIncluded` and `issuedIso` as for renderEditionMarkdown (AI switch only).
// (`aiIncluded` undefined, the switch off: no statement either way, as before.)
export function renderHomeMarkdown({ code, city, sections, issued, edition, aiIncluded, issuedIso = null }) {
    const lines = [];
    lines.push('# Plaincast — what the forecast actually says');
    lines.push('');
    lines.push('> The National Weather Service\'s Area Forecast Discussion — the real forecast, '
        + 'written 3 to 4 times a day by the meteorologist on shift — translated into plain English.');
    lines.push('');
    lines.push('An Area Forecast Discussion is where a forecaster explains their reasoning: which models '
        + 'disagree, what they are watching, how confident they are, and what would have to change for the '
        + 'forecast to bust. It is the most informative weather product the government publishes and the '
        + 'least readable, because it is written in dense shorthand for other meteorologists. Plaincast '
        + 'decodes it, and shows the plain-English summary beside the annotated original so the '
        + 'forecaster\'s own words are always one glance away.');
    lines.push('');
    lines.push('## How to use it');
    lines.push('');
    lines.push(`- Any of ${Object.keys(OFFICE_NAMES).length} forecast offices: \`https://plaincast.live/o/<CODE>/\` — a three-letter NWS office code, e.g. [/o/OKX/](https://plaincast.live/o/OKX/) for New York. Every code is listed in [/llms.txt](https://plaincast.live/llms.txt).`);
    lines.push('- What changed since the previous discussion: `https://plaincast.live/o/<CODE>/?view=changelog`');
    lines.push('- Where the weather is today, nationally: [The National Desk](https://plaincast.live/national/)');
    lines.push('- RSS per office: `https://plaincast.live/api/feed?office=<CODE>`');
    lines.push('- Every page on this site serves this Markdown representation to `Accept: text/markdown`.');
    lines.push('');
    lines.push('For a life-safety decision, read the original at [weather.gov](https://www.weather.gov). '
        + 'Plaincast summarizes a discussion product that can be several hours old.');

    if (edition) {
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push(`## Today's edition — ${city} (${code})`);
        lines.push('');
        lines.push(`> ${issued ? `Issued ${issuedText(issued, issuedIso)}. ` : ''}This is the edition the site opens to by default; `
            + `it is not a national summary. Read another office at \`https://plaincast.live/o/<CODE>/\`.`);
        if (aiIncluded === true) {
            lines.push('');
            lines.push(PREAMBLE_AI);
        } else if (aiIncluded === false) {
            lines.push('');
            lines.push(HOME_NO_AI);
        }
        for (const s of sections) {
            lines.push('');
            lines.push(`### ${safeHeading(s.key)}`);
            lines.push('');
            lines.push(...sectionLines(aiIncluded === true ? s : { ...s, ai: null }));
        }
        lines.push('');
        lines.push(`Full ${city} edition: [https://plaincast.live/o/${code}/](https://plaincast.live/o/${code}/)`);
    }

    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('Source: [National Weather Service](https://www.weather.gov) and the '
        + '[Storm Prediction Center](https://www.spc.noaa.gov). Plaincast is an independent project by '
        + '[Jonah Berg](https://jonahberg.com) and is not affiliated with NOAA.');
    lines.push('');
    lines.push('_Canonical: https://plaincast.live/_');
    lines.push('');
    lines.push(FOOTER_LINKS);
    lines.push('');
    return lines.join('\n');
}
