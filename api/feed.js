// Vercel serverless function: RSS feed per NWS office
// Uses regex translation (no AI cost) for feed content

import { OFFICE_NAMES } from '../docs/js/offices.js';
import { BASIC_ABBREVIATIONS } from '../docs/js/abbreviations.js';
import { fetchAFDList, fetchAFDProduct, productUrlFromItem } from './_utils.js';
import { extractLede, sectionHealth, stripWmoHeader } from './_afd-sections.js';

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

        let rssItems = '';
        for (const item of items) {
            try {
                const prodUrl = productUrlFromItem(item);
                if (!prodUrl) continue;
                const prodData = await fetchAFDProduct(prodUrl, { signal: AbortSignal.timeout(10000) });
                const text = typeof prodData?.productText === 'string' ? prodData.productText : '';
                const issued = new Date(prodData?.issuanceTime);
                if (!text || Number.isNaN(issued.getTime()) || !item?.id) continue;
                // Extract the lede (SYNOPSIS or Key Message format sections) for description
                const health = sectionHealth(text);
                if (health.sectionCount === 0 && !warnedOffices.has(office)) {
                    warnedOffices.add(office);
                    console.warn(`[feed] AFD format drift: ${office} parsed 0 sections (format=${health.format})`);
                }
                const lede = extractLede(text);
                const synopsis = regexTranslate(lede || stripWmoHeader(text).substring(0, 500));
                const pubDate = issued.toUTCString();

                rssItems += `    <item>
      <title>${escapeXml(cityName)} Forecast - ${escapeXml(issued.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))}</title>
      <link>${escapeXml(feedLink)}</link>
      <guid isPermaLink="false">${escapeXml(String(item.id))}</guid>
      <pubDate>${escapeXml(pubDate)}</pubDate>
      <description>${escapeXml(synopsis.substring(0, 1000))}</description>
    </item>\n`;
            } catch(e) { /* skip failed items */ }
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
