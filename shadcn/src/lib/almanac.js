// ─── Almanac: sun + moon ────────────────────────────────────────────
// Code-identical ports from docs/js/app.js (locked by
// tests/shadcn-parity.test.js).

// Sunrise/sunset via the SunCalc algorithm (Vladimir Agafonkin, BSD-2).
export function sunTimes(lat, lng, date) {
    const rad = Math.PI / 180, dayMs = 86400000, J1970 = 2440588, J2000 = 2451545;
    const toDays = d => d.valueOf() / dayMs - 0.5 + J1970 - J2000;
    const solarMeanAnomaly = d => rad * (357.5291 + 0.98560028 * d);
    const eclipticLongitude = M => M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
    const declination = L => Math.asin(Math.sin(L) * Math.sin(rad * 23.4397));
    const fromJulian = j => new Date((j + 0.5 - J1970) * dayMs);
    const d = toDays(date), lw = rad * -lng, phi = rad * lat;
    const n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
    const ds = 0.0009 + (lw) / (2 * Math.PI) + n;
    const M = solarMeanAnomaly(ds), L = eclipticLongitude(M);
    const dec = declination(L);
    const Jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    const h0 = rad * -0.833;
    const cosH = (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
    if (cosH > 1 || cosH < -1) return null; // polar day / night
    const w = Math.acos(cosH);
    const dsSet = 0.0009 + (w + lw) / (2 * Math.PI) + n;
    const Jset = J2000 + dsSet + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    return { sunrise: fromJulian(Jnoon - (Jset - Jnoon)), sunset: fromJulian(Jset) };
}

// Moon phase from a fixed reference new moon (pure date math).
export function moonPhase(date) {
    const synodic = 29.530588853;
    const ref = Date.UTC(2000, 0, 6, 18, 14);
    const p = ((((date.valueOf() - ref) / 86400000) % synodic) + synodic) % synodic / synodic;
    const idx = Math.round(p * 8) % 8;
    const names = ['New', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
    return { name: names[idx], phase: p };
}
