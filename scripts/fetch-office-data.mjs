// Fetches the NWS facts behind Plaincast's office roster from api.weather.gov
// and writes the audit snapshot scripts/data/nws-offices.json. Nothing in the
// snapshot is typed by hand: every value below comes from an NWS response,
// and the only inputs are the curation choices in scripts/office-curation.mjs
// (which station to read for the 68 launch offices, and the few new-office
// pins). scripts/build-office-data.mjs turns the snapshot into
// docs/js/offices.js offline.
//
//   bun scripts/fetch-office-data.mjs           (about 500 requests, ~3 min)
//
// Sources, in order:
//   1. /products/types/AFD/locations            every office code that issues an AFD
//   2. /products/types/AFD/locations/<CODE>     that office's AFDs (7 days): proves it
//                                               is live, and gives its issuing id(s)
//   3. /products/types/AFD                      the national 7-day list, to cross-check
//                                               the issuing-id → code mapping
//   4. /offices/<CODE>                          name, address, approved stations
//   5. /stations?id=...                         station name, time zone, geometry, county
//   6. /products/<latest id>                    the AFD text: its "National Weather
//                                               Service <City> <ST>" line names the
//                                               office the way its alerts do
//
// api.weather.gov answers aggressive clients with 403s, so requests are
// serialized and spaced (REQUEST_GAP_MS) with a descriptive User-Agent, and a
// throttled request backs off and retries.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY, STATION_PINS, NAME_OVERRIDES } from './office-curation.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT = join(__dirname, 'data', 'nws-offices.json');

const API = 'https://api.weather.gov';
const USER_AGENT = 'Plaincast/1.0 (plaincast.live; office roster script)';
const REQUEST_GAP_MS = 300;          // ≈3 requests per second
const RECENT_MS = 7 * 24 * 3600 * 1000;

let lastRequest = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getJson(path, { allow404 = false } = {}) {
    const url = path.startsWith('http') ? path : `${API}${path}`;
    for (let attempt = 1; ; attempt++) {
        const wait = lastRequest + REQUEST_GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
        lastRequest = Date.now();
        let res;
        try {
            res = await fetch(url, {
                headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
                signal: AbortSignal.timeout(30000),
            });
        } catch (e) {
            if (attempt >= 5) throw new Error(`${url}: ${e.message}`);
            await sleep(2000 * attempt);
            continue;
        }
        if (res.status === 404 && allow404) return null;
        if (res.ok) return res.json();
        if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt < 5) {
            console.warn(`  ${res.status} on ${url}; backing off`);
            await sleep(5000 * attempt);
            continue;
        }
        throw new Error(`${url}: HTTP ${res.status}`);
    }
}

const stationIdOf = (url) => String(url).split('/').pop();
// "https://api.weather.gov/zones/county/NYC081" → "NY". Only the COUNTY zone
// names a state reliably: a coastal station's forecast zone can be marine
// (TJSJ's is AMZ712), so a station without a county gets null here and its
// state comes from /points below.
const stateOfCounty = (url) => (url ? String(url).split('/').pop().slice(0, 2) : null);

// The station's own facts, in the shape the snapshot stores.
function stationFacts(feature) {
    const p = feature.properties;
    const [lon, lat] = feature.geometry.coordinates;
    return {
        id: p.stationIdentifier,
        name: p.name,
        timeZone: p.timeZone,
        lat: Math.round(lat * 10000) / 10000,
        lon: Math.round(lon * 10000) / 10000,
        state: stateOfCounty(p.county),
        provider: p.provider || '',
    };
}

async function stationsById(ids) {
    const out = new Map();
    // The collection endpoint takes a comma list; keep URLs well under 2 KB.
    for (let i = 0; i < ids.length; i += 60) {
        const chunk = ids.slice(i, i + 60);
        const data = await getJson(`/stations?id=${chunk.join(',')}&limit=500`);
        for (const f of data.features || []) out.set(f.properties.stationIdentifier, stationFacts(f));
    }
    return out;
}

// "Aberdeen, SD" → "Aberdeen"; "NWS Wilmington, NC" → "Wilmington";
// "WSO Pago Pago" → "Pago Pago"; "Central Illinois" → "Central Illinois".
export function cityOfNwsName(name) {
    return String(name || '')
        .replace(/^(NWS|WSO)\s+/i, '')
        .replace(/,\s*[^,]*$/, '')
        .replace(/\s+(Arizona|Alabama|Kansas|Mississippi)$/i, '')
        .trim();
}

