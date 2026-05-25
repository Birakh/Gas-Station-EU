'use strict';
// scripts/fetch-prices.js
//
// Runs ONLY inside GitHub Actions on ubuntu-latest, Node 20.
// Native fetch is available — no npm install required.
// Execute with:  node scripts/fetch-prices.js

const fs   = require('fs');
const path = require('path');

// __dirname is the `scripts/` directory; go one level up for the repo root.
const REPO_ROOT   = path.resolve(__dirname, '..');
const DATA_DIR    = path.join(REPO_ROOT, 'data');
const HISTORY_DIR = path.join(DATA_DIR, 'history');

// Today's UTC date string used for the history filename.
const TODAY_UTC = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

// ─── Fuel type human-readable labels (Austrian convention) ───────────────────
const FUEL_LABEL = {
  DIE:   'Diesel',
  SUP:   'Eurosuper 95',
  SUP98: 'Super Plus 98',
};

// ─── Coverage grid: 8 points spread across all Austrian federal states ────────
// The E-Control endpoint returns stations within a radius of the given point.
// One central point only covered the Salzburg area; these 8 points ensure
// every populated region of Austria is included.  Duplicate station IDs that
// fall inside more than one radius are removed during the merge step below.
const LOCATIONS = [
  { lat: 48.2082, lng: 16.3738, label: 'Vienna'      },
  { lat: 47.8095, lng: 13.0550, label: 'Salzburg'    },
  { lat: 47.0707, lng: 15.4395, label: 'Graz'        },
  { lat: 48.3069, lng: 14.2858, label: 'Linz'        },
  { lat: 47.2692, lng: 11.4041, label: 'Innsbruck'   },
  { lat: 46.6228, lng: 14.3050, label: 'Klagenfurt'  },
  { lat: 47.8233, lng: 16.5353, label: 'Eisenstadt'  },
  { lat: 47.4968, lng:  9.7332, label: 'Bregenz'     },
];

// Fuel types to request.  SUP98 is kept alongside DIE and SUP so that the
// stations.json schema from the original spec remains intact.
const FUEL_TYPES = ['DIE', 'SUP', 'SUP98'];

// ─── Low-level fetch helpers ─────────────────────────────────────────────────

/**
 * Fetch a URL and return parsed JSON.
 * Throws on non-2xx status or network error.
 */
async function fetchJSON(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (networkErr) {
    throw new Error(`Network error fetching ${url}: ${networkErr.message}`);
  }
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText} fetching ${url}`
    );
  }
  return response.json();
}

/**
 * Fetch a URL and return the response body as a string.
 * Throws on non-2xx status or network error.
 */
async function fetchText(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (networkErr) {
    throw new Error(`Network error fetching ${url}: ${networkErr.message}`);
  }
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText} fetching ${url}`
    );
  }
  return response.text();
}

// ─── Step 1: E-Control Austria ───────────────────────────────────────────────
//
// Documented at: https://api.e-control.at/sprit/1.0/doc/
//
// Strategy:
//   Build one fetch task per (location, fuelType) combination — 8 × 3 = 24
//   tasks — and fire them all in parallel with Promise.all().
//   Each task returns an array of station objects for that query.
//   After all tasks resolve, merge into a Map keyed by station ID so that
//   any station appearing in multiple radius results is stored exactly once.

