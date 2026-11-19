// Human curation for the office roster — the ONLY hand-entered office facts.
// Everything else (time zones, coordinates, stations, issuing ids, normals)
// is fetched from NOAA/NWS by scripts/fetch-office-data.mjs and
// scripts/fetch-climate-normals.mjs and written to scripts/data/.
//
// What lives here, and why it cannot be fetched:
//   - LEGACY: the 68 offices Plaincast launched with. Their display names,
//     alert state and alert sender fragment are kept EXACTLY as they shipped
//     (changing a display name changes page titles, OG cards and feeds), and
//     their "Now" station stays the one /api/conditions has always read.
//   - NAME_OVERRIDES: new offices whose display name is not simply the city
//     the NWS names the office for (every other new name is derived from the
//     NWS office name by scripts/build-office-data.mjs, with the state added
//     when another NWS office shares the city).
//   - STATION_PINS: new offices whose primary station the automatic rule in
//     fetch-office-data.mjs cannot pick (the office is named for a region, or
//     its own town has no ASOS). Every pin must still be one of the office's
//     own approvedObservationStations; the fetch script fails otherwise.
//   - OFFICE_REGION_GROUPS: the picker/footer grouping (editorial).

export const LEGACY = {
    // code: [display name, alert state, alert sender fragment, "Now" station]
    OKX: ['New York', 'NY', 'New York', 'KJFK'],
    BOX: ['Boston', 'MA', 'Boston', 'KBOS'],
    PHI: ['Philadelphia', 'PA', 'Mount Holly', 'KPHL'],
    LWX: ['Washington DC', 'VA', 'Baltimore', 'KDCA'],
    PBZ: ['Pittsburgh', 'PA', 'Pittsburgh', 'KPIT'],
    BUF: ['Buffalo', 'NY', 'Buffalo', 'KBUF'],
    RAH: ['Raleigh', 'NC', 'Raleigh', 'KRDU'],
    CHS: ['Charleston SC', 'SC', 'Charleston', 'KCHS'],
    FFC: ['Atlanta', 'GA', 'Peachtree', 'KATL'],
    MFL: ['Miami', 'FL', 'Miami', 'KMIA'],
    JAX: ['Jacksonville', 'FL', 'Jacksonville', 'KJAX'],
    TBW: ['Tampa Bay', 'FL', 'Tampa Bay', 'KTPA'],
    BMX: ['Birmingham', 'AL', 'Birmingham', 'KBHM'],
    OHX: ['Nashville', 'TN', 'Nashville', 'KBNA'],
    MRX: ['Morristown', 'TN', 'Morristown', 'KTYS'],
    JAN: ['Jackson MS', 'MS', 'Jackson', 'KJAN'],
    LOT: ['Chicago', 'IL', 'Chicago', 'KORD'],
    DTX: ['Detroit', 'MI', 'Detroit', 'KDTW'],
    IND: ['Indianapolis', 'IN', 'Indianapolis', 'KIND'],
    CLE: ['Cleveland', 'OH', 'Cleveland', 'KCLE'],
    ILN: ['Cincinnati', 'OH', 'Wilmington', 'KCVG'],
    MKX: ['Milwaukee', 'WI', 'Milwaukee', 'KMKE'],
    GRR: ['Grand Rapids', 'MI', 'Grand Rapids', 'KGRR'],
    LSX: ['St. Louis', 'MO', 'St. Louis', 'KSTL'],
    EAX: ['Kansas City', 'MO', 'Kansas City', 'KMCI'],
    DMX: ['Des Moines', 'IA', 'Des Moines', 'KDSM'],
    MPX: ['Minneapolis', 'MN', 'Twin Cities', 'KMSP'],
    DLH: ['Duluth', 'MN', 'Duluth', 'KDLH'],
    FSD: ['Sioux Falls', 'SD', 'Sioux Falls', 'KFSD'],
    BIS: ['Bismarck', 'ND', 'Bismarck', 'KBIS'],
    OAX: ['Omaha', 'NE', 'Omaha', 'KOMA'],
    FGF: ['Grand Forks', 'ND', 'Grand Forks', 'KFAR'],
    FWD: ['Dallas/Fort Worth', 'TX', 'Fort Worth', 'KDFW'],
    HGX: ['Houston', 'TX', 'Houston', 'KIAH'],
    EWX: ['San Antonio', 'TX', 'San Antonio', 'KSAT'],
    OUN: ['Oklahoma City', 'OK', 'Norman', 'KOKC'],
    TSA: ['Tulsa', 'OK', 'Tulsa', 'KTUL'],
    LZK: ['Little Rock', 'AR', 'Little Rock', 'KLIT'],
    LIX: ['New Orleans', 'LA', 'New Orleans', 'KMSY'],
    SHV: ['Shreveport', 'LA', 'Shreveport', 'KSHV'],
    LCH: ['Lake Charles', 'LA', 'Lake Charles', 'KLCH'],
    BOU: ['Denver', 'CO', 'Denver', 'KDEN'],
    PUB: ['Pueblo', 'CO', 'Pueblo', 'KPUB'],
    GJT: ['Grand Junction', 'CO', 'Grand Junction', 'KGJT'],
    SLC: ['Salt Lake City', 'UT', 'Salt Lake City', 'KSLC'],
    BOI: ['Boise', 'ID', 'Boise', 'KBOI'],
    BYZ: ['Billings', 'MT', 'Billings', 'KBIL'],
    MSO: ['Missoula', 'MT', 'Missoula', 'KMSO'],
    RIW: ['Riverton', 'WY', 'Riverton', 'KRIW'],
    PSR: ['Phoenix', 'AZ', 'Phoenix', 'KPHX'],
    VEF: ['Las Vegas', 'NV', 'Las Vegas', 'KLAS'],
    TWC: ['Tucson', 'AZ', 'Tucson', 'KTUS'],
    FGZ: ['Flagstaff', 'AZ', 'Flagstaff', 'KFLG'],
    ABQ: ['Albuquerque', 'NM', 'Albuquerque', 'KABQ'],
    EPZ: ['El Paso', 'TX', 'El Paso', 'KELP'],
    LOX: ['Los Angeles', 'CA', 'Los Angeles', 'KLAX'],
    SGX: ['San Diego', 'CA', 'San Diego', 'KSAN'],
    MTR: ['San Francisco', 'CA', 'San Francisco', 'KSFO'],
    STO: ['Sacramento', 'CA', 'Sacramento', 'KSMF'],
    HNX: ['Central California', 'CA', 'Hanford', 'KFAT'],
    EKA: ['Eureka', 'CA', 'Eureka', 'KACV'],
    SEW: ['Seattle', 'WA', 'Seattle', 'KSEA'],
    PQR: ['Portland', 'OR', 'Portland', 'KPDX'],
    MFR: ['Medford', 'OR', 'Medford', 'KMFR'],
    OTX: ['Spokane', 'WA', 'Spokane', 'KGEG'],
    AFC: ['Anchorage', 'AK', 'Anchorage', 'PANC'],
    AFG: ['Fairbanks', 'AK', 'Fairbanks', 'PAFA'],
    HFO: ['Honolulu', 'HI', 'Honolulu', 'PHNL'],
};

