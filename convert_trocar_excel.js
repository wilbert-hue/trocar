/**
 * Convert "Copy of Dataset-North America  US Trocar Market.xlsx" to dashboard JSON files.
 * Generates public/data/value.json, volume.json, and segmentation_analysis.json
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const EXCEL_FILE = 'Copy of Dataset-North America  US Trocar Market.xlsx';
const OUT_DIR = path.join(__dirname, 'public', 'data');

const SEGMENT_TYPES = new Set([
  'By Product Type',
  'By Usability',
  'By Size / Diameter',
  'By Seal Type',
  'By Surgical Approach',
  'By Clinical Specialty',
  'By Material Type',
  'By Price Positioning',
  'By Procurement Mode',
  'By End User',
  'By Country',
  'By Region',
]);

const GEO_HEADERS = new Set(['North America', 'U.S.', 'U.S', 'Canada']);

// U.S. sub-regions appear twice in the pivot: as totals under U.S. > By Region (with data),
// then again as standalone geography blocks (header row with no data).
const US_REGION_HEADERS = new Set([
  'Northeast',
  'Southeast',
  'Midwest',
  'Southwest',
  'West',
]);

function isGeographyBlockHeader(label, yearData) {
  if (yearData) return false;
  return GEO_HEADERS.has(label) || US_REGION_HEADERS.has(label);
}

function resolveGeography(label) {
  if (label === 'U.S' || label === 'U.S.') return 'U.S.';
  return label;
}

function normalizeLabel(label) {
  if (!label) return '';
  let s = String(label).trim();
  // Fix truncated label from Excel pivot export
  if (s === 'Others (Academic & Research Institutes, etc.') {
    s = 'Others (Academic & Research Institutes, etc.)';
  }
  return s;
}

function parseSheetRows(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  let headerRowIdx = -1;
  let yearColumns = [];

  for (let i = 0; i < rows.length; i++) {
    const label = normalizeLabel(rows[i]?.[0]);
    if (label === 'Row Labels') {
      headerRowIdx = i;
      yearColumns = [];
      for (let c = 1; c < rows[i].length; c++) {
        const raw = rows[i][c];
        if (raw == null) continue;
        const year = parseInt(String(raw).trim(), 10);
        if (!isNaN(year) && year >= 2000 && year <= 2100) {
          yearColumns.push({ col: c, year });
        }
      }
      break;
    }
  }

  if (headerRowIdx < 0 || yearColumns.length === 0) {
    throw new Error('Could not find year header row in sheet');
  }

  const parsed = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const label = normalizeLabel(row?.[0]);
    if (!label) continue;

    const yearData = {};
    let hasData = false;
    for (const { col, year } of yearColumns) {
      const val = row[col];
      if (val != null && typeof val === 'number' && !isNaN(val)) {
        yearData[String(year)] = Math.round(val * 10) / 10;
        hasData = true;
      } else {
        yearData[String(year)] = 0;
      }
    }

    parsed.push({ label, yearData: hasData ? yearData : null });
  }

  return parsed;
}

function ensurePath(obj, keys) {
  let cur = obj;
  for (const key of keys) {
    if (!cur[key]) cur[key] = {};
    cur = cur[key];
  }
  return cur;
}

function buildJsonFromRows(rows) {
  const result = {};
  let currentGeo = null;
  let currentSegmentType = null;

  for (const row of rows) {
    const { label, yearData } = row;

    // Geography block headers (no year data) — rows with data are sub-segments (e.g. By Region totals)
    if (isGeographyBlockHeader(label, yearData)) {
      currentGeo = resolveGeography(label);
      currentSegmentType = null;
      ensurePath(result, [currentGeo]);
      continue;
    }

    if (!currentGeo) continue;

    // Segment type row
    if (SEGMENT_TYPES.has(label)) {
      currentSegmentType = label;
      ensurePath(result, [currentGeo, currentSegmentType]);
      // Parent total rows (segment type with year data) are skipped — only leaf sub-segments stored
      continue;
    }

    // Leaf sub-segment with year data
    if (yearData && currentSegmentType) {
      const target = ensurePath(result, [currentGeo, currentSegmentType]);
      target[label] = yearData;
    }
  }

  return result;
}

function buildSegmentationStructure(valueJson) {
  function stripYears(node) {
    if (!node || typeof node !== 'object') return {};
    const result = {};
    for (const [key, val] of Object.entries(node)) {
      if (/^\d{4}$/.test(key)) continue;
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const hasYearData = Object.keys(val).some(k => /^\d{4}$/.test(k));
        result[key] = hasYearData ? {} : stripYears(val);
      }
    }
    return result;
  }

  const structure = {};
  for (const [geo, segTypes] of Object.entries(valueJson)) {
    structure[geo] = stripYears(segTypes);
  }
  return structure;
}

function main() {
  console.log('Reading Excel file:', EXCEL_FILE);
  const wb = XLSX.readFile(EXCEL_FILE);

  for (const sheetName of ['Value', 'Volume']) {
    if (!wb.Sheets[sheetName]) {
      throw new Error(`Missing sheet: ${sheetName}`);
    }
  }

  const valueRows = parseSheetRows(wb.Sheets['Value']);
  const volumeRows = parseSheetRows(wb.Sheets['Volume']);

  console.log(`Parsed ${valueRows.length} value rows, ${volumeRows.length} volume rows`);

  const valueJson = buildJsonFromRows(valueRows);
  const volumeJson = buildJsonFromRows(volumeRows);
  const segmentationJson = buildSegmentationStructure(valueJson);

  // Verify structure
  console.log('\nGeographies:', Object.keys(valueJson));
  console.log('North America segment types:', Object.keys(valueJson['North America'] || {}));
  console.log('U.S. segment types:', Object.keys(valueJson['U.S.'] || {}));
  console.log('U.S. By Region keys:', Object.keys(valueJson['U.S.']?.['By Region'] || {}));
  console.log('Canada By Product Type (2021):', {
    'Bladed Trocars': valueJson['Canada']?.['By Product Type']?.['Bladed Trocars']?.['2021'],
    'Bladeless Trocars': valueJson['Canada']?.['By Product Type']?.['Bladeless Trocars']?.['2021'],
  });
  console.log('Northeast By Product Type (2021):', {
    'Bladed Trocars': valueJson['Northeast']?.['By Product Type']?.['Bladed Trocars']?.['2021'],
  });

  fs.writeFileSync(path.join(OUT_DIR, 'value.json'), JSON.stringify(valueJson, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'volume.json'), JSON.stringify(volumeJson, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'segmentation_analysis.json'), JSON.stringify(segmentationJson, null, 2));

  console.log('\nWrote value.json, volume.json, segmentation_analysis.json');
}

main();
