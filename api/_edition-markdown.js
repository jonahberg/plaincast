// The Markdown representation of a Plaincast edition — what an agent gets when
// it asks a page for `Accept: text/markdown`.
//
// WHY THIS EXISTS: the HTML edition is a typeset broadsheet — masthead, folios,
// a two-column facsimile, a jargon layer. An agent wants none of that; it wants
// the forecaster's reasoning as prose. This renders the SAME decoded content
// the server already puts in #sections, with the chrome removed.
//
// NO AI HERE, DELIBERATELY — same contract as the SSR HTML. Everything below is
// the National Weather Service's own text run through regexTranslate
// (abbreviation expansion only). An agent asking for Markdown must not silently
// trigger model spend, and must not receive a summary it did not ask for.
//
// Files prefixed with `_` are not treated as endpoints by Vercel.

import { SECTION_NAMES } from '../docs/js/offices.js';
import { regexTranslate } from './_afd-sections.js';

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

// One decoded AFD, as Markdown. `sections` is the already-picked,
// already-paragraphed shape the SSR HTML uses: [{ key, paras: [string] }].
export function renderEditionMarkdown({
    code, city, sections, issued, changelogNote, canonical, moreHref,
}) {
    const lines = [];
    lines.push(`# ${city} (${code}) — the NWS forecast in plain English`);
    lines.push('');
    lines.push(`> Area Forecast Discussion · National Weather Service ${city} (${code})`
        + `${issued ? ` · issued ${issued}` : ''}.`);
    lines.push('');
    lines.push('This is the National Weather Service\'s own discussion with its shorthand expanded — '
        + 'no AI summary, no editing. Discussions are reissued 3 to 4 times a day.');
    if (changelogNote) {
        lines.push('');
        lines.push(changelogNote);
    }

    for (const s of sections) {
        lines.push('');
        lines.push(`## ${safeHeading(s.key)}`);
        lines.push('');
        for (const p of s.paras) {
            lines.push(regexTranslate(p));
            lines.push('');
        }
        lines.pop();
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
export function renderHomeMarkdown({ code, city, sections, issued, edition }) {
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
    lines.push('- Any of 68 forecast offices: `https://plaincast.live/o/<CODE>/` — a three-letter NWS office code, e.g. [/o/OKX/](https://plaincast.live/o/OKX/) for New York. Every code is listed in [/llms.txt](https://plaincast.live/llms.txt).');
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
        lines.push(`> ${issued ? `Issued ${issued}. ` : ''}This is the edition the site opens to by default; `
            + `it is not a national summary. Read another office at \`https://plaincast.live/o/<CODE>/\`.`);
        for (const s of sections) {
            lines.push('');
            lines.push(`### ${safeHeading(s.key)}`);
            lines.push('');
            for (const p of s.paras) {
                lines.push(regexTranslate(p));
                lines.push('');
            }
            lines.pop();
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