// The automatic "Now" station for a new office: an approved station in the
// office's own state whose NWS name contains the office city as a whole word
// (a name that STARTS with it wins), preferring an ASOS airport. Null when
// nothing qualifies (the office then needs a pin in office-curation.mjs).
export function autoStation(city, state, candidates) {
    const first = city.split(/[/-]/)[0].trim();
    if (!first) return null;
    const word = new RegExp(`(^|[^A-Za-z])${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z]|$)`, 'i');
    const hits = candidates.filter(s => (s.state === state || s.state === null) && word.test(s.name));
    if (!hits.length) return null;
    const score = (s) => (s.name.toLowerCase().startsWith(first.toLowerCase()) ? 8 : 0)
        + (/^ASOS/.test(s.provider) ? 4 : 0)
        + (/international/i.test(s.name) ? 2 : 0)
        + (/airport|\bap\b|field|jetport/i.test(s.name) ? 1 : 0);
    const ranked = [...hits].sort((a, b) => (score(b) - score(a)) || a.id.localeCompare(b.id));
    return { ...ranked[0], alsoMatched: ranked.slice(1).map(s => s.id) };
}

export async function fetchAll(now = Date.now()) {
    console.log('AFD locations…');
    const locations = (await getJson('/products/types/AFD/locations')).locations;
    const codes = Object.keys(locations).sort();
    console.log(`  ${codes.length} codes`);

    console.log('National AFD list (7 days)…');
    const national = (await getJson('/products/types/AFD'))['@graph'] || [];
    const nationalIssuers = [...new Set(national.map(p => p.issuingOffice))].sort();

    const offices = {};
    const excluded = [];
    for (const code of codes) {
        process.stdout.write(`${code} `);
        const graph = (await getJson(`/products/types/AFD/locations/${code}`))['@graph'] || [];
        const recent = graph.filter(p => now - Date.parse(p.issuanceTime) <= RECENT_MS);
        if (!recent.length) {
            excluded.push({ code, location: locations[code], reason: graph.length
                ? `no AFD in the last 7 days (latest ${graph[0].issuanceTime})`
                : 'no AFD on file' });
            continue;
        }
        const office = await getJson(`/offices/${code}`, { allow404: true });
        const latest = await getJson(recent[0]['@id'] || `/products/${recent[0].id}`);
        const header = String(latest.productText || '').match(/^National Weather Service (.+?)\s*$/m);
        offices[code] = {
            location: locations[code],
            office: office ? {
                name: office.name,
                locality: office.address?.addressLocality || null,
                state: office.address?.addressRegion || null,
                nwsRegion: office.nwsRegion || null,
                approvedStations: (office.approvedObservationStations || []).map(stationIdOf).sort(),
            } : null,
            afd: {
                count7d: recent.length,
                latest: recent[0].issuanceTime,
                issuingOffices: [...new Set(graph.map(p => p.issuingOffice))].sort(),
                headerName: header ? header[1] : null,
            },
        };
    }
    process.stdout.write('\n');

    // Issuing id → code, from each office's own product list, checked both
    // ways against the national list. Any mismatch is fatal: the poller and
    // the National Desk would mislabel offices.
    const issuingToCode = {};
    for (const [code, o] of Object.entries(offices)) {
        for (const id of o.afd.issuingOffices) {
            if (issuingToCode[id] && issuingToCode[id] !== code) {
                throw new Error(`issuing id ${id} appears under both ${issuingToCode[id]} and ${code}`);
            }
            issuingToCode[id] = code;
        }
        if (o.afd.issuingOffices.length !== 1) {
            throw new Error(`${code} issues under ${o.afd.issuingOffices.length} ids: ${o.afd.issuingOffices}`);
        }
    }
    const unmapped = nationalIssuers.filter(id => !issuingToCode[id]);
    const unseen = Object.keys(issuingToCode).filter(id => !nationalIssuers.includes(id));
    if (unmapped.length) throw new Error(`national list has issuing ids with no location: ${unmapped}`);
    if (unseen.length) throw new Error(`location lists have issuing ids missing nationally: ${unseen}`);

    // Stations. Every approved station's metadata is fetched (batched) so the
    // automatic pick and the validation below read NWS data, not guesses.
    console.log('Station metadata…');
    const allIds = new Set();
    for (const [code, o] of Object.entries(offices)) {
        for (const id of o.office?.approvedStations || []) allIds.add(id);
        if (!o.office) allIds.add(o.afd.issuingOffices[0]);
        if (LEGACY[code]) allIds.add(LEGACY[code][3]);
        if (STATION_PINS[code]) allIds.add(STATION_PINS[code]);
    }
    const meta = await stationsById([...allIds].sort());

    const problems = [];
    for (const [code, o] of Object.entries(offices)) {
        const approved = o.office?.approvedStations || [];
        const candidates = approved.map(id => meta.get(id)).filter(Boolean);
        const officeState = LEGACY[code]?.[1] || o.office?.state || null;
        let station = null;
        let choice;
        if (LEGACY[code]) {
            station = meta.get(LEGACY[code][3]);
            choice = 'legacy';
        } else if (STATION_PINS[code]) {
            station = meta.get(STATION_PINS[code]);
            choice = 'pin';
        } else if (!o.office) {
            // No /offices record (PPG): the issuing id IS an ICAO station id
            // (NSTU, Pago Pago), and the product data ties it to the office.
            station = meta.get(o.afd.issuingOffices[0]);
            choice = 'issuing-id';
        } else {
            const city = NAME_OVERRIDES[code]?.replace(/\s+[A-Z]{2}$/, '') || cityOfNwsName(o.office.name);
            station = autoStation(city, o.office.state, candidates)
                || autoStation(o.office.locality || '', o.office.state, candidates);
            choice = 'auto';
        }
        if (!station) {
            problems.push(`${code}: no station (${choice}); candidates: ${candidates.map(s => `${s.id} ${s.name}`).join(' | ')}`);
            continue;
        }
        // Where the station actually is, per NWS: the forecast office whose
        // area contains it (cwa) and the state of its nearest place.
        const point = await getJson(`/points/${station.lat},${station.lon}`, { allow404: true });
        const pointState = point?.properties?.relativeLocation?.properties?.state || null;
        const pointCwa = point?.properties?.cwa || null;
        const inApproved = approved.includes(station.id);
        o.station = {
            ...station, state: station.state || pointState, choice,
            inApprovedList: o.office ? inApproved : null, pointCwa, pointState,
        };
        if (o.office && !inApproved) problems.push(`${code}: ${station.id} is not in /offices/${code} approvedObservationStations`);
        if (pointCwa !== code) problems.push(`${code}: ${station.id} lies in ${pointCwa}'s forecast area, not ${code}'s`);
        if (!officeState) {
            o.station.stateNote = `no /offices record; office state taken from its station (${o.station.state})`;
        } else if (o.station.state !== officeState) {
            o.station.stateNote = `station is in ${o.station.state}, office state ${officeState}`;
        }
    }
    if (problems.length) {
        console.error(problems.join('\n'));
        throw new Error(`${problems.length} station problem(s); pin a station in scripts/office-curation.mjs`);
    }

    return {
        source: 'https://api.weather.gov',
        fetchedAt: new Date(now).toISOString(),
        locationCount: codes.length,
        excluded,
        issuingOffices: Object.fromEntries(Object.entries(issuingToCode).sort()),
        offices,
    };
}

if (import.meta.main) {
    const snapshot = await fetchAll();
    mkdirSync(dirname(SNAPSHOT), { recursive: true });
    writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2) + '\n');
    const n = Object.keys(snapshot.offices).length;
    console.log(`Wrote ${SNAPSHOT}: ${n} offices, ${snapshot.excluded.length} excluded`);
    for (const [code, o] of Object.entries(snapshot.offices)) {
        const s = o.station;
        console.log(`${code}  ${s.id.padEnd(5)} ${s.choice.padEnd(10)} ${s.timeZone.padEnd(22)} ${s.state} ${s.name}${s.stateNote ? `  [${s.stateNote}]` : ''}`);
    }
    for (const e of snapshot.excluded) console.log(`EXCLUDED ${e.code} (${e.location}): ${e.reason}`);
}
