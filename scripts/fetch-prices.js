'use strict';
// scripts/fetch-prices.js
//
// Runs ONLY inside GitHub Actions on ubuntu-latest, Node 20.
// Native fetch is available — no npm install required.
// Execute with:  node scripts/fetch-prices.js
//
// Fetch order for brent.json (current price badge):
//   PRIMARY:  Stooq CSV  — updates daily, no API key needed
//   FALLBACK: EIA API    — 3-8 day lag but reliable
//
// Fetch order for brent-history.json (90-day chart):
//   Always EIA — historical lag is irrelevant for a multi-month chart
//
// Station prices are fetched directly by the browser — not handled here.

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

// ─── Step 1 (primary): Stooq CSV — current Brent price ───────────────────────
//
// Stooq returns a CSV for @brn.uk (ICE Brent Crude, London) sorted
// newest-first.  Stooq symbols are not formally documented; @brn.uk is
// the observed symbol for Brent.
//
// Expected CSV shape (newest row first after the header):
//   Date,Open,High,Low,Close,Volume
//   2026-06-02,96.45,97.21,95.76,96.89,123456
//   2026-06-01,94.12,96.50,93.80,96.42,98765
//   ...
//
// Column indices used (0-based):
//   0 → Date   (YYYY-MM-DD)
//   4 → Close  (most recent settlement price)
//
// We validate the header row to detect format changes before relying on
// fixed indices, but do not throw on a header mismatch — we fall back to EIA.

async function fetchStooq() {
  console.log('[Step 1] Fetching Brent crude from Stooq (primary)…');

  const url = 'https://stooq.com/q/d/l/?s=@brn.uk&i=d';
  let csv;
  try {
    csv = await fetchText(url);
  } catch (err) {
    throw new Error(`[Step 1] Stooq network error: ${err.message}`);
  }

  // Split and drop blank lines.
  const lines = csv
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  // Need at least a header row and one data row.
  if (lines.length < 2) {
    throw new Error(
      `[Step 1] Stooq CSV has fewer than 2 lines — cannot parse. ` +
      `Raw: ${csv.slice(0, 200)}`
    );
  }

  // Warn if the header doesn't match the expected shape so CI logs flag it,
  // but still attempt parsing — the column layout rarely changes.
  const expectedHeader = 'date,open,high,low,close,volume';
  const actualHeader   = lines[0].toLowerCase().trim();
  if (actualHeader !== expectedHeader) {
    console.warn(
      `[Step 1] Stooq header mismatch. Expected: "${expectedHeader}". ` +
      `Got: "${actualHeader}". Attempting parse anyway.`
    );
  }

  // First data row is the most recent date (CSV is newest-first).
  const latestRow   = lines[1].split(',');
  const previousRow = lines.length >= 3 ? lines[2].split(',') : null;

  // ASSUMPTION: column 0 = Date, column 4 = Close (per documented CSV shape above).
  const date      = latestRow[0]?.trim();
  const price_usd = parseFloat(latestRow[4]?.trim());

  if (!date || isNaN(price_usd)) {
    throw new Error(
      `[Step 1] Stooq: could not parse date or close price from row: "${lines[1]}"`
    );
  }

  let previous_price_usd = null;
  if (previousRow !== null) {
    const prevClose = parseFloat(previousRow[4]?.trim());
    previous_price_usd = isNaN(prevClose) ? null : prevClose;
  }

  console.log(`[Stooq] period=${date}, price_usd=${price_usd}`);

  return { date, price_usd, previous_price_usd, source: 'Stooq' };
}

// ─── Step 1 (fallback): EIA v2 — current Brent price ─────────────────────────
//
// EIA v2 API docs: https://www.eia.gov/opendata/documentation.php
//
// Series IDs tried in order until one returns data.  RBRTE is the
// documented Brent spot price series; EPCBRENT and BRT are included as
// fallbacks in case EIA renames the series.
//   RBRTE    — Europe Brent Spot Price FOB (primary)
//   EPCBRENT — alternate ID observed in EIA v2 browser
//   BRT      — short alias; not confirmed in docs, included as last resort
//
// The query string uses literal [ ] brackets.  URLSearchParams would
// percent-encode them to %5B%5D which EIA v2 may not accept.

const EIA_SERIES_IDS = ['RBRTE', 'EPCBRENT', 'BRT'];