async function fetchEControl() {
  console.log(
    `[Step 1] Fetching E-Control prices — ` +
    `${LOCATIONS.length} locations × ${FUEL_TYPES.length} fuel types ` +
    `= ${LOCATIONS.length * FUEL_TYPES.length} parallel requests…`
  );

  const BASE_URL = 'https://api.e-control.at/sprit/1.0/search/gas-stations/by-address';

  // Build the full task list: one entry per (location, fuelType) pair.
  // We keep the metadata on each task so error messages are readable.
  const tasks = [];
  for (const loc of LOCATIONS) {
    for (const fuelType of FUEL_TYPES) {
      const url =
        `${BASE_URL}` +
        `?latitude=${loc.lat}` +
        `&longitude=${loc.lng}` +
        `&fuelType=${fuelType}` +
        `&includeClosed=false`;

      tasks.push({ url, fuelType, label: loc.label });
    }
  }

  // Fire all requests in parallel.  If any single request fails the entire
  // Promise.all rejects, which the caller (main) will catch and exit(1).
  let rawResults;
  try {
    rawResults = await Promise.all(
      tasks.map(({ url, fuelType, label }) =>
        fetchJSON(url).then(data => {
          if (!Array.isArray(data)) {
            throw new Error(
              `[Step 1] Expected array for fuelType=${fuelType} / ${label}, ` +
              `got: ${typeof data}. Raw: ${JSON.stringify(data).slice(0, 200)}`
            );
          }
          // Tag each result with the fuel type so the merge step knows which
          // price slot to fill.  The array elements themselves are not mutated.
          return { fuelType, data };
        })
      )
    );
  } catch (err) {
    // Re-throw with a [Step 1] prefix so main()'s catch block labels it correctly.
    throw new Error(`[Step 1] Parallel fetch failed: ${err.message}`);
  }

  console.log(`[Step 1] All ${tasks.length} requests completed.`);

  // ── SHAPE ASSUMPTIONS ────────────────────────────────────────────────────
  // The E-Control API is not fully publicly documented.
  // Based on observed responses, each element is assumed to have:
  //
  //   {
  //     id:       number,            // unique station identifier
  //     name:     string,
  //     location: {
  //       latitude:   number,
  //       longitude:  number,
  //       address:    string,        // street + house number
  //       city:       string,
  //       postalCode: string
  //     },
  //     brand:    string | null,
  //     prices: [
  //       { fuelType: "DIE" | "SUP" | "SUP98", amount: number }
  //     ]
  //   }
  //
  // Log the first station from the first DIE result to verify the shape.
  const firstDIEResult = rawResults.find(r => r.fuelType === 'DIE');
  if (firstDIEResult && firstDIEResult.data.length > 0) {
    console.log(
      '[Step 1] First DIE station sample (verify shape):',
      JSON.stringify(firstDIEResult.data[0], null, 2)
    );
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Merge all results into a single Map keyed by station ID.
  //
  // Iteration order:
  //   rawResults is an array of { fuelType, data[] } objects in task order.
  //   For each result, we iterate its data array.  If a station ID is already
  //   in the map (seen from an earlier location query), we skip re-creating the
  //   base record but still update the price slot for this fuelType — provided
  //   the slot is still null, meaning we keep the first price seen per fuel type
  //   (prices for the same station should be identical across radius queries).

  const stationMap = new Map();

  for (const { fuelType, data } of rawResults) {
    for (const station of data) {
      const id = station.id;

      if (!stationMap.has(id)) {
        // ASSUMPTION: location data lives in station.location (see shape above).
        const loc = station.location ?? {};
        stationMap.set(id, {
          id,
          name:    station.name  ?? '',
          lat:     loc.latitude  ?? null,
          lng:     loc.longitude ?? null,
          address: loc.address   ?? '',
          city:    loc.city      ?? '',
          brand:   station.brand ?? '',
          // All three price slots start as null; filled in below as results arrive.
          _prices: { DIE: null, SUP: null, SUP98: null },
        });
      }

      // ASSUMPTION: station.prices is an array of { fuelType, amount }.
      // We look for the entry matching the current fuel type code.
      // Only write the slot if it is still null (first-seen wins; avoids
      // overwriting a valid price with a duplicate query's result).
      const entry = stationMap.get(id);
      if (entry._prices[fuelType] === null && Array.isArray(station.prices)) {
        const priceRow = station.prices.find(p => p.fuelType === fuelType);
        if (priceRow != null) {
          entry._prices[fuelType] = priceRow.amount ?? null;
        }
      }
    }
  }

  // Shape the final station array, replacing internal _prices keys with the
  // human-readable Austrian fuel type labels defined at the top of the file.
  const stations = Array.from(stationMap.values()).map(s => ({
    id:      s.id,
    name:    s.name,
    lat:     s.lat,
    lng:     s.lng,
    address: s.address,
    city:    s.city,
    brand:   s.brand,
    prices: {
      [FUEL_LABEL.DIE]:   s._prices.DIE,
      [FUEL_LABEL.SUP]:   s._prices.SUP,
      [FUEL_LABEL.SUP98]: s._prices.SUP98,
    },
  }));

  console.log(`[Step 1] Deduplicated to ${stations.length} unique stations across Austria.`);
  return stations;
}

// ─── Step 2: EIA v2 — Brent crude spot price ─────────────────────────────────
//
// EIA v2 API docs: https://www.eia.gov/opendata/documentation.php
//
// NOTE: Series ID "RBRTE" is the Brent crude spot price as listed in
//       https://www.eia.gov/opendata/browser/petroleum/pri/spt
//       If EIA has changed this series ID the call will return an empty array
//       and the Stooq fallback will activate.
//
// The query string uses bracket notation (data[]=value, facets[series][]=RBRTE).
// We build it manually to avoid URLSearchParams percent-encoding the brackets,
// because EIA v2 may not accept %5B%5D in place of literal [].

async function fetchEIA() {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    throw new Error(
      '[Step 2] EIA_API_KEY environment variable is not set. ' +
      'Add it as a GitHub Actions secret.'
    );
  }

  // Manually assembled to keep literal [ ] brackets (not %5B%5D).
  const url =
    'https://api.eia.gov/v2/petroleum/pri/spt/data/' +
    `?api_key=${encodeURIComponent(apiKey)}` +
    '&frequency=daily' +
    '&data[]=value' +
    '&facets[series][]=RBRTE' +
    '&sort[0][column]=period' +
    '&sort[0][direction]=desc' +
    '&length=2';

  // Let any throw propagate to the caller so the Stooq fallback can activate.
  const data = await fetchJSON(url);

  // ASSUMPTION: EIA v2 response shape:
  //   {
  //     response: {
  //       data: [
  //         { period: "2024-01-15", series: "RBRTE", seriesDescription: "...",
  //           value: 76.51, unit: "Dollars per Barrel" },
  //         { period: "2024-01-14", ... value: 75.90 }
  //       ]
  //     }
  //   }
  const rows = data?.response?.data;

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      '[Step 2] EIA returned no data rows. ' +
      'Series RBRTE may have changed. ' +
      `Raw response: ${JSON.stringify(data).slice(0, 300)}`
    );
  }

  // rows[0] is the most recent (sorted desc by period).
  const latest   = rows[0];
  const previous = rows[1] ?? null;

  // ASSUMPTION: price is in `value` (number or numeric string), date in `period`.
  const price_usd = parseFloat(latest.value);
  if (isNaN(price_usd)) {
    throw new Error(
      `[Step 2] EIA value field is not a number: ${JSON.stringify(latest.value)}`
    );
  }

  const previous_price_usd =
    previous != null && !isNaN(parseFloat(previous.value))
      ? parseFloat(previous.value)
      : null;

  console.log(`[Step 2] EIA: period=${latest.period}, price_usd=${price_usd}`);

  return {
    date:               latest.period, // "YYYY-MM-DD"
    price_usd,
    previous_price_usd,
    source:             'EIA',
  };
}

