// Generates per-office SEO landing pages (docs/o/<CODE>/index.html),
// sitemap.xml, and api/_home-shell.html from docs/index.html. All committed to
// the repo (no Vercel build step) and kept in sync by tests/seo-pages.test.js.
// Regenerate after editing docs/index.html:
//   bun scripts/build-offices.mjs
//
// WHY api/_home-shell.html EXISTS: `/` must reach api/home.js, and vercel.json
// rewrites are evaluated AFTER `handle: filesystem` — so docs/index.html has to
// stay out of the deployed static root (.vercelignore) or it shadows the
// rewrite. But `.vercelignore` also removes a file from `includeFiles`
// (verified on a preview deploy 2026-08-21: both handlers lost their template
// and 307-looped), so the functions cannot reach the ignored file either. The
// fix is the convention api/_national-shell.html already uses: keep the shell
// under api/, underscore-prefixed so Vercel does not treat it as an endpoint,
// and ship it through includeFiles. docs/index.html remains the file humans
// edit and the local-dev homepage; this is its committed twin.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OFFICE_NAMES } from '../docs/js/offices.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS = join(__dirname, '..', 'docs');
const API = join(__dirname, '..', 'api');

// The bundled homepage shell — byte-identical to docs/index.html.
export const HOME_SHELL = join(API, '_home-shell.html');

// Exact strings from docs/index.html that vary per office.
const TITLE_TEMPLATE = 'Plaincast - What the forecast actually says';
const DESC_TEMPLATE = 'NWS meteorologists write the real forecasts 3-4x daily, but in dense shorthand. Plaincast uses AI to translate them into plain English anyone can read.';
// Homepage og:image:alt / twitter:image:alt text; rewritten per office below.
const ALT_TEMPLATE = 'The NWS forecast, decoded into plain English';

export function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function officeTitle(city) {
    return `${city} NWS Forecast in Plain English · Plaincast`;
}
export function officeDescription(city, code) {
    return `The latest National Weather Service Area Forecast Discussion for ${city} (${code}), translated into plain English — the real forecast, decoded. Updated 3–4 times daily.`;
}
export function officeImageAlt(city) {
    return `Latest NWS forecast for ${city}, decoded into plain English`;
}

// Office-specific structured data: WebPage (with BreadcrumbList home→office)
// about a Place. The generic WebApplication/FAQ/HowTo JSON-LD stays shared;
// this block is what makes each /o/<CODE>/ page's structured data unique.
export function officeJsonLd(code, city) {
    const url = `https://plaincast.live/o/${code}/`;
    const data = {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        '@id': url,
        'url': url,
        'name': officeTitle(city),
        'description': officeDescription(city, code),
        'inLanguage': 'en-US',
        'isPartOf': {
            '@type': 'WebSite',
            'name': 'Plaincast',
            'url': 'https://plaincast.live'
        },
        'about': {
            '@type': 'Place',
            'name': city,
            'description': `Forecast area of the National Weather Service ${city} office (${code})`
        },
        'breadcrumb': {
            '@type': 'BreadcrumbList',
            'itemListElement': [
                { '@type': 'ListItem', 'position': 1, 'name': 'Plaincast', 'item': 'https://plaincast.live/' },
                { '@type': 'ListItem', 'position': 2, 'name': `${city} (${code})`, 'item': url }
            ]
        },
        'significantLink': `https://plaincast.live/o/${code}/?view=changelog`
    };
    // `<` escaped so the JSON can never terminate the <script> element early.
    const json = JSON.stringify(data, null, 4).replace(/</g, '\\u003c');
    return `<script type="application/ld+json">\n    ${json.split('\n').join('\n    ')}\n    </script>`;
}

