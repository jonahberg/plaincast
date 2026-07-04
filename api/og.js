// Vercel serverless function: dynamic OG image per office
import { OFFICE_NAMES } from '../docs/js/offices.js';
import { fetchAFDList, fetchAFDProduct, productUrlFromItem } from './_utils.js';
import { extractLede, sectionHealth } from './_afd-sections.js';

// Offices already warned about unparseable AFDs (format drift), once per instance.
const warnedOffices = new Set();

export default async function handler(req, res) {
    const office = (req.query.office || '').toUpperCase();
    const cityName = OFFICE_NAMES[office];

    if (!cityName) {
        // Generic fallback
        res.setHeader('Cache-Control', 'public, s-maxage=86400');
        return res.redirect(302, '/og-image.png');
    }

    // Fetch latest AFD for key takeaway
    let takeaway = 'What the forecast actually says.';
    try {
        const items = await fetchAFDList(office, { signal: AbortSignal.timeout(5000) });
        const prodUrl = productUrlFromItem(items[0]);
        if (prodUrl) {
            const prodData = await fetchAFDProduct(prodUrl, { signal: AbortSignal.timeout(5000) });
            const text = typeof prodData?.productText === 'string' ? prodData.productText : '';
            // Extract the lede (SYNOPSIS or Key Message format sections)
            const health = sectionHealth(text);
            if (health.sectionCount === 0 && !warnedOffices.has(office)) {
                warnedOffices.add(office);
                console.warn(`[og] AFD format drift: ${office} parsed 0 sections (format=${health.format})`);
            }
            const lede = extractLede(text);
            if (lede) {
                let syn = lede.replace(/\.{2,}/g, '. ').replace(/\s+/g, ' ').trim();
                // Take first 2 sentences
                const sentences = syn.match(/[^.!?]+[.!?]+/g);
                if (sentences) syn = sentences.slice(0, 2).join(' ').trim();
                if (syn.length > 200) syn = syn.substring(0, 197) + '...';
                // Basic cleanup
                syn = syn.replace(/\b(chc|pcpn|tstms?|sfc|trof|mtns|vlys|csts|wnds|temps|thru|btwn|fcst)\b/gi, m => {
                    const map = {chc:'chance',pcpn:'precipitation',tstm:'thunderstorm',tstms:'thunderstorms',sfc:'surface',trof:'trough',mtns:'mountains',vlys:'valleys',csts:'coasts',wnds:'winds',temps:'temperatures',thru:'through',btwn:'between',fcst:'forecast'};
                    return map[m.toLowerCase()] || m;
                });
                takeaway = syn;
            }
        }
    } catch (e) {
        // Use default takeaway on any error
    }

    // Escape for XML
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // Word-wrap takeaway text for SVG (max ~45 chars per line, max 4 lines)
    const words = takeaway.split(' ');
    const lines = [];
    let line = '';
    for (const word of words) {
        if ((line + ' ' + word).trim().length > 50 && line) {
            lines.push(line.trim());
            line = word;
        } else {
            line = (line + ' ' + word).trim();
        }
        if (lines.length >= 3) { line = line + '...'; break; }
    }
    if (line) lines.push(line.trim());

    const takeawayLines = lines.map((l, i) =>
        `<text x="60" y="${340 + i * 36}" fill="#57534e" font-size="24" font-family="Georgia, 'Times New Roman', serif">${esc(l)}</text>`
    ).join('\n    ');

    const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#FAFAF5"/>
  <rect x="0" y="0" width="6" height="630" fill="#0F766E"/>
  <text x="60" y="120" fill="#1c1917" font-size="28" font-family="'DM Sans', -apple-system, sans-serif" font-weight="600" letter-spacing="0.08em">PLAINCAST</text>
  <text x="60" y="200" fill="#1c1917" font-size="52" font-family="Georgia, 'Times New Roman', serif">${esc(cityName)} Forecast</text>
  <line x1="60" y1="240" x2="400" y2="240" stroke="#e7e5e4" stroke-width="1"/>
  <rect x="60" y="270" width="1080" height="${lines.length * 36 + 40}" rx="6" fill="#F0FDFA"/>
  <text x="80" y="300" fill="#0F766E" font-size="12" font-family="'DM Sans', -apple-system, sans-serif" font-weight="600" letter-spacing="0.08em">KEY TAKEAWAY</text>
    ${takeawayLines}
  <text x="60" y="580" fill="#78716c" font-size="18" font-family="'DM Sans', -apple-system, sans-serif">plaincast.live · What the forecast actually says</text>
</svg>`;

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');
    return res.status(200).send(svg);
}