async function fetchEIA() {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    throw new Error(
      '[EIA] EIA_API_KEY environment variable is not set. ' +
      'Add it as a GitHub Actions secret.'
    );
  }

  let lastError = null;

  for (const seriesId of EIA_SERIES_IDS) {
    const url =
      'https://api.eia.gov/v2/petroleum/pri/spt/data/' +
      `?api_key=${encodeURIComponent(apiKey)}` +
      '&frequency=daily' +
      '&data[]=value' +
      `&facets[series][]=${seriesId}` +
      '&sort[0][column]=period' +
      '&sort[0][direction]=desc' +
      '&length=2';

    let eiaJson;
    try {
      eiaJson = await fetchJSON(url);
    } catch (networkErr) {
      console.warn(`[EIA] Network error for series ${seriesId}: ${networkErr.message}`);
      lastError = networkErr;
      continue;
    }

    // Log the raw response so CI logs show exactly what EIA is returning.
    console.log(`[EIA Raw] series=${seriesId}`, JSON.stringify(eiaJson).slice(0, 500));

    // ASSUMPTION: EIA v2 response shape:
    //   {
    //     response: {
    //       data: [
    //         { period: "2024-01-15", series: "RBRTE", value: "76.51" },
    //         { period: "2024-01-14", value: "75.90" }
    //       ]
    //     }
    //   }
    // `value` may be a string or number — parseFloat handles both.
    const rows = eiaJson?.response?.data;

    if (!Array.isArray(rows) || rows.length === 0) {
      console.warn(`[EIA] Series ${seriesId} returned no data rows — trying next.`);
      lastError = new Error(`EIA series ${seriesId} returned no data rows`);
      continue;
    }

    const latest   = rows[0];
    const previous = rows[1] ?? null;

    const price_usd = parseFloat(latest.value);
    if (isNaN(price_usd)) {
      console.warn(
        `[EIA] Series ${seriesId} value is not a number: ` +
        `${JSON.stringify(latest.value)} — trying next.`
      );
      lastError = new Error(`EIA series ${seriesId} value not a number`);
      continue;
    }

    const previous_price_usd =
      previous != null && !isNaN(parseFloat(previous.value))
        ? parseFloat(previous.value)
        : null;

    console.log(
      `[EIA] Success: series=${seriesId}, ` +
      `period=${latest.period}, price_usd=${price_usd}`
    );

    return {
      date:               latest.period, // "YYYY-MM-DD"
      price_usd,
      previous_price_usd,
      source:             'EIA',
    };
  }

  // All series exhausted.
  throw new Error(
    `[EIA] All series failed (${EIA_SERIES_IDS.join(', ')}). ` +
    `Last error: ${lastError?.message ?? 'unknown'}`
  );
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

// ─── Step 5: EIA v2 — 90-day Brent history ───────────────────────────────────
//
// Always uses EIA regardless of which source provided the current price.
// Historical lag (3-8 days) does not matter for a chart showing 90 days of data.
//
// This function tries all EIA_SERIES_IDS internally so it is not coupled to
// whichever source (Stooq or EIA) succeeded for the current price.
//
// ASSUMPTION: response shape:
//   { response: { data: [ { period: "YYYY-MM-DD", value: "123.45" }, … ] } }
// `value` is a string — parseFloat() is used on every row.

