// Fetches the "Normal high" behind /api/conditions: the NOAA NCEI 1991–2020
// monthly normal of daily maximum temperature (MLY-TMAX-NORMAL) at each
// office's primary observation station — the SAME station /api/conditions
// reads for "Now", so the delta compares like with like. Writes the audit
// snapshot scripts/data/climate-normals.json; scripts/build-office-data.mjs
// turns it into api/_climate-normals.js.
//
//   bun scripts/fetch-office-data.mjs      (first: picks the stations)
//   bun scripts/fetch-climate-normals.mjs
//
// The NWS station id is an ICAO code (KLAX); NCEI keys normals by GHCN-Daily
// id (USW00023174). The bridge is the station's WBAN number, resolved from
// two NCEI inventories — never by assembling an id from a prefix, because the
// country part varies (Guam is GQW…, Puerto Rico RQW…, American Samoa AQW…):
//   1. ISD station history (isd-history.csv): ICAO → WBAN
//   2. GHCN-Daily station list (ghcnd-stations.txt): WBAN → GHCN-Daily id
//   3. NCEI Access Data Service, dataset normals-monthly-1991-2020: the normals
// Every match must sit within MAX_DISTANCE_KM of the NWS station's own
// coordinates, in both inventories and in the normals record itself; an
// office that fails any step is left out (the UI hides the cell) and listed
// under `missing` with the reason. Nothing is estimated.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OFFICES = join(__dirname, 'data', 'nws-offices.json');
export const NORMALS_SNAPSHOT = join(__dirname, 'data', 'climate-normals.json');

const ISD_HISTORY = 'https://www.ncei.noaa.gov/pub/data/noaa/isd-history.csv';
const GHCND_STATIONS = 'https://www.ncei.noaa.gov/pub/data/ghcn/daily/ghcnd-stations.txt';
const ADS = 'https://www.ncei.noaa.gov/access/services/data/v1';
const USER_AGENT = 'Plaincast/1.0 (plaincast.live; climate normals script)';
const MAX_DISTANCE_KM = 10;

