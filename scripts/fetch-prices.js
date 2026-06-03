'use strict';
// scripts/fetch-prices.js
//
// Runs ONLY inside GitHub Actions on ubuntu-latest, Node 20.
// Native fetch is available — no npm install required.
// Execute with:  node scripts/fetch-prices.js
//
// This script fetches Brent crude oil price and EUR/USD rate,
// then writes data/brent.json and data/brent-history.json.
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

// ─── Step 1: EIA v2 — Brent crude spot price ─────────────────────────────────
//
// EIA v2 API docs: https://www.eia.gov/opendata/documentation.php
//
// Series IDs tried in order until one returns data.  RBRTE is the
// documented Brent spot price series; EPCBRENT and BRT are included as
// fallbacks in case EIA renames the series.
//   RBRTE   — Europe Brent Spot Price FOB (primary)
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
      '[Step 1] EIA_API_KEY environment variable is not set. ' +
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
      console.warn(`[Step 1] EIA network error for series ${seriesId}: ${networkErr.message}`);
      lastError = networkErr;
      continue; // try next series ID
    }

    // FIX 3: Log the raw response immediately after every fetch attempt
    // so CI logs show exactly what EIA is returning, regardless of outcome.
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
      console.warn(
        `[Step 1] EIA series ${seriesId} returned no data rows — trying next series.`
      );
      lastError = new Error(`EIA series ${seriesId} returned no data rows`);
      continue;
    }

    const latest   = rows[0];
    const previous = rows[1] ?? null;

    const price_usd = parseFloat(latest.value);
    if (isNaN(price_usd)) {
      console.warn(
        `[Step 1] EIA series ${seriesId} value is not a number: ` +
        `${JSON.stringify(latest.value)} — trying next series.`
      );
      lastError = new Error(`EIA series ${seriesId} value not a number`);
      continue;
    }

    const previous_price_usd =
      previous != null && !isNaN(parseFloat(previous.value))
        ? parseFloat(previous.value)
        : null;

    console.log(
      `[Step 1] EIA success: series=${seriesId}, ` +
      `period=${latest.period}, price_usd=${price_usd}`
    );

    return {
      date:               latest.period, // "YYYY-MM-DD"
      price_usd,
      previous_price_usd,
      source:             'EIA',
      seriesId,           // passed to fetchEIAHistory() so both calls use the same series
    };
  }

  // All series exhausted.
  throw new Error(
    `[Step 1] All EIA series failed (${EIA_SERIES_IDS.join(', ')}). ` +
    `Last error: ${lastError?.message ?? 'unknown'}`
  );
}

// ─── Step 2: Stooq fallback ───────────────────────────────────────────────────
//
// Stooq provides a free CSV endpoint for commodities.
// Symbol @brn.uk is ICE Brent Crude (London) on Stooq.
// NOTE: Stooq symbols are not formally documented; this is the observed symbol.

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

  const lastFields = lines[lines.length - 1].split(',');
  const date       = lastFields[dateIdx]?.trim();
  const price_usd  = parseFloat(lastFields[closeIdx]?.trim());

  if (!date || isNaN(price_usd)) {
    throw new Error(
      `[Step 2] Could not parse Stooq last row: "${lines[lines.length - 1]}"`
    );
  }

  let previous_price_usd = null;
  if (lines.length >= 3) {
    const prevFields = lines[lines.length - 2].split(',');
    const prevClose  = parseFloat(prevFields[closeIdx]?.trim());
    previous_price_usd = isNaN(prevClose) ? null : prevClose;
  }

  console.log(`[Step 2] Stooq: date=${date}, close=${price_usd}`);

  // seriesId is null for Stooq — fetchEIAHistory() is skipped when source !== 'EIA'.
  return { date, price_usd, previous_price_usd, source: 'Stooq', seriesId: null };
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
// Uses whichever seriesId succeeded in fetchEIA() so both calls hit the
// same series.  Only called when source === 'EIA'; skipped on Stooq fallback.
//
// ASSUMPTION: response shape is identical to fetchEIA():
//   { response: { data: [ { period: "YYYY-MM-DD", value: "123.45" }, … ] } }
// `value` is a string — parseFloat() is used on every row.

async function fetchEIAHistory(seriesId) {
  console.log(`[Step 5] Fetching 90-day Brent history from EIA (series=${seriesId})…`);

  const apiKey = process.env.EIA_API_KEY; // already validated in fetchEIA()

  const url =
    'https://api.eia.gov/v2/petroleum/pri/spt/data/' +
    `?api_key=${encodeURIComponent(apiKey)}` +
    '&frequency=daily' +
    '&data[]=value' +
    `&facets[series][]=${seriesId}` +
    '&sort[0][column]=period' +
    '&sort[0][direction]=desc' +
    '&length=90';

  const data = await fetchJSON(url);

  // Log raw response for the same visibility as the spot-price fetch.
  console.log('[EIA Raw] history', JSON.stringify(data).slice(0, 500));

  const rows = data?.response?.data;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      `[Step 5] EIA history returned no data rows for series ${seriesId}. ` +
      `Raw response: ${JSON.stringify(data).slice(0, 300)}`
    );
  }

  // Parse and validate every row before touching the output array so a
  // single bad row fails loudly rather than silently producing a NaN entry.
  const parsed = rows.map((row, i) => {
    const price_usd = parseFloat(row.value);
    if (!row.period || isNaN(price_usd)) {
      throw new Error(
        `[Step 5] EIA history row ${i} has invalid period or value: ` +
        JSON.stringify(row)
      );
    }
    return { date: row.period, price_usd: parseFloat(price_usd.toFixed(2)) };
  });

  // API returns newest-first; reverse so output is oldest-to-newest.
  parsed.reverse();

  console.log(
    `[Step 5] EIA history: ${parsed.length} rows, ` +
    `${parsed[0].date} → ${parsed[parsed.length - 1].date}`
  );

  return parsed;
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

  // ── Steps 1 + 2: Brent crude ─────────────────────────────────────────────────
  // FIX 4: The entire Brent block is wrapped in a single try/catch.
  // If both EIA (all series) and Stooq fail, we do NOT exit with code 1.
  // Instead we mark the existing brent.json as stale and continue — the
  // browser will see the stale flag and show a warning rather than no data.

  let brentRaw  = null;  // stays null only when every source failed
  let brentFailed = false;

  try {
    try {
      brentRaw = await fetchEIA();
    } catch (eiaErr) {
      console.warn(
        `[Step 1] All EIA series failed: ${eiaErr.message}\n` +
        '[Step 1] Activating Stooq fallback…'
      );
      brentRaw = await fetchStooq(); // throws if Stooq also fails
    }
  } catch (allSourcesFailed) {
    brentFailed = true;
    console.error(
      '[Brent] BOTH EIA and Stooq failed. Error:',
      allSourcesFailed.message
    );

    // FIX 4: Write stale flag into existing brent.json if it exists.
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

  // If Brent failed entirely, there is nothing more to compute or write.
  // ECB rate and history both depend on a live Brent value, so we skip them.
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
      change_pct !== null ? parseFloat(change_pct.toFixed(4)) : null,
    eur_usd_rate: parseFloat(eurUsdRate.toFixed(4)),
    source:       brentRaw.source,
    // stale is intentionally absent on a successful fetch
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
  // Only attempted when EIA was the successful source.  If Stooq was used,
  // the existing brent-history.json from the last successful EIA run stays
  // on disk unchanged rather than making a second EIA call that will also fail.
  if (brentRaw.source === 'EIA') {
    let historyRows;
    try {
      historyRows = await fetchEIAHistory(brentRaw.seriesId);
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
