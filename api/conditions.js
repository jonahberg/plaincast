// Vercel serverless function: current weather conditions + seasonal context
import { OFFICE_NAMES } from '../docs/js/offices.js';
import { sendError } from './_errors.js';

// NWS observation station closest to each office (approximate)
const OFFICE_STATIONS = {
    'OKX': 'KJFK', 'BOX': 'KBOS', 'PHI': 'KPHL', 'LWX': 'KDCA', 'PBZ': 'KPIT', 'BUF': 'KBUF',
    'RAH': 'KRDU', 'CHS': 'KCHS', 'FFC': 'KATL', 'MFL': 'KMIA', 'JAX': 'KJAX', 'TBW': 'KTPA',
    'BMX': 'KBHM', 'OHX': 'KBNA', 'MRX': 'KTYS', 'JAN': 'KJAN', 'LOT': 'KORD', 'DTX': 'KDTW',
    'IND': 'KIND', 'CLE': 'KCLE', 'ILN': 'KCVG', 'MKX': 'KMKE', 'GRR': 'KGRR', 'LSX': 'KSTL',
    'EAX': 'KMCI', 'DMX': 'KDSM', 'MPX': 'KMSP', 'DLH': 'KDLH', 'FSD': 'KFSD', 'BIS': 'KBIS',
    'OAX': 'KOMA', 'FGF': 'KFAR', 'FWD': 'KDFW', 'HGX': 'KIAH', 'EWX': 'KSAT', 'OUN': 'KOKC',
    'TSA': 'KTUL', 'LZK': 'KLIT', 'LIX': 'KMSY', 'SHV': 'KSHV', 'LCH': 'KLCH', 'BOU': 'KDEN',
    'PUB': 'KPUB', 'GJT': 'KGJT', 'SLC': 'KSLC', 'BOI': 'KBOI', 'BYZ': 'KBIL', 'MSO': 'KMSO',
    'RIW': 'KRIW', 'PSR': 'KPHX', 'VEF': 'KLAS', 'TWC': 'KTUS', 'FGZ': 'KFLG', 'ABQ': 'KABQ',
    'EPZ': 'KELP', 'LOX': 'KLAX', 'SGX': 'KSAN', 'MTR': 'KSFO', 'STO': 'KSMF', 'HNX': 'KFAT',
    'EKA': 'KACV', 'SEW': 'KSEA', 'PQR': 'KPDX', 'MFR': 'KMFR', 'OTX': 'KGEG',
    'AFC': 'PANC', 'AFG': 'PAFA', 'HFO': 'PHNL',
};

// Monthly average high temps (F) for each office -- approximate climate normals
// Source: NOAA 1991-2020 normals (rounded)
const CLIMATE_NORMALS = {
    'LOX': [68,68,68,71,72,77,83,85,83,78,72,67],
    'OKX': [39,42,50,61,72,80,85,84,76,65,54,43],
    'BOX': [36,39,46,57,67,77,82,81,73,62,51,40],
    'PHI': [40,44,53,64,74,83,87,85,78,66,55,44],
    'LWX': [43,47,56,67,76,85,89,87,80,69,57,46],
    'MFL': [76,78,80,83,87,90,91,91,90,86,82,78],
    'LOT': [32,36,47,59,70,80,84,82,75,63,49,36],
    'HGX': [63,66,73,79,86,92,94,95,90,83,73,65],
    'PSR': [67,71,77,85,95,104,106,104,100,89,76,66],
    'SEW': [47,50,54,58,65,70,76,76,70,60,51,45],
    'BOU': [45,47,55,61,70,82,88,86,78,65,52,44],
    'SLC': [37,43,54,62,72,84,93,91,80,65,49,37],
    'MTR': [57,60,63,66,69,73,74,75,76,72,63,57],
    'SGX': [66,66,66,68,69,72,76,78,77,74,69,65],
    'FFC': [52,57,65,73,80,87,90,89,83,73,63,54],
    'FWD': [57,61,69,77,84,93,97,97,89,79,67,58],
    'MPX': [24,29,41,57,69,79,83,81,72,58,41,27],
    'CLE': [34,37,47,59,69,79,83,81,74,62,50,38],
    'HFO': [80,80,81,82,84,86,87,88,88,86,84,81],
    'AFC': [22,27,34,44,55,62,65,63,55,40,28,23],
};

export default async function handler(req, res) {
    const office = (req.query.office || '').toUpperCase();
    if (!OFFICE_NAMES[office]) {
        return sendError(res, 400, 'invalid_office', 'Invalid office');
    }

    const station = OFFICE_STATIONS[office];
    if (!station) {
        return res.status(200).json({ temp: null, normal: null, delta: null });
    }

    try {
        const obsRes = await fetch(`https://api.weather.gov/stations/${station}/observations/latest`, {
            headers: { 'User-Agent': 'Plaincast/1.0 (plaincast.live)' },
            signal: AbortSignal.timeout(10000)
        });
        if (!obsRes.ok) {
            return res.status(200).json({ temp: null, normal: null, delta: null });
        }
        const obsData = await obsRes.json();
        const tempC = obsData.properties?.temperature?.value;
        // Sky phrase (e.g. "Mostly Cloudy", "Light Rain") drives the atmosphere's
        // condition tint on the client. Optional — null when the station omits it.
        const condition = obsData.properties?.textDescription || null;

        if (tempC === null || tempC === undefined) {
            return res.status(200).json({ temp: null, normal: null, delta: null });
        }

        const tempF = Math.round(tempC * 9/5 + 32);

        // Sanity check
        if (tempF < -60 || tempF > 140) {
            return res.status(200).json({ temp: null, normal: null, delta: null });
        }

        const month = new Date().getMonth(); // 0-indexed
        const normals = CLIMATE_NORMALS[office];
        const normal = normals ? normals[month] : null;
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
        return res.status(200).json({ temp: null, normal: null, delta: null });
    }
}