// New-office display names that are not the plain NWS city. Each entry says
// what the NWS calls the office, so a reviewer can check the choice.
export const NAME_OVERRIDES = {
    BRO: 'Brownsville',      // NWS: "Brownsville/Rio Grande Valley, TX"
    GYX: 'Portland ME',      // NWS: "Gray - Portland, ME" (Portland OR is PQR)
    GUM: 'Guam',             // NWS: "Tiyan, GU" (the office sits at Tiyan, Guam)
};

// New offices whose "Now" station the automatic city-name rule cannot pick.
// Each is in that office's approvedObservationStations (the fetch script
// fails otherwise), and the reason says why the rule needed help.
export const STATION_PINS = {
    // Named for a region, not a city: the region's NCEI first-order station.
    ILX: 'KSPI',   // "Central Illinois" (office at Lincoln; Lincoln's KAAA has no NCEI normals)
    IWX: 'KFWA',   // "Northern Indiana" (office at Syracuse IN, which has no station)
    // The office's own town has no matching station name.
    MHX: 'KMRH',   // Newport/Morehead City: Beaufort's Smith Field serves Morehead City
    RNK: 'KBCB',   // Blacksburg: Virginia Tech Airport is Blacksburg's airport
    // The rule's tie-break picked a secondary airport of the right city; pin
    // the city's main airport (also its NCEI climate station).
    ICT: 'KICT',   // rule picked KAAO (Jabara)
    MOB: 'KMOB',   // rule picked KBFM (Mobile Downtown)
    TOP: 'KTOP',   // rule picked KFOE (Forbes Field)
};

// Picker + footer directory groups (editorial). The generator sorts each
// group by display name; every office must appear exactly once. The 68
// launch offices keep the groups they shipped in — which is why the
// Carolinas sit under "Northeast" with Raleigh and Charleston SC.
export const OFFICE_REGION_GROUPS = [
    { label: 'Northeast', codes: [
        'OKX', 'BOX', 'PHI', 'LWX', 'PBZ', 'BUF', 'RAH', 'CHS',
        'ALY', 'BGM', 'BTV', 'CAR', 'CTP', 'GYX', 'AKQ', 'RNK', 'RLX', 'MHX', 'ILM', 'GSP', 'CAE',
    ] },
    { label: 'Southeast', codes: [
        'FFC', 'MFL', 'JAX', 'TBW', 'BMX', 'OHX', 'MRX', 'JAN',
        'MLB', 'KEY', 'TAE', 'HUN', 'MOB', 'MEG',
    ] },
    { label: 'Midwest', codes: [
        'LOT', 'DTX', 'IND', 'CLE', 'ILN', 'MKX', 'GRR', 'LSX', 'EAX', 'DMX',
        'ILX', 'IWX', 'DVN', 'ARX', 'GRB', 'APX', 'MQT', 'LMK', 'PAH', 'JKL', 'SGF',
    ] },
    { label: 'Northern Plains', codes: [
        'MPX', 'DLH', 'FSD', 'BIS', 'OAX', 'FGF',
        'ABR', 'UNR', 'GID', 'LBF',
    ] },
    { label: 'South Central', codes: [
        'FWD', 'HGX', 'EWX', 'OUN', 'TSA', 'LZK', 'LIX', 'SHV', 'LCH',
        'AMA', 'LUB', 'MAF', 'SJT', 'CRP', 'BRO', 'TOP', 'ICT', 'DDC', 'GLD',
    ] },
    { label: 'Rockies & Mountain West', codes: [
        'BOU', 'PUB', 'GJT', 'SLC', 'BOI', 'BYZ', 'MSO', 'RIW',
        'CYS', 'GGW', 'TFX', 'PIH', 'LKN', 'REV',
    ] },
    { label: 'Southwest', codes: ['PSR', 'VEF', 'TWC', 'FGZ', 'ABQ', 'EPZ'] },
    { label: 'Pacific', codes: [
        'LOX', 'SGX', 'MTR', 'STO', 'HNX', 'EKA', 'SEW', 'PQR', 'MFR', 'OTX',
        'PDT',
    ] },
    { label: 'Alaska & Pacific Islands', codes: ['AFC', 'AFG', 'HFO', 'AJK', 'GUM', 'PPG'] },
    { label: 'Caribbean', codes: ['SJU'] },
];