// ─── Step 3: Stooq fallback ───────────────────────────────────────────────────
//
// Stooq provides a free CSV endpoint for commodities.
// Symbol @brn.uk is ICE Brent Crude (London) on Stooq.
// NOTE: Stooq symbols are not formally documented; this is the observed symbol.
//       If Stooq changes it the script will throw and exit with code 1.

async function fetchStooq() {
  console.log('[Step 3] Fetching Brent crude from Stooq (fallback)…');

  const url = 'https://stooq.com/q/d/l/?s=@brn.uk&i=d';
  let csv;
  try {
    csv = await fetchText(url);
  } catch (err) {
    throw new Error(`[Step 3] Stooq fetch failed: ${err.message}`);
  }

  // ASSUMPTION: Stooq returns a plain-text CSV with header row:
  //   Date,Open,High,Low,Close,Volume
  // Rows are in ascending date order; the last non-empty row is the most recent.

  const lines = csv
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (lines.length < 2) {
    throw new Error(
      `[Step 3] Stooq CSV has fewer than 2 lines. Raw: ${csv.slice(0, 200)}`
    );
  }

  const headerFields = lines[0].toLowerCase().split(',').map(h => h.trim());
  const dateIdx      = headerFields.indexOf('date');
  const closeIdx     = headerFields.indexOf('close');

  if (dateIdx === -1 || closeIdx === -1) {
    throw new Error(
      `[Step 3] Unexpected Stooq CSV header: "${lines[0]}". ` +
      'Expected columns "Date" and "Close".'
    );
  }

  // Most recent row.
  const lastFields = lines[lines.length - 1].split(',');
  const date       = lastFields[dateIdx]?.trim();
  const price_usd  = parseFloat(lastFields[closeIdx]?.trim());

  if (!date || isNaN(price_usd)) {
    throw new Error(
      `[Step 3] Could not parse Stooq last row: "${lines[lines.length - 1]}"`
    );
  }

  // Previous row (second-to-last) for change calculation.
  let previous_price_usd = null;
  if (lines.length >= 3) {
    const prevFields = lines[lines.length - 2].split(',');
    const prevClose  = parseFloat(prevFields[closeIdx]?.trim());
    previous_price_usd = isNaN(prevClose) ? null : prevClose;
  }

  console.log(`[Step 3] Stooq: date=${date}, close=${price_usd}`);

  return { date, price_usd, previous_price_usd, source: 'Stooq' };
}