async function getText(url) {
    for (let attempt = 1; ; attempt++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(120000) });
            if (res.ok) return res.text();
            if (attempt >= 4) throw new Error(`HTTP ${res.status}`);
        } catch (e) {
            if (attempt >= 4) throw new Error(`${url}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 3000 * attempt));
    }
}

export function distanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// isd-history.csv: "USAF","WBAN","STATION NAME","CTRY","STATE","ICAO","LAT","LON","ELEV(M)","BEGIN","END"
export function parseIsdHistory(csv) {
    const byIcao = new Map();
    for (const line of csv.split('\n').slice(1)) {
        const f = line.match(/"([^"]*)"/g)?.map(s => s.slice(1, -1));
        if (!f || f.length < 11) continue;
        const [usaf, wban, name, ctry, state, icao, lat, lon, , begin, end] = f;
        if (!icao || wban === '99999') continue;
        if (!byIcao.has(icao)) byIcao.set(icao, []);
        byIcao.get(icao).push({ usaf, wban, name, ctry, state, lat: Number(lat), lon: Number(lon), begin, end });
    }
    return byIcao;
}

// ghcnd-stations.txt is fixed-width: ID 1-11, LAT 13-20, LON 22-30, ... NAME 42-71.
// An id's 3rd character is its network; 'W' means the last 8 digits are the
// WBAN number zero-padded ("USW00023174" → WBAN 23174).
export function parseGhcndStations(txt) {
    const byWban = new Map();
    for (const line of txt.split('\n')) {
        const id = line.slice(0, 11).trim();
        if (id.length !== 11 || id[2] !== 'W') continue;
        const wban = id.slice(3); // 8 digits, zero-padded
        if (!byWban.has(wban)) byWban.set(wban, []);
        byWban.get(wban).push({
            id, lat: Number(line.slice(12, 20)), lon: Number(line.slice(21, 30)), name: line.slice(41, 71).trim(),
        });
    }
    return byWban;
}

// The ICAO's WBAN: among its ISD rows with a real WBAN near the NWS station,
// the most recently active one. Returns { wban } or { reason }.
export function wbanFor(icao, lat, lon, isd) {
    const rows = (isd.get(icao) || []).filter(r => distanceKm(lat, lon, r.lat, r.lon) <= MAX_DISTANCE_KM);
    if (!rows.length) return { reason: `no ISD history row with a WBAN for ${icao} within ${MAX_DISTANCE_KM} km` };
    const wbans = [...new Set(rows.map(r => r.wban))];
    const latest = [...rows].sort((a, b) => b.end.localeCompare(a.end))[0];
    return { wban: latest.wban, wbans };
}

async function fetchNormals(ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += 25) {
        const chunk = ids.slice(i, i + 25);
        const url = `${ADS}?dataset=normals-monthly-1991-2020&stations=${chunk.join(',')}`
            + '&dataTypes=MLY-TMAX-NORMAL&format=json&units=standard&includeStationName=true&includeStationLocation=1';
        const rows = JSON.parse(await getText(url) || '[]');
        for (const r of rows) {
            if (!out.has(r.STATION)) out.set(r.STATION, { name: r.NAME, lat: Number(r.LATITUDE), lon: Number(r.LONGITUDE), months: {} });
            out.get(r.STATION).months[r.DATE] = r['MLY-TMAX-NORMAL'];
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    return out;
}

export async function fetchAllNormals(snapshot = JSON.parse(readFileSync(OFFICES, 'utf8'))) {
    console.log('NCEI ISD station history…');
    const isd = parseIsdHistory(await getText(ISD_HISTORY));
    console.log('NCEI GHCN-Daily station list…');
    const ghcnd = parseGhcndStations(await getText(GHCND_STATIONS));

    const plan = {};
    const missing = {};
    for (const [code, o] of Object.entries(snapshot.offices)) {
        const s = o.station;
        const w = wbanFor(s.id, s.lat, s.lon, isd);
        if (!w.wban) { missing[code] = { station: s.id, reason: w.reason }; continue; }
        const hits = (ghcnd.get(w.wban.padStart(8, '0')) || [])
            .filter(g => distanceKm(s.lat, s.lon, g.lat, g.lon) <= MAX_DISTANCE_KM);
        if (hits.length !== 1) {
            missing[code] = { station: s.id, wban: w.wban, reason: hits.length ? `WBAN ${w.wban} matches ${hits.length} GHCN-Daily ids` : `WBAN ${w.wban} has no GHCN-Daily id near ${s.id}` };
            continue;
        }
        plan[code] = { station: s.id, wban: w.wban, ghcnd: hits[0].id };
    }

    console.log(`NCEI normals for ${Object.keys(plan).length} stations…`);
    const normals = await fetchNormals([...new Set(Object.values(plan).map(p => p.ghcnd))].sort());

    const out = {};
    for (const [code, p] of Object.entries(plan)) {
        const n = normals.get(p.ghcnd);
        const s = snapshot.offices[code].station;
        const raw = n ? Array.from({ length: 12 }, (_, i) => n.months[String(i + 1).padStart(2, '0')]) : [];
        if (!n || raw.some(v => v === undefined || v === '' || !Number.isFinite(Number(v)))) {
            missing[code] = { station: p.station, ghcnd: p.ghcnd, reason: n ? 'normals record lacks one or more months of MLY-TMAX-NORMAL' : 'no MLY-TMAX-NORMAL in normals-monthly-1991-2020' };
            continue;
        }
        const km = distanceKm(s.lat, s.lon, n.lat, n.lon);
        if (km > MAX_DISTANCE_KM) {
            missing[code] = { station: p.station, ghcnd: p.ghcnd, reason: `normals station is ${km.toFixed(1)} km from ${p.station}` };
            continue;
        }
        out[code] = {
            station: p.station, wban: p.wban, ghcnd: p.ghcnd, nceiName: n.name,
            distanceKm: Math.round(km * 10) / 10,
            tmaxF: raw.map(v => Math.round(Number(v))),
            tmaxRaw: raw.map(v => String(v).trim()),
        };
    }
    return {
        source: 'NOAA NCEI normals-monthly-1991-2020 (MLY-TMAX-NORMAL, °F) via the Access Data Service',
        stationLinks: [ISD_HISTORY, GHCND_STATIONS],
        fetchedAt: new Date().toISOString(),
        normals: Object.fromEntries(Object.entries(out).sort()),
        missing: Object.fromEntries(Object.entries(missing).sort()),
    };
}

if (import.meta.main) {
    const result = await fetchAllNormals();
    mkdirSync(dirname(NORMALS_SNAPSHOT), { recursive: true });
    writeFileSync(NORMALS_SNAPSHOT, JSON.stringify(result, null, 2) + '\n');
    const have = Object.keys(result.normals).length;
    const total = have + Object.keys(result.missing).length;
    console.log(`Wrote ${NORMALS_SNAPSHOT}: normals for ${have} of ${total} offices`);
    for (const [code, m] of Object.entries(result.missing)) console.log(`MISSING ${code} ${m.station}: ${m.reason}`);
}