async function fetchEIAHistory() {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    throw new Error(
      '[Step 5] EIA_API_KEY is not set — cannot fetch history.'
    );
  }

  let lastError = null;

  for (const seriesId of EIA_SERIES_IDS) {
    console.log(`[Step 5] Fetching 90-day Brent history from EIA (series=${seriesId})…`);

    const url =
      'https://api.eia.gov/v2/petroleum/pri/spt/data/' +
      `?api_key=${encodeURIComponent(apiKey)}` +
      '&frequency=daily' +
      '&data[]=value' +
      `&facets[series][]=${seriesId}` +
      '&sort[0][column]=period' +
      '&sort[0][direction]=desc' +
      '&length=90';

    let data;
    try {
      data = await fetchJSON(url);
    } catch (networkErr) {
      console.warn(`[Step 5] EIA network error for series ${seriesId}: ${networkErr.message}`);
      lastError = networkErr;
      continue;
    }

    // Log raw response for the same visibility as the spot-price fetch.
    console.log('[EIA Raw] history', JSON.stringify(data).slice(0, 500));

    const rows = data?.response?.data;
    if (!Array.isArray(rows) || rows.length === 0) {
      console.warn(`[Step 5] EIA history series ${seriesId} returned no data rows — trying next.`);
      lastError = new Error(`EIA history series ${seriesId} returned no data rows`);
      continue;
    }

    // Parse and validate every row before building the output array so a
    // single bad row fails loudly rather than silently producing a NaN entry.
    let parsed;
    try {
      parsed = rows.map((row, i) => {
        const price_usd = parseFloat(row.value);
        if (!row.period || isNaN(price_usd)) {
          throw new Error(
            `Row ${i} has invalid period or value: ${JSON.stringify(row)}`
          );
        }
        return { date: row.period, price_usd: parseFloat(price_usd.toFixed(2)) };
      });
    } catch (parseErr) {
      console.warn(`[Step 5] EIA history parse error for series ${seriesId}: ${parseErr.message}`);
      lastError = parseErr;
      continue;
    }

    // API returns newest-first; reverse so output is oldest-to-newest.
    parsed.reverse();

    console.log(
      `[Step 5] EIA history success: series=${seriesId}, ` +
      `${parsed.length} rows, ${parsed[0].date} → ${parsed[parsed.length - 1].date}`
    );

    return parsed;
  }

  throw new Error(
    `[Step 5] All EIA history series failed (${EIA_SERIES_IDS.join(', ')}). ` +
    `Last error: ${lastError?.message ?? 'unknown'}`
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {

  // Ensure data/ exists before any file reads or writes below.
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('[Setup] FAILED to create data/ directory:', err.message);
    process.exit(1);
  }

  // ── Steps 1 + 2: Brent crude current price ───────────────────────────────────
  // Primary: Stooq (current, no API key).  Fallback: EIA (lagged, needs API key).
  // If both fail: mark existing brent.json stale and continue — do not exit(1).

  let brentRaw    = null;
  let brentFailed = false;

  try {
    try {
      brentRaw = await fetchStooq();
    } catch (stooqErr) {
      console.warn(
        `[Step 1] Stooq failed: ${stooqErr.message}\n` +
        '[Step 1] Activating EIA fallback…'
      );
      brentRaw = await fetchEIA(); // throws if all EIA series also fail
    }
  } catch (allSourcesFailed) {
    brentFailed = true;
    console.error(
      '[Brent] BOTH Stooq and EIA failed. Error:',
      allSourcesFailed.message
    );

    // Write stale flag into existing brent.json if it exists so the browser
    // can show a warning rather than crashing on missing data.
    const brentPath = path.join(DATA_DIR, 'brent.json');
    if (fs.existsSync(brentPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(brentPath, 'utf8'));
        existing.stale = true;
        fs.writeFileSync(brentPath, JSON.stringify(existing, null, 2), 'utf8');
        console.log('[Brent] Wrote stale=true to existing data/brent.json — continuing.');
      } catch (readWriteErr) {
        console.error('[Brent] Could not update stale brent.json:', readWriteErr.message);
      }
    } else {
      console.warn('[Brent] No existing brent.json to mark stale — file will be absent.');
    }
  }

  // ECB rate and history both depend on a live Brent value — skip if failed.
  if (brentFailed) {
    console.log('[Brent] Skipping ECB and history steps due to Brent fetch failure.');
    console.log('Script finished with degraded data.');
    return;
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
  // EUR/USD rate from ECB: 1 EUR = eurUsdRate USD → 1 USD = 1/eurUsdRate EUR.
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
      // Rounded to 2 decimal places as specified.
      change_pct !== null ? parseFloat(change_pct.toFixed(2)) : null,
    eur_usd_rate: parseFloat(eurUsdRate.toFixed(4)),
    source:       brentRaw.source,
    // `stale` is intentionally absent on a successful fetch
  };

  // ── Step 4: Write data/brent.json ────────────────────────────────────────────
  const brentPath = path.join(DATA_DIR, 'brent.json');
  try {
    fs.writeFileSync(brentPath, JSON.stringify(brentOutput, null, 2), 'utf8');
    console.log('[Step 4] Written: data/brent.json');
  } catch (err) {
    console.error('[Step 4] FAILED to write brent.json:', err.message);
    process.exit(1);
  }

  // ── Step 5: EIA 90-day history ───────────────────────────────────────────────
  // Always uses EIA directly — independent of which source gave the current
  // price.  If EIA_API_KEY is absent, fetchEIAHistory() throws and we exit(1)
  // because a missing key is a CI configuration error, not a transient failure.
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
