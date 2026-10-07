'use strict';

// Global food database module: normalization, the Open Food Facts and USDA
// FoodData Central clients, and the dedup/merge pass that turns raw rows from
// several sources into one ranked list.
//
// It is deliberately kept out of server.js the way calculations.js is: the
// search pipeline is the most intricate part of phase 2 and it should be
// testable and readable on its own.
//
// Nothing in here ever invents food data. A source that fails throws; the
// caller turns that into a notice or an error, never a mock row.

// Live calls are bounded so a slow upstream can never hold a request open.
const FETCH_TIMEOUT_MS = 8000;

// Open Food Facts asks for an identifiable User-Agent so they can reach the
// operator of a misbehaving client instead of blocking a shared IP.
const OFF_USER_AGENT = 'MyFitness-Homeroom/1.0 (https://app.onhomeroom.com)';

const OFF_SEARCH_FIELDS = [
  'code',
  'product_name',
  'brands',
  'serving_quantity',
  'serving_size',
  'nutriments',
].join(',');

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round1(value) {
  if (value === null || value === undefined) return null;
  return Math.round(value * 10) / 10;
}

// Lowercased, whitespace-collapsed text used for dedup grouping. Brand and
// name are normalized separately because a generic food and a branded one
// with the same name are not the same entry.
function normText(value) {
  if (typeof value !== 'string') return '';
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Per-100 g nutrition is the canonical form every candidate carries, so rows
// from either source can be compared and merged without unit surprises.
function per100(fat, protein, carbs, calories) {
  return {
    calories_per_100g: calories,
    protein_per_100g: protein,
    carbs_per_100g: carbs,
    fat_per_100g: fat,
  };
}

// Open Food Facts gives nutriments keyed per 100 g (suffixed `_100g`), with
// energy in both kJ (`energy_100g`) and kcal (`energy-kcal_100g`). Prefer the
// explicit kcal field; convert kJ only when that is all there is.
function normalizeOffProduct(product) {
  if (!product || typeof product !== 'object') return null;
  const name = typeof product.product_name === 'string' ? product.product_name.trim() : '';
  if (!name) return null;
  const code = product.code != null ? String(product.code).trim() : '';
  if (!code) return null;

  const n = product.nutriments || {};
  let calories = num(n['energy-kcal_100g']);
  if (calories === null) {
    const kj = num(n.energy_100g);
    if (kj !== null) calories = kj / 4.184;
  }

  let servingG = num(product.serving_quantity);
  if (servingG === null || servingG <= 0) servingG = 100;
  let servingLabel = null;
  if (typeof product.serving_size === 'string' && product.serving_size.trim()) {
    servingLabel = product.serving_size.trim();
  } else {
    servingLabel = servingG + ' g';
  }

  const brand = typeof product.brands === 'string' ? product.brands.split(',')[0].trim() : '';

  return Object.assign(
    {
      source: 'off',
      source_id: code,
      barcode: code,
      name,
      brand: brand || null,
      serving_g: servingG,
      serving_label: servingLabel,
      norm_name: normText(name),
      norm_brand: normText(brand),
      fetched_at: new Date(),
    },
    per100(
      num(n.fat_100g),
      num(n.proteins_100g),
      num(n.carbohydrates_100g),
      calories === null ? null : calories
    )
  );
}

// USDA FoodData Central returns nutrients per 100 g for every data type. The
// values are matched by nutrientId, which is the stable identifier (names get
// revised).
const USDA_ENERGY_ID = 1008;   // Energy, kcal
const USDA_ENERGY_KJ_ID = 1062; // Energy, kJ (fallback)
const USDA_PROTEIN_ID = 1003;
const USDA_CARBS_ID = 1005;
const USDA_FAT_ID = 1004;

function usdaNutrient(food, id) {
  const list = Array.isArray(food.foodNutrients) ? food.foodNutrients : [];
  for (const item of list) {
    if (item && item.nutrientId === id) {
      const v = num(item.value);
      if (v !== null) return v;
    }
  }
  return null;
}

function normalizeUsdaFood(food) {
  if (!food || typeof food !== 'object') return null;
  const description = typeof food.description === 'string' ? food.description.trim() : '';
  if (!description || food.fdcId == null) return null;

  let calories = usdaNutrient(food, USDA_ENERGY_ID);
  if (calories === null) {
    const kj = usdaNutrient(food, USDA_ENERGY_KJ_ID);
    if (kj !== null) calories = kj / 4.184;
  }

  // Branded foods carry a gram serving; foundation and survey foods do not,
  // so they stay on the 100 g basis.
  const branded = !!food.brandName || !!food.brandOwner || !!food.gtinUpc;
  let servingG = null;
  let servingLabel = null;
  if (branded && num(food.servingSize) !== null && String(food.servingSizeUnit || 'g').toLowerCase() === 'g') {
    servingG = num(food.servingSize);
    servingLabel = (typeof food.householdServingFullText === 'string' && food.householdServingFullText.trim())
      ? food.householdServingFullText.trim()
      : servingG + ' g';
  } else {
    servingG = 100;
    servingLabel = '100 g';
  }

  const brand = (food.brandName || food.brandOwner || '').toString().trim();
  const barcode = food.gtinUpc != null && String(food.gtinUpc).trim() ? String(food.gtinUpc).trim() : null;

  return Object.assign(
    {
      source: 'usda',
      source_id: String(food.fdcId),
      barcode,
      name: description,
      brand: brand || null,
      serving_g: servingG,
      serving_label: servingLabel,
      norm_name: normText(description),
      norm_brand: normText(brand),
      fetched_at: new Date(),
    },
    per100(
      usdaNutrient(food, USDA_FAT_ID),
      usdaNutrient(food, USDA_PROTEIN_ID),
      usdaNutrient(food, USDA_CARBS_ID),
      calories
    )
  );
}

async function fetchJson(url, headers) {
  const res = await fetch(url, {
    headers: Object.assign({ accept: 'application/json' }, headers || {}),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error('Upstream responded ' + res.status);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Live Open Food Facts text search (keyless). Returns normalized per-100 g
// candidates. Throws when the source cannot be reached.
async function searchOpenFoodFacts(query) {
  const url = 'https://world.openfoodfacts.org/api/v2/search'
    + '?search_terms=' + encodeURIComponent(query)
    + '&page_size=20'
    + '&fields=' + encodeURIComponent(OFF_SEARCH_FIELDS);
  const data = await fetchJson(url, { 'User-Agent': OFF_USER_AGENT });
  const products = data && Array.isArray(data.products) ? data.products : [];
  const out = [];
  for (const p of products) {
    const c = normalizeOffProduct(p);
    if (c) out.push(c);
  }
  return out;
}

// Live USDA FoodData Central search. Only called when a key is configured —
// with no key there is nothing to authenticate and the layer is skipped
// entirely rather than guessed at.
async function searchUsda(query, apiKey) {
  if (!apiKey) throw new Error('No USDA FoodData Central API key is set');
  const url = 'https://api.nal.usda.gov/fdc/v1/foods/search'
    + '?api_key=' + encodeURIComponent(apiKey)
    + '&query=' + encodeURIComponent(query)
    + '&pageSize=10';
  const data = await fetchJson(url);
  const foods = data && Array.isArray(data.foods) ? data.foods : [];
  const out = [];
  for (const f of foods) {
    const c = normalizeUsdaFood(f);
    if (c) out.push(c);
  }
  return out;
}

// One candidate group is one logical food. Rank the members and keep the
// strongest as the survivor. Branded/packaged foods prefer Open Food Facts
// (it carries barcodes and serving sizes); generic foods prefer USDA. Then
// "has real serving data" wins, then the freshest cache row.
function candidateScore(c) {
  let score = 0;
  const branded = !!(c.brand && c.brand.trim()) || !!c.barcode;
  if (branded) score += c.source === 'off' ? 20 : 10;
  else score += c.source === 'usda' ? 20 : 10;
  if (c.serving_g !== null && c.serving_g !== undefined) score += 2;
  return score;
}

function freshest(c) {
  if (!c.fetched_at) return 0;
  const t = new Date(c.fetched_at).getTime();
  return Number.isFinite(t) ? t : 0;
}

function pickSurvivor(group) {
  let best = group[0];
  for (let i = 1; i < group.length; i += 1) {
    const c = group[i];
    const a = candidateScore(c);
    const b = candidateScore(best);
    if (a > b || (a === b && freshest(c) > freshest(best))) best = c;
  }
  return best;
}

// Group candidates into logical foods: first by barcode, then by
// normalized name + brand. The survivor is what the UI shows, and the merge
// happens here at assembly time — never in storage, so no source's raw row is
// destroyed.
function mergeFoodResults(candidates) {
  const groups = [];
  const byBarcode = new Map();
  const byName = new Map();

  for (const c of candidates) {
    if (!c) continue;
    let group = null;
    if (c.barcode) {
      const hit = byBarcode.get(c.barcode);
      if (hit) group = hit;
    }
    const nameKey = c.norm_name ? c.norm_name + '\u0000' + (c.norm_brand || '') : null;
    if (!group && nameKey) {
      const hit = byName.get(nameKey);
      if (hit) group = hit;
    }
    if (!group) {
      group = [];
      groups.push(group);
    }
    group.push(c);
    if (c.barcode) byBarcode.set(c.barcode, group);
    if (nameKey) byName.set(nameKey, group);
  }

  return groups.map(pickSurvivor).filter(Boolean);
}

// A stable key the client uses to log or favorite a database food.
function foodKey(source, sourceId) {
  return source + ':' + sourceId;
}

// Stable key for a user-created food.
function customFoodKey(id) {
  return 'custom:' + id;
}

// Open Food Facts product lookup by barcode (the v2 read endpoint). Returns
// one normalized candidate or null when the barcode is unknown. Throws when
// the source cannot be reached.
async function lookupBarcode(code) {
  const url = 'https://world.openfoodfacts.org/api/v2/product/'
    + encodeURIComponent(code)
    + '.json?fields=' + encodeURIComponent(OFF_SEARCH_FIELDS);
  const data = await fetchJson(url, { 'User-Agent': OFF_USER_AGENT });
  if (!data || data.status === 0 || !data.product) return null;
  return normalizeOffProduct(data.product);
}

module.exports = {
  FETCH_TIMEOUT_MS,
  num,
  round1,
  normText,
  normalizeOffProduct,
  normalizeUsdaFood,
  searchOpenFoodFacts,
  searchUsda,
  lookupBarcode,
  mergeFoodResults,
  foodKey,
  customFoodKey,
};
