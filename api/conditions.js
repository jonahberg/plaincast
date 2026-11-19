// Vercel serverless function: current weather conditions + seasonal context
import { OFFICE_NAMES, OFFICE_STATIONS, OFFICE_TIMEZONES } from '../docs/js/offices.js';
import { CLIMATE_NORMALS } from './_climate-normals.js';
import { sendError } from './_errors.js';

const NWS = 'https://api.weather.gov';
// NOAA Aviation Weather Center data API: every METAR, decoded.
export const AWC_METAR = 'https://aviationweather.gov/api/data/metar';
const HEADERS = { 'User-Agent': 'Plaincast/1.0 (plaincast.live)' };
const NULL_PAYLOAD = Object.freeze({ temp: null, normal: null, delta: null });
// No reading (none came, a failed read, an impossible value): "Now" and the
// delta go, the climate normal stays. It never depended on the station, so a
// brief outage must not drop "Normal high" too (Nov 18 2026).
const noReading = (normal) => (normal === null ? NULL_PAYLOAD : { temp: null, normal, delta: null });

// How far back a fallback reading may come from and still be called "Now".
export const FALLBACK_MAX_AGE_MS = 2 * 3600 * 1000;
const FALLBACK_LIMIT = 6; // hourly METARs plus the odd SPECI ≈ the last 2-3 h

// A temperature (°C) from a raw METAR, or null. The remark T-group carries
// tenths ("T02780178" → 27.8); the body group is whole degrees ("28/18",
// "M03/M07" → -3). Only the body before RMK is searched, and the group must
// stand alone, so visibility ("1/2SM") and runway ("R04/2000FT") groups
// cannot match.
export function metarTempC(raw) {
    const text = String(raw || '');
    const t = text.match(/\sT([01])(\d{3})(?:[01]\d{3})?(?=\s|$)/);
    if (t) return (t[1] === '1' ? -1 : 1) * Number(t[2]) / 10;
    const body = text.split(/\sRMK\s/)[0];
    const g = body.match(/\s(M?)(\d{2})\/(?:M?\d{2})?(?=\s|$)/);
    return g ? (g[1] ? -1 : 1) * Number(g[2]) : null;
}

// The temperature (°C) one observation supports, or null.
//
// api.weather.gov nulls any value MADIS has not quality-checked yet
// (qualityControl "Z") even though the station reported it. On Nov 18 2026
// 10 of PHNL's 12 latest observations had temperature.value null with QC "Z"
// while each rawMessage carried the reading ("... 28/18 A3008 RMK ...
// T02780178"), and KJFK's 21:51Z observation did the same — which is why
// /api/conditions answered temp: null for Honolulu and New York. A value QC
// actually REJECTED (X, B) or questioned (Q) is not resurrected from the raw
// message.
export function observationTempC(props) {
    const value = props?.temperature?.value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const qc = props?.temperature?.qualityControl;
    if (qc && qc !== 'Z') return null;
    return metarTempC(props?.rawMessage);
}

// Calendar month (0-11) in the office's own zone: the normals are monthly,
// and Guam is a day ahead of the server at the month's edges.
export function monthIn(timeZone, now = new Date()) {
    try {
        const m = new Intl.DateTimeFormat('en-US', { timeZone, month: 'numeric' }).format(now);
        return Number(m) - 1;
    } catch {
        return now.getUTCMonth();
    }
}

async function getJson(url) {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
    return res.ok ? res.json() : null;
}

// Latest observation first; when it yields no temperature, the newest of the
// recent observations that does, if it is under FALLBACK_MAX_AGE_MS old; and
// last, the same station's latest METAR from NOAA's Aviation Weather Center.
// api.weather.gov carries no observations at all for some stations that do
// report: NSTU (Pago Pago, the PPG office's station) answered 404 on
// /observations/latest and an empty /observations list on 2026-11-18, while
// AWC had its hourly METARs.
async function readStation(station, now) {
    const latest = await getJson(`${NWS}/stations/${station}/observations/latest`);
    const props = latest?.properties;
    if (props) {
        const tempC = observationTempC(props);
        if (tempC !== null) return { tempC, props };
    }
    const recent = await getJson(`${NWS}/stations/${station}/observations?limit=${FALLBACK_LIMIT}`);
    const candidates = (recent?.features || [])
        .map(f => f?.properties)
        .filter(p => p && now - Date.parse(p.timestamp) <= FALLBACK_MAX_AGE_MS)
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    for (const p of candidates) {
        const tempC = observationTempC(p);
        if (tempC !== null) return { tempC, props: p };
    }
    const awc = await getJson(`${AWC_METAR}?ids=${station}&format=json`);
    const metar = Array.isArray(awc) ? awc.find(m => m?.icaoId === station) : null;
    if (metar && now - Number(metar.obsTime) * 1000 <= FALLBACK_MAX_AGE_MS) {
        const tempC = typeof metar.temp === 'number' && Number.isFinite(metar.temp) ? metar.temp : metarTempC(metar.rawOb);
        if (tempC !== null) return { tempC, props: { textDescription: null } };
    }
    return null;
}

export default async function handler(req, res) {
    const office = String(req.query.office ?? '').toUpperCase(); // String(): a repeated ?office= arrives as an array
    if (!OFFICE_NAMES[office]) {
        return sendError(res, 400, 'invalid_office', 'Invalid office');
    }

    // The normal first: the office's table and the month in the office's own
    // zone (Guam is a day ahead of the server at a month's edge).
    const now = Date.now();
    const normals = CLIMATE_NORMALS[office];
    const normal = normals ? normals[monthIn(OFFICE_TIMEZONES[office], new Date(now))] ?? null : null;

    const station = OFFICE_STATIONS[office];
    if (!station) {
        return res.status(200).json(noReading(normal));
    }

    try {
        const reading = await readStation(station, now);
        if (!reading) {
            return res.status(200).json(noReading(normal));
        }
        // Sky phrase (e.g. "Mostly Cloudy", "Light Rain") drives the atmosphere's
        // condition tint on the client. Optional — null when the station omits it.
        const condition = reading.props.textDescription || null;
        const tempF = Math.round(reading.tempC * 9 / 5 + 32);

        // Sanity check
        if (tempF < -60 || tempF > 140) {
            return res.status(200).json(noReading(normal));
        }

        const delta = normal !== null ? tempF - normal : null;

        res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1200');
        return res.status(200).json({
            temp: tempF,
            normal,
            delta,
            condition,
            unit: 'F',
            station,
            office
        });
    } catch (err) {
        console.error('Conditions error:', err);
        return res.status(200).json(noReading(normal));
    }
}