// ─── Step 4: ECB EUR/USD rate ─────────────────────────────────────────────────
//
// ECB publishes a daily XML file with foreign exchange reference rates.
// We parse it with regex only — no XML library required.

async function fetchECBRate() {
  console.log('[Step 4] Fetching EUR/USD rate from ECB…');

  const url = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
  let xml;
  try {
    xml = await fetchText(url);
  } catch (err) {
    throw new Error(`[Step 4] ECB fetch failed: ${err.message}`);
  }

  // ECB XML contains one line per currency in the form:
  //   <Cube currency='USD' rate='1.0876'/>
  // or with double quotes (the spec uses single quotes, but we handle both).
  const match = xml.match(/currency=['"]USD['"]\s+rate=['"]([^'"]+)['"]/);
  if (!match) {
    throw new Error(
      '[Step 4] Could not find USD rate in ECB XML. ' +
      `First 500 chars: ${xml.slice(0, 500)}`
    );
  }

  const rate = parseFloat(match[1]);
  if (isNaN(rate) || rate <= 0) {
    throw new Error(
      `[Step 4] Parsed ECB EUR/USD rate is invalid: "${match[1]}"`
    );
  }

  console.log(`[Step 4] EUR/USD rate: ${rate}`);
  return rate;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {

  // ── Step 1: E-Control stations ──────────────────────────────────────────────
  let stations;
  try {
    stations = await fetchEControl();
  } catch (err) {
    console.error('[Step 1] FAILED:', err.message);
    process.exit(1);
  }

  // ── Steps 2 + 3: Brent crude (EIA primary, Stooq fallback) ──────────────────
  let brentRaw;
  try {
    brentRaw = await fetchEIA();
  } catch (eiaErr) {
    console.warn(
      `[Step 2] EIA failed: ${eiaErr.message}\n` +
      '[Step 2] Activating Stooq fallback…'
    );
    try {
      brentRaw = await fetchStooq();
    } catch (stooqErr) {
      console.error('[Step 3] Stooq fallback FAILED:', stooqErr.message);
      process.exit(1);
    }
  }

  // ── Step 4: ECB EUR/USD ──────────────────────────────────────────────────────
  let eurUsdRate;
  try {
    eurUsdRate = await fetchECBRate();
  } catch (err) {
    console.error('[Step 4] FAILED:', err.message);
    process.exit(1);
  }

  // Derived calculations.
  // price_eur: the USD price converted to EUR.
  // EUR/USD rate from ECB means: 1 EUR = eurUsdRate USD, so 1 USD = 1/eurUsdRate EUR.
  const price_eur = brentRaw.price_usd / eurUsdRate;

  let change_pct = null;
  if (
    brentRaw.previous_price_usd !== null &&
    brentRaw.previous_price_usd !== 0
  ) {
    change_pct =
      ((brentRaw.price_usd - brentRaw.previous_price_usd) /
        brentRaw.previous_price_usd) *
      100;
  }

  const brentOutput = {
    date:               brentRaw.date,
    price_usd:          parseFloat(brentRaw.price_usd.toFixed(2)),
    price_eur:          parseFloat(price_eur.toFixed(2)),
    previous_price_usd:
      brentRaw.previous_price_usd !== null
        ? parseFloat(brentRaw.previous_price_usd.toFixed(2))
        : null,
    change_pct:
      change_pct !== null ? parseFloat(change_pct.toFixed(4)) : null,
    eur_usd_rate: parseFloat(eurUsdRate.toFixed(4)),
    source:       brentRaw.source,
  };

  // ── Step 5: Create directories ───────────────────────────────────────────────
  try {
    fs.mkdirSync(DATA_DIR,    { recursive: true });
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    console.log('[Step 5] Directories ensured: data/ and data/history/');
  } catch (err) {
    console.error('[Step 5] FAILED to create directories:', err.message);
    process.exit(1);
  }

  // ── Step 6: Write output files ───────────────────────────────────────────────

  // data/stations.json
  const stationsPath = path.join(DATA_DIR, 'stations.json');
  try {
    fs.writeFileSync(stationsPath, JSON.stringify(stations, null, 2), 'utf8');
    console.log('[Step 6] Written: data/stations.json');
  } catch (err) {
    console.error('[Step 6] FAILED to write stations.json:', err.message);
    process.exit(1);
  }

  // data/brent.json
  const brentPath = path.join(DATA_DIR, 'brent.json');
  try {
    fs.writeFileSync(brentPath, JSON.stringify(brentOutput, null, 2), 'utf8');
    console.log('[Step 6] Written: data/brent.json');
  } catch (err) {
    console.error('[Step 6] FAILED to write brent.json:', err.message);
    process.exit(1);
  }

  // data/history/YYYY-MM-DD.json  — skip if it already exists
  const historyPath = path.join(HISTORY_DIR, `${TODAY_UTC}.json`);
  if (fs.existsSync(historyPath)) {
    console.log(
      `[Step 6] Skipping history write — data/history/${TODAY_UTC}.json already exists.`
    );
  } else {
    try {
      fs.writeFileSync(historyPath, JSON.stringify(stations, null, 2), 'utf8');
      console.log(`[Step 6] Written: data/history/${TODAY_UTC}.json`);
    } catch (err) {
      console.error(
        `[Step 6] FAILED to write history/${TODAY_UTC}.json:`,
        err.message
      );
      process.exit(1);
    }
  }

  // ── Step 7: Summary line ─────────────────────────────────────────────────────
  console.log(
    `Fetched ${stations.length} stations | ` +
    `Brent: $${brentOutput.price_usd.toFixed(2)} ` +
    `(EUR ${brentOutput.price_eur.toFixed(2)}) | ` +
    `Source: ${brentOutput.source} | ` +
    `EUR/USD: ${brentOutput.eur_usd_rate.toFixed(2)}`
  );
}

// ─── Entry point ──────────────────────────────────────────────────────────────
// Any unhandled promise rejection that slips past the per-step try/catch
// is caught here so the process always exits with code 1 on failure.
main().catch(err => {
  console.error('[Unhandled] FAILED:', err.message);
  process.exit(1);
});
