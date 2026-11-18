// AI text for the server-rendered pages (PLAINCAST_AI_FOR_AGENTS=1): the
// stored, sanitized translation of a section, formatted for the SSR HTML
// and for the Markdown twin.
//
// The HTML is the app's own "Plain English" formatting: aiParagraphs(raw),
// each wrapped in <p>, is exactly formatTranslationHTML(raw) from
// shadcn/src/lib/ai.js (pinned by tests/engine-pages.test.js). That module
// is not imported here: it imports './afd' without an extension, which Bun
// resolves and Node's ESM loader does not.
//
// Files prefixed with `_` are not treated as endpoints by Vercel.
import { stripAIArtifacts } from '../shadcn/src/lib/afd.js';

// Raw model output → the inner HTML of each paragraph (escaped, **bold** →
// <strong>), in order.
export function aiParagraphs(raw) {
    const safe = stripAIArtifacts(raw)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return safe
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .split(/\n\s*\n+/)
        .filter(b => b.trim())
        .map(b => b.trim().replace(/\n/g, ' '));
}

// Raw model output → Markdown paragraphs that cannot open a block the page
// did not mean (a quote, a list, a heading, raw HTML): the text is the
// model's, so it is treated as untrusted at the start of every line.
export function aiMarkdownParagraphs(raw) {
    return stripAIArtifacts(raw)
        .split(/\n\s*\n+/)
        .map(b => b.trim().replace(/\s*\n\s*/g, ' '))
        .filter(Boolean)
        .map(p => p
            .replace(/</g, '&lt;')
            .replace(/^(\d+)([.)])(?=\s)/, '$1\\$2')
            .replace(/^(#{1,6}|>|[-+*](?=\s)|=+|\|)/, m => `\\${m}`));
}
