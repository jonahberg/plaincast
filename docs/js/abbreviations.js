// ─── Shared abbreviation patterns ─────────────────────────────────
// Single source of truth for NWS abbreviation expansion.
// Used by: docs/js/app.js (client-side translator) and api/feed.js (RSS feed).
//
// BASIC_ABBREVIATIONS: simple [regex, string] pairs safe for any context.
// FULL_ABBREVIATIONS: everything including function replacements (browser-only).

export const BASIC_ABBREVIATIONS = [
    // General weather abbreviations
    [/\bchc\b/gi, 'chance'],
    [/\bcsts\b/gi, 'coasts'],
    [/\bvlys\b/gi, 'valleys'],
    [/\bmtns\b/gi, 'mountains'],
    [/\bwnds\b/gi, 'winds'],
    [/\btemps\b/gi, 'temperatures'],
    [/\bpcpn\b/gi, 'precipitation'],
    [/\bprecip\b/gi, 'precipitation'],
    [/\baftn\b/gi, 'afternoon'],
    [/\bmrng\b/gi, 'morning'],
    [/\berly\b/gi, 'early'],
    [/\bthru\b/gi, 'through'],
    [/\bbtwn\b/gi, 'between'],
    [/\bisol\b/gi, 'isolated'],
    [/\bnum\b/gi, 'numerous'],
    [/\bocnl\b/gi, 'occasional'],
    [/\bintmt\b/gi, 'intermittent'],
    [/\bcont\b/gi, 'continue'],
    [/\bincr\b/gi, 'increase'],
    [/\bdecr\b/gi, 'decrease'],
    [/\bdevel\b/gi, 'develop'],
    [/\bdvlpg\b/gi, 'developing'],
    [/\bwrn\b/gi, 'western'],
    [/\bsrn\b/gi, 'southern'],
    [/\bnrn\b/gi, 'northern'],
    [/\bcntrl\b/gi, 'central'],
    [/\bfcst\b/gi, 'forecast'],
    [/\bblo\b/gi, 'below'],
    [/\babv\b/gi, 'above'],
    [/\bxtrm\b/gi, 'extreme'],
    [/\bposs\b/gi, 'possible'],
    [/\bprob\b/gi, 'probable'],

    // Storm & dynamics
    [/\bTSTMS?\b/gi, 'thunderstorms'],
    [/\bSFC\b/g, 'surface'],
    [/\bsfc\b/g, 'surface'],
    [/\btrof\b/gi, 'trough'],
    [/\bPWATs?\b/g, 'precipitable water'],
    [/\bQPF\b/g, 'expected rainfall'],
    [/\bPoPs?\b/gi, 'chance of rain'],
    [/\bCAPE\b/g, 'storm energy'],
    [/\bCIN\b/g, 'convective cap'],
    [/\bRH\b/g, 'humidity'],
    [/\bSLP\b/g, 'sea level pressure'],

    // Models → friendly names
    [/\bNBM\b/g, 'the blend-of-models forecast'],
    [/\bHRRR\b/g, 'the high-res rapid-refresh model'],
    [/\bGFS\b/g, 'the American global model'],
    [/\bECMWF\b/g, 'the European model'],
    [/\bNAM\b/g, 'the regional model'],
    [/\bhi\s+res\b/gi, 'high-resolution'],
    [/\bclimo\b/gi, 'the historical average'],
    [/\bdiurnal\b/gi, 'daily'],
    [/\bnocturnal\b/gi, 'nighttime'],

    // Aviation
    [/\bMVFR(?:\s+conditions)?\b/g, 'marginal visual flying conditions'],
    [/\bLIFR(?:\s+conditions)?\b/g, 'very low visibility flying conditions'],
    [/\bIFR(?:\s+conditions)?\b/g, 'instrument-only flying conditions'],
    [/\bVFR(?:\s+conditions)?\b/g, 'good visual flying conditions'],
    [/\bTAFs?\b/g, 'airport forecasts'],
    [/\bGDP\b/g, 'ground delay program'],
    [/\bCIGS?\b/gi, 'ceilings'],
    [/\bVSBY\b/gi, 'visibility'],
    [/\bCLR\b/g, 'clear skies'],
    [/\bAGL\b/g, 'above ground'],
    [/\bMSL\b/g, 'above sea level'],
    [/\bFL\s*(\d{2,3})\b/g, 'flight level $1'],

    // Sky conditions (simple)
    [/\bBKN\b/g, 'broken clouds'],
    [/\bOVC\b/g, 'overcast'],
    [/\bSCT\b/g, 'scattered clouds'],
    [/\bFEW\b/g, 'few clouds'],

    // Marine
    [/\bSCA\b/g, 'small craft advisory'],
    [/\bGALE\b/g, 'gale warning'],
    [/\bKTS\b/gi, 'knots'],
    [/\bkt\b/gi, 'knot'],
    [/\b(\d+)\s*NM\b/g, '$1 nautical miles'], // numeric-gated: "20 NM", not "western NM" (New Mexico)

    // Airport codes to names
    [/\bKLAX\b/g, 'LAX'],
    [/\bKBUR\b/g, 'Burbank'],
    [/\bKSNA\b/g, 'Orange County'],
    [/\bKVNY\b/g, 'Van Nuys'],
    [/\bKSMO\b/g, 'Santa Monica'],
    [/\bKONT\b/g, 'Ontario'],
    [/\bKSBA\b/g, 'Santa Barbara'],
    [/\bKOXR\b/g, 'Oxnard'],
    [/\bKLGB\b/g, 'Long Beach'],
    [/\bKSAN\b/g, 'San Diego'],
    [/\bKPMD\b/g, 'Palmdale'],
    [/\bKWJF\b/g, 'Lancaster'],

    // Phenomena
    [/\bIVT\b/g, 'moisture transport'],
    [/\bPDS\b/g, 'particularly dangerous'],
    [/\bSWE\b/g, 'snow water content'],

    // Misc
    [/\bOFB\b/g, 'outflow boundary'],
    [/\bFROPA\b/g, 'frontal passage'],
    [/\bUTC\b/g, 'UTC'],
    [/\bWFO\b/g, 'Weather Forecast Office'],
    [/\bCWA\b/g, 'forecast area'],
    [/\bRAOB\b/g, 'weather balloon data'],
    [/\bMOS\b/g, 'model output statistics'],
    [/\bNW\s+flow\b/gi, 'northwest flow'],
    [/\bSW\s+flow\b/gi, 'southwest flow'],
    [/\bSE\s+flow\b/gi, 'southeast flow'],
    [/\bNE\s+flow\b/gi, 'northeast flow'],
];

