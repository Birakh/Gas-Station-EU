'use strict';
// scripts/fetch-prices.js
//
// Runs ONLY inside GitHub Actions on ubuntu-latest, Node 20.
// Native fetch is available — no npm install required.
// Execute with:  node scripts/fetch-prices.js
//
// This script fetches only Brent crude oil price and EUR/USD rate,
// then writes data/brent.json.  Station prices are fetched directly
// by the browser using the user's geolocation — not handled here.

const fs   = require('fs');
const path = require('path');

// __dirname is the `scripts/` directory; go one level up for the repo root.
const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_DIR  = path.join(REPO_ROOT, 'data');

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

// ─── Step 1: EIA v2 — Brent crude spot price ─────────────────────────────────
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
      '[Step 1] EIA_API_KEY environment variable is not set. ' +
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
      '[Step 1] EIA returned no data rows. ' +
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
      `[Step 1] EIA value field is not a number: ${JSON.stringify(latest.value)}`
    );
  }

  const previous_price_usd =
    previous != null && !isNaN(parseFloat(previous.value))
      ? parseFloat(previous.value)
      : null;

  console.log(`[Step 1] EIA: period=${latest.period}, price_usd=${price_usd}`);

  return {
    date:               latest.period, // "YYYY-MM-DD"
    price_usd,
    previous_price_usd,
    source:             'EIA',
  };
}

// ─── Step 2: Stooq fallback ───────────────────────────────────────────────────
//
// Stooq provides a free CSV endpoint for commodities.
// Symbol @brn.uk is ICE Brent Crude (London) on Stooq.
// NOTE: Stooq symbols are not formally documented; this is the observed symbol.
//       If Stooq changes it the script will throw and exit with code 1.

async function fetchStooq() {
  console.log('[Step 2] Fetching Brent crude from Stooq (fallback)…');

  const url = 'https://stooq.com/q/d/l/?s=@brn.uk&i=d';
  let csv;
  try {
    csv = await fetchText(url);
  } catch (err) {
    throw new Error(`[Step 2] Stooq fetch failed: ${err.message}`);
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
      `[Step 2] Stooq CSV has fewer than 2 lines. Raw: ${csv.slice(0, 200)}`
    );
  }

  const headerFields = lines[0].toLowerCase().split(',').map(h => h.trim());
  const dateIdx      = headerFields.indexOf('date');
  const closeIdx     = headerFields.indexOf('close');

  if (dateIdx === -1 || closeIdx === -1) {
    throw new Error(
      `[Step 2] Unexpected Stooq CSV header: "${lines[0]}". ` +
      'Expected columns "Date" and "Close".'
    );
  }

  // Most recent row.
  const lastFields = lines[lines.length - 1].split(',');
  const date       = lastFields[dateIdx]?.trim();
  const price_usd  = parseFloat(lastFields[closeIdx]?.trim());

  if (!date || isNaN(price_usd)) {
    throw new Error(
      `[Step 2] Could not parse Stooq last row: "${lines[lines.length - 1]}"`
    );
  }

  // Previous row (second-to-last) for change calculation.
  let previous_price_usd = null;
  if (lines.length >= 3) {
    const prevFields = lines[lines.length - 2].split(',');
    const prevClose  = parseFloat(prevFields[closeIdx]?.trim());
    previous_price_usd = isNaN(prevClose) ? null : prevClose;
  }

  console.log(`[Step 2] Stooq: date=${date}, close=${price_usd}`);

  return { date, price_usd, previous_price_usd, source: 'Stooq' };
}

// ─── Step 3: ECB EUR/USD rate ─────────────────────────────────────────────────
//
// ECB publishes a daily XML file with foreign exchange reference rates.
// We parse it with regex only — no XML library required.

