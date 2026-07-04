// Vercel serverless function: RSS feed per NWS office
// Uses regex translation (no AI cost) for feed content

import { OFFICE_NAMES, OFFICE_TIMEZONES } from '../docs/js/offices.js';
import { BASIC_ABBREVIATIONS } from '../docs/js/abbreviations.js';
import { fetchAFDList, fetchAFDProduct, productUrlFromItem } from './_utils.js';
import { extractLede, sectionHealth, stripWmoHeader } from './_afd-sections.js';
import { changedParagraphs } from './changelog.js';

const VALID_OFFICES = new Set(Object.keys(OFFICE_NAMES));

// Offices already warned about unparseable AFDs (format drift), once per instance.
const warnedOffices = new Set();

// Regex translation using shared abbreviation patterns
function regexTranslate(text) {
    let t = text;
    t = t.replace(/\.{3,}/g, '. ');
    t = t.replace(/[ \t]{2,}/g, ' ');
    for (const [pat, rep] of BASIC_ABBREVIATIONS) t = t.replace(pat, rep);
    return t.trim();
}

function escapeXml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// "Fri, Jul 3, 3:50 PM EDT" in the office's local time, so same-day issuances
// stay distinguishable in feed readers. Date and time are formatted separately
// (a single toLocaleString varies across ICU versions: "Jul 3, 3:50 PM" vs
// "Jul 3 at 3:50 PM"), and the narrow no-break space some ICUs put before
// AM/PM is normalized to a plain space for deterministic feed output.
function formatIssuedLocal(issued, office) {
    const timeZone = OFFICE_TIMEZONES[office] || 'UTC';
    const date = issued.toLocaleDateString('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' });
    const time = issued.toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    return `${date}, ${time}`.replace(/[\u202f\u00a0]/g, ' ');
}

// Paragraphs that differ on every issuance but carry no forecast signal —
// the product mast repeats the issuance timestamp, so a raw diff always
// flags it as "changed".
function isMastNoise(p) {
    return /^(Area Forecast Discussion|National Weather Service)/i.test(p)
        || /^\d{3,4} (AM|PM) [A-Z]{2,4}\b/.test(p);
}

// ".SHORT TERM (Today through Saturday)..." → just the body text after it.
function stripSectionHeader(p) {
    return p.replace(/^\.[A-Z][A-Z0-9 /()'&.-]*?\.\.\.\s*/, '').trim();
}

// Plain-English "what changed" summary from the paragraph-level diff against
// the previous issuance. Pure text processing — zero AI spend from the feed.
function buildDelta(prevText, currText) {
    if (!prevText || !currText) return '';
    return changedParagraphs(prevText, currText)
        .filter(p => !isMastNoise(p))
        .map(stripSectionHeader)
        .filter(p => p.length >= 40)
        .slice(0, 2)
        .map(regexTranslate)
        .join(' ');
}

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

    const office = (req.query.office || '').toUpperCase();
    if (!office || !VALID_OFFICES.has(office)) {
        return res.status(400).json({ error: 'Invalid office. Use ?office=LOX (3-letter NWS code)' });
    }

    try {
        const items = (await fetchAFDList(office, { signal: AbortSignal.timeout(10000) })).slice(0, 10);

        const cityName = OFFICE_NAMES[office] || office;
        const feedTitle = `Plaincast — ${cityName} (${office}) Forecast`;
        const feedLink = `https://plaincast.live/?office=${office}`;

        // Phase 1: fetch the products in parallel (a cold cache was ~11
        // sequential round-trips ≈ 4s+ TTFB), kept positional so each issuance
        // can diff against the one before it (newest first).
        const fetched = await Promise.all(items.map(async (item) => {
            try {
                const prodUrl = productUrlFromItem(item);
                if (!prodUrl || !item?.id) return null;
                const prodData = await fetchAFDProduct(prodUrl, { signal: AbortSignal.timeout(10000) });
                const text = typeof prodData?.productText === 'string' ? prodData.productText : '';
                const issued = new Date(prodData?.issuanceTime);
                if (!text || Number.isNaN(issued.getTime())) return null;
                return { id: String(item.id), text, issued };
            } catch (e) { return null; /* skip failed items */ }
        }));

        // Phase 2: compose the feed — delta-first descriptions, unique
        // per-edition permalinks (readers dedupe items that share a link).
        let rssItems = '';
        for (let i = 0; i < fetched.length; i++) {
            const cur = fetched[i];
            if (!cur) continue;
            const health = sectionHealth(cur.text);
            if (health.sectionCount === 0 && !warnedOffices.has(office)) {
                warnedOffices.add(office);
                console.warn(`[feed] AFD format drift: ${office} parsed 0 sections (format=${health.format})`);
            }
            // Extract the lede (SYNOPSIS or Key Message format sections) for description
            const lede = extractLede(cur.text);
            const synopsis = regexTranslate(lede || stripWmoHeader(cur.text).substring(0, 500));
            // The oldest fetched issuance has nothing to diff against → lede only.
            const delta = buildDelta(fetched[i + 1]?.text, cur.text);
            const deltaLine = delta ? `What changed: ${delta.substring(0, 600)}` : '';
            const description = [deltaLine, synopsis].filter(Boolean).join('\n\n').substring(0, 1000);
            const permalink = `https://plaincast.live/o/${office}/?edition=${encodeURIComponent(cur.id)}`;
            const pubDate = cur.issued.toUTCString();

            rssItems += `    <item>
      <title>${escapeXml(cityName)} forecast — ${escapeXml(formatIssuedLocal(cur.issued, office))}</title>
      <link>${escapeXml(permalink)}</link>
      <guid isPermaLink="true">${escapeXml(permalink)}</guid>
      <pubDate>${escapeXml(pubDate)}</pubDate>
      <description>${escapeXml(description)}</description>
    </item>\n`;
        }

        const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(feedTitle)}</title>
    <link>${escapeXml(feedLink)}</link>
    <description>NWS Area Forecast Discussions for ${escapeXml(cityName)} decoded into plain English by Plaincast</description>
    <language>en-us</language>
    <atom:link href="https://plaincast.live/api/feed?office=${office}" rel="self" type="application/rss+xml"/>
${rssItems}  </channel>
</rss>`;

        res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
        res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');
        return res.status(200).send(rss);
    } catch (err) {
        console.error('Feed error:', err);
        return res.status(502).json({ error: 'Failed to generate feed' });
    }
}