// Extended abbreviations that use function replacements (browser-only).
// These are appended to BASIC_ABBREVIATIONS in the client translator.
export const EXTENDED_ABBREVIATIONS = [
    // County/region abbreviations (California-specific)
    [/\bSLO\b/g, 'San Luis Obispo'],
    [/\bSBA\b/g, 'Santa Barbara'],
    [/\bVTA\b/g, 'Ventura'],
    [/\bLA\s+(?:county|basin|metro|mountains?|foothills|valleys?)\b/gi, (m) => 'Los Angeles' + m.slice(2)], // dropped "coast"/"area" — ambiguous with Louisiana (LIX/SHV/LCH)

    // Sky conditions with heights: BKN015 → broken clouds at 1,500 ft
    [/\bBKN(\d{3})\b/g, (_, h) => `broken clouds at ${parseInt(h)*100} ft`],
    [/\bOVC(\d{3})\b/g, (_, h) => `overcast at ${parseInt(h)*100} ft`],
    [/\bSCT(\d{3})\b/g, (_, h) => `scattered clouds at ${parseInt(h)*100} ft`],
    [/\bFEW(\d{3})\b/g, (_, h) => `few clouds at ${parseInt(h)*100} ft`],

    // Phenomena with context-dependent matching
    [/\b(?:an?\s+)?AR\b(?=\s+(?:event|will|is|was|pattern|plume|moving|hitting|arriving|developing|tapping))/g, 'atmospheric river'],
    [/\bLI\s+(?:values?|of|around|near|is|will)\b/gi, (m) => 'lifted index' + m.slice(2)],
];

// Combined list for client-side full translation
export const FULL_ABBREVIATIONS = [...BASIC_ABBREVIATIONS, ...EXTENDED_ABBREVIATIONS];