async function fetchECBRate() {
  console.log('[Step 3] Fetching EUR/USD rate from ECB…');

  const url = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
  let xml;
  try {
    xml = await fetchText(url);
  } catch (err) {
    throw new Error(`[Step 3] ECB fetch failed: ${err.message}`);
  }

  // ECB XML contains one line per currency in the form:
  //   <Cube currency='USD' rate='1.0876'/>
  // or with double quotes (the spec uses single quotes, but we handle both).
  const match = xml.match(/currency=['"]USD['"]\s+rate=['"]([^'"]+)['"]/);
  if (!match) {
    throw new Error(
      '[Step 3] Could not find USD rate in ECB XML. ' +
      `First 500 chars: ${xml.slice(0, 500)}`
    );
  }

  const rate = parseFloat(match[1]);
  if (isNaN(rate) || rate <= 0) {
    throw new Error(
      `[Step 3] Parsed ECB EUR/USD rate is invalid: "${match[1]}"`
    );
  }

  console.log(`[Step 3] EUR/USD rate: ${rate}`);
  return rate;
}

// ─── Step 4: EIA v2 — 90-day Brent history ───────────────────────────────────
//
// Same endpoint and API key as Step 1, but length=90 instead of length=2.
// The response comes newest-first; we reverse it so the output array runs
// oldest-to-newest, which is the natural order for a time-series chart.
//
// This is a separate function (not reused from fetchEIA) because the two
// calls have different purposes, different lengths, and different return
// shapes — merging them would add branching complexity for no benefit.
//
// ASSUMPTION: response shape is identical to fetchEIA():
//   { response: { data: [ { period: "YYYY-MM-DD", value: "123.45" }, … ] } }
// `value` is a string — parseFloat() is used on every row.

async function fetchEIAHistory() {
  console.log('[Step 4] Fetching 90-day Brent history from EIA…');

  // apiKey was already validated in fetchEIA(); if we reach here it is set.
  const apiKey = process.env.EIA_API_KEY;

  const url =
    'https://api.eia.gov/v2/petroleum/pri/spt/data/' +
    `?api_key=${encodeURIComponent(apiKey)}` +
    '&frequency=daily' +
    '&data[]=value' +
    '&facets[series][]=RBRTE' +
    '&sort[0][column]=period' +
    '&sort[0][direction]=desc' +
    '&length=90';

  const data = await fetchJSON(url);

  const rows = data?.response?.data;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      '[Step 4] EIA history returned no data rows. ' +
      `Raw response: ${JSON.stringify(data).slice(0, 300)}`
    );
  }

  // Parse and validate every row before touching the output array so a
  // single bad row fails loudly rather than silently producing a NaN entry.
  const parsed = rows.map((row, i) => {
    const price_usd = parseFloat(row.value);
    if (!row.period || isNaN(price_usd)) {
      throw new Error(
        `[Step 4] EIA history row ${i} has invalid period or value: ` +
        JSON.stringify(row)
      );
    }
    return { date: row.period, price_usd: parseFloat(price_usd.toFixed(2)) };
  });

  // API returns newest-first; reverse so output is oldest-to-newest.
  parsed.reverse();

  console.log(
    `[Step 4] EIA history: ${parsed.length} rows, ` +
    `${parsed[0].date} → ${parsed[parsed.length - 1].date}`
  );

  return parsed;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {

  // ── Steps 1 + 2: Brent crude (EIA primary, Stooq fallback) ──────────────────
  let brentRaw;
  try {
    brentRaw = await fetchEIA();
  } catch (eiaErr) {
    console.warn(
      `[Step 1] EIA failed: ${eiaErr.message}\n` +
      '[Step 1] Activating Stooq fallback…'
    );
    try {
      brentRaw = await fetchStooq();
    } catch (stooqErr) {
      console.error('[Step 2] Stooq fallback FAILED:', stooqErr.message);
      process.exit(1);
    }
  }

  // ── Step 3: ECB EUR/USD ──────────────────────────────────────────────────────
  let eurUsdRate;
  try {
    eurUsdRate = await fetchECBRate();
  } catch (err) {
    console.error('[Step 3] FAILED:', err.message);
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

  // ── Step 4: Write data/brent.json ────────────────────────────────────────────
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('[Step 4] FAILED to create data/ directory:', err.message);
    process.exit(1);
  }

  const brentPath = path.join(DATA_DIR, 'brent.json');
  try {
    fs.writeFileSync(brentPath, JSON.stringify(brentOutput, null, 2), 'utf8');
    console.log('[Step 4] Written: data/brent.json');
  } catch (err) {
    console.error('[Step 4] FAILED to write brent.json:', err.message);
    process.exit(1);
  }

  // ── Step 5: EIA 90-day history ───────────────────────────────────────────────
  // Only available when EIA was reachable (brentRaw.source === 'EIA').
  // If we fell back to Stooq we skip this step rather than calling EIA a
  // second time after it already failed — the existing brent-history.json
  // from the previous successful run remains on disk unchanged.
  if (brentRaw.source === 'EIA') {
    let historyRows;
    try {
      historyRows = await fetchEIAHistory();
    } catch (err) {
      console.error('[Step 5] FAILED to fetch Brent history:', err.message);
      process.exit(1);
    }

    const historyOutput = {
      updated: new Date().toISOString().slice(0, 10), // "YYYY-MM-DD" UTC
      data:    historyRows,
    };

    const historyPath = path.join(DATA_DIR, 'brent-history.json');
    try {
      fs.writeFileSync(
        historyPath,
        JSON.stringify(historyOutput, null, 2),
        'utf8'
      );
      console.log('[Step 5] Written: data/brent-history.json');
    } catch (err) {
      console.error('[Step 5] FAILED to write brent-history.json:', err.message);
      process.exit(1);
    }
  } else {
    console.log(
      '[Step 5] Skipping history fetch — Brent source is Stooq, not EIA. ' +
      'Existing data/brent-history.json (if any) is unchanged.'
    );
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(
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