export function renderOfficePage(template, code, city) {
    const title = escHtml(officeTitle(city));
    const desc = escHtml(officeDescription(city, code));
    let html = template;
    // title appears in <title>, og:title, twitter:title; desc in 3 meta tags.
    html = html.split(TITLE_TEMPLATE).join(title);
    html = html.split(DESC_TEMPLATE).join(desc);
    // self-referential canonical + og:url
    html = html.replace('<link rel="canonical" href="https://plaincast.live">',
        `<link rel="canonical" href="https://plaincast.live/o/${code}/">`);
    // rel="alternate" must follow the canonical: it names the URL that serves
    // this page's Markdown twin, which is this office's page, not the homepage.
    html = html.replace('<link rel="alternate" type="text/markdown" href="https://plaincast.live/">',
        `<link rel="alternate" type="text/markdown" href="https://plaincast.live/o/${code}/">`);
    html = html.replace('<meta property="og:url" content="https://plaincast.live">',
        `<meta property="og:url" content="https://plaincast.live/o/${code}/">`);
    // per-office OG share card: links unfurl with the office's own forecast
    // PNG (/api/og), not the generic homepage image. og:image:width/height
    // (1200×630) carry over from the template; og:image:type is added here
    // because the homepage keeps the static PNG without a type tag.
    html = html.replace('<meta property="og:image" content="https://plaincast.live/og-image.png">',
        `<meta property="og:image" content="https://plaincast.live/api/og?office=${code}">\n    <meta property="og:image:type" content="image/png">`);
    html = html.replace('<meta name="twitter:image" content="https://plaincast.live/og-image.png">',
        `<meta name="twitter:image" content="https://plaincast.live/api/og?office=${code}">`);
    // per-office image alt text (shared by og:image:alt + twitter:image:alt →
    // split/join rewrites both occurrences of the homepage template string)
    html = html.split(`content="${ALT_TEMPLATE}"`).join(`content="${escHtml(officeImageAlt(city))}"`);
    // per-office RSS auto-discovery
    // split/join, not replace: the head discovery link AND the colophon
    // subscribe link both carry office=LOX in the template (replace() only
    // rewrites the first occurrence).
    html = html.split('href="/api/feed?office=LOX"').join(`href="/api/feed?office=${code}"`);
    // relative assets must resolve from /o/<CODE>/ → make them absolute
    html = html.replace('href="manifest.json"', 'href="/manifest.json"');
    html = html.replace('href="styles.css"', 'href="/styles.css"');
    html = html.replace('src="js/app.js"', 'src="/js/app.js"');
    // office-specific structured data (WebPage + Place + BreadcrumbList)
    html = html.replace('</head>', `${officeJsonLd(code, city)}\n</head>`);
    // mark this office's own entry in the footer office index
    html = html.replace(`<a href="/o/${code}/">`, `<a href="/o/${code}/" aria-current="page">`);
    return html;
}

// lastmod defaults to the generation date (YYYY-MM-DD). Google ignores
// changefreq/priority but does read <lastmod>, so every URL carries one.
export function renderSitemap(codes, lastmod = new Date().toISOString().slice(0, 10)) {
    const urls = [`  <url><loc>https://plaincast.live/</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`];
    urls.push(`  <url><loc>https://plaincast.live/national/</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq><priority>0.9</priority></url>`);
    // Trust anchors: static prose, so they change on deploy rather than daily.
    for (const slug of ['about', 'contact', 'privacy']) {
        urls.push(`  <url><loc>https://plaincast.live/${slug}</loc><lastmod>${lastmod}</lastmod><changefreq>monthly</changefreq><priority>0.4</priority></url>`);
    }
    for (const code of codes) {
        urls.push(`  <url><loc>https://plaincast.live/o/${code}/</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`);
    }
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
}

export function buildAll() {
    const template = readFileSync(join(DOCS, 'index.html'), 'utf8');
    const codes = Object.keys(OFFICE_NAMES);
    for (const code of codes) {
        const dir = join(DOCS, 'o', code);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'index.html'), renderOfficePage(template, code, OFFICE_NAMES[code]));
    }
    writeFileSync(join(DOCS, 'sitemap.xml'), renderSitemap(codes));
    // The functions' copy of the homepage shell (see the header note).
    writeFileSync(HOME_SHELL, template);
    return codes.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const n = buildAll();
    console.log(`Generated ${n} office pages + sitemap.xml`);
}
