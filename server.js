const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const {
  computeTargets,
  validateProfilePayload,
} = require('./calculations');
const foodData = require('./foods');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Staging gets request-time demo data so every screen can be previewed and
// screenshotted. Data and preview state only — never a feature, a screen, or
// a code path (see the platform's USERNODE_ENV rule).
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// USDA FoodData Central needs a free API key. It is optional: with no key the
// USDA layer is simply skipped and search degrades to Open Food Facts plus
// the cache — the same path production takes before the key is set. The
// absence must never be an error.
const USDA_FDC_API_KEY = process.env.USDA_FDC_API_KEY || '';

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ---------------------------------------------------------------------------
// My Fitness data. The personal tables hold health data, so each is marked
// `staging:private`: staging copies their schema but never their rows. The
// shared `foods` cache is public third-party data with no personal content.
// ---------------------------------------------------------------------------

// Local calendar date (YYYY-MM-DD) a log belongs to. Server-local time is
// acceptable for phase 1; revisit when per-user timezones matter.
function todayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function isDateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(new Date(value + 'T00:00:00Z').getTime());
}

// ISO-date arithmetic with no timezone drift: a plain YYYY-MM-DD string has
// no time component, so shifting it in UTC can never roll a day over.
function addDays(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// History never reaches into the future; anything later than today (or
// anything unparseable) is clamped back to today.
function clampDateToPast(value) {
  const today = todayKey();
  if (!isDateString(value)) return today;
  return value > today ? today : value;
}

const MAX_GLASSES = 20;
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
const SOURCE_LABELS = { off: 'Open Food Facts', usda: 'USDA FoodData Central', custom: 'My food' };

// pg hands DATE columns back as Date objects pinned to midnight UTC. The app
// wants the plain YYYY-MM-DD the column stores: it is what the dashboard
// displays, what the wizard's date input is prefilled with, and what the
// days-remaining math parses. Normalized once, where the row is read.
function dateKey(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

function nz(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function loadProfileAndGoal(userId) {
  const { rows } = await pool.query(
    `SELECT user_id, username, name, age, gender, height_cm, weight_kg,
            activity_level, email, created_at, updated_at
       FROM profiles WHERE user_id = $1`,
    [userId]
  );
  const profile = rows[0];
  if (!profile) return null;
  const { rows: goalRows } = await pool.query(
    `SELECT user_id, goal_type, target_weight_kg, target_date, created_at, updated_at
       FROM goals WHERE user_id = $1`,
    [userId]
  );
  const goal = goalRows[0] || null;
  if (goal) goal.target_date = dateKey(goal.target_date);
  return { profile, goal };
}

// GET /api/profile — who the user is, whether onboarding is done, and the
// computed plan. `?demo=1` (staging only) answers with a read-only fake
// profile so the dashboard is previewable without writing anything.
app.get('/api/profile', async (req, res) => {
  if (isDemoRequest(req)) return res.json(demoProfileResponse());
  try {
    const loaded = await loadProfileAndGoal(req.user.id);
    if (!loaded || !loaded.goal) return res.json({ onboarded: false });
    const targets = computeTargets(loaded.profile, loaded.goal);
    res.json({ onboarded: true, ...loaded, targets });
  } catch (err) {
    console.error('GET /api/profile failed: ' + err.message);
    res.status(500).json({ error: 'Could not load your profile. Please try again.' });
  }
});

// POST /api/profile — create or update the profile and goal, then return the
// recomputed plan. Server-side validation is the authority; the wizard
// mirrors it so mistakes are caught before submit.
app.post('/api/profile', async (req, res) => {
  if (isDemoRequest(req)) return res.status(403).json({ error: 'Demo data is read-only' });
  const result = validateProfilePayload(req.body || {});
  if (result.errors) {
    return res.status(400).json({
      error: 'Please check the highlighted fields',
      errors: result.errors,
    });
  }
  const v = result.value;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const profileRows = await client.query(
      `INSERT INTO profiles
         (user_id, username, name, age, gender, height_cm, weight_kg,
          activity_level, email, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         username = EXCLUDED.username,
         name = EXCLUDED.name,
         age = EXCLUDED.age,
         gender = EXCLUDED.gender,
         height_cm = EXCLUDED.height_cm,
         weight_kg = EXCLUDED.weight_kg,
         activity_level = EXCLUDED.activity_level,
         email = EXCLUDED.email,
         updated_at = NOW()
       RETURNING user_id, username, name, age, gender, height_cm, weight_kg,
                 activity_level, email, created_at, updated_at`,
      [req.user.id, req.user.username || '', v.name, v.age, v.gender,
       v.height_cm, v.weight_kg, v.activity_level, v.email]
    );
    const goalRows = await client.query(
      `INSERT INTO goals (user_id, goal_type, target_weight_kg, target_date, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         goal_type = EXCLUDED.goal_type,
         target_weight_kg = EXCLUDED.target_weight_kg,
         target_date = EXCLUDED.target_date,
         updated_at = NOW()
       RETURNING user_id, goal_type, target_weight_kg, target_date, created_at, updated_at`,
      [req.user.id, v.goal_type, v.target_weight_kg, v.target_date]
    );
    await client.query('COMMIT');
    const profile = profileRows.rows[0];
    const goal = goalRows.rows[0];
    goal.target_date = dateKey(goal.target_date);
    const targets = computeTargets(profile, goal);
    res.json({ onboarded: true, profile, goal, targets });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('POST /api/profile failed: ' + err.message);
    res.status(500).json({ error: 'Could not save your plan. Please try again.' });
  } finally {
    client.release();
  }
});

// Shapes the dashboard payload. Both the real database path and the staging
// demo path go through this, so the demo exercises the same code the app
// ships (same shaping, same response shape, different data). `date` defaults
// to today and lets the history endpoint reuse the exact same shaping.
function buildDashboard(profile, goal, mealRows, glasses, date) {
  const targets = computeTargets(profile, goal);
  const groups = { breakfast: [], lunch: [], dinner: [], snack: [] };
  const totals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  for (const row of mealRows) {
    if (!groups[row.meal_type]) continue;
    groups[row.meal_type].push(row);
    totals.calories += Number(row.calories);
    totals.protein_g += Number(row.protein_g);
    totals.carbs_g += Number(row.carbs_g);
    totals.fat_g += Number(row.fat_g);
  }
  for (const key of Object.keys(totals)) totals[key] = Math.round(totals[key] * 10) / 10;

  const day = date || todayKey();
  let daysToTarget = null;
  if (goal.target_date) {
    const target = new Date(goal.target_date + 'T00:00:00');
    const today = new Date(todayKey() + 'T00:00:00');
    daysToTarget = Math.max(0, Math.round((target - today) / 86400000));
  }

  return {
    date: day,
    profile,
    goal,
    targets,
    meals: { groups, totals, count: mealRows.length },
    water: {
      glasses,
      targetMl: targets.waterTargetMl,
      glassMl: targets.glassMl,
      ml: glasses * targets.glassMl,
    },
    daysToTarget,
  };
}

// GET /api/dashboard — today's calories, meals and water for the signed-in
// user. 409 (not 404) when there is no profile yet: the frontend switches
// to the onboarding wizard rather than showing an error.
app.get('/api/dashboard', async (req, res) => {
  if (isDemoRequest(req)) {
    const demo = demoData();
    return res.json({ demo: true, ...buildDashboard(demo.profile, demo.goal, demo.meals, 4) });
  }
  try {
    const loaded = await loadProfileAndGoal(req.user.id);
    if (!loaded || !loaded.goal) {
      return res.status(409).json({ error: 'Finish setting up your plan first' });
    }
    const day = todayKey();
    const { rows: mealRows } = await pool.query(
      `SELECT id, meal_type, name, calories, protein_g, carbs_g, fat_g, log_date, logged_at
         FROM meal_logs WHERE user_id = $1 AND log_date = $2
        ORDER BY logged_at`,
      [req.user.id, day]
    );
    const { rows: waterRows } = await pool.query(
      `SELECT glasses FROM water_logs WHERE user_id = $1 AND log_date = $2`,
      [req.user.id, day]
    );
    const glasses = waterRows[0] ? waterRows[0].glasses : 0;
    res.json(buildDashboard(loaded.profile, loaded.goal, mealRows, glasses));
  } catch (err) {
    console.error('GET /api/dashboard failed: ' + err.message);
    res.status(500).json({ error: 'Could not load today’s data. Please try again.' });
  }
});

// POST /api/water — log one more (or one fewer) 250 ml glass today. The
// count is clamped server-side to 0..20; the client mirrors the same clamp.
app.post('/api/water', async (req, res) => {
  const delta = req.body && req.body.delta;
  if (delta !== 1 && delta !== -1) {
    return res.status(400).json({ error: 'delta must be 1 or -1' });
  }
  if (isDemoRequest(req)) {
    // Read-only demo: answer the same shape without writing anything.
    const demo = demoData();
    const targets = computeTargets(demo.profile, demo.goal);
    const glasses = Math.min(MAX_GLASSES, Math.max(0, 4 + delta));
    return res.json({
      demo: true,
      glasses,
      targetMl: targets.waterTargetMl,
      glassMl: targets.glassMl,
      ml: glasses * targets.glassMl,
    });
  }
  try {
    const loaded = await loadProfileAndGoal(req.user.id);
    if (!loaded || !loaded.goal) {
      return res.status(409).json({ error: 'Finish setting up your plan first' });
    }
    const day = todayKey();
    const { rows } = await pool.query(
      `INSERT INTO water_logs (user_id, log_date, glasses)
       VALUES ($1, $2, LEAST(GREATEST($3::int, 0), $4::int))
       ON CONFLICT (user_id, log_date) DO UPDATE SET
         glasses = LEAST(GREATEST(water_logs.glasses + $3::int, 0), $4::int),
         updated_at = NOW()
       RETURNING glasses`,
      [req.user.id, day, delta, MAX_GLASSES]
    );
    const glasses = rows[0].glasses;
    const targets = computeTargets(loaded.profile, loaded.goal);
    res.json({ glasses, targetMl: targets.waterTargetMl, glassMl: targets.glassMl, ml: glasses * targets.glassMl });
  } catch (err) {
    console.error('POST /api/water failed: ' + err.message);
    res.status(500).json({ error: 'Could not save your water log. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Food database: search, barcode, detail, custom foods, favorites, meals.
// ---------------------------------------------------------------------------

// Turn a `foods` cache row into the payload the UI renders. Nutrition is
// stored per 100 g and served per the food's own serving, so the number the
// user sees matches the label they picked.
function foodPayloadFromRow(row, favs, opts) {
  const servingG = row.serving_g != null ? nz(row.serving_g) : 100;
  const factor = servingG / 100;
  const favoriteId = favs.byFood.get(row.id) || null;
  return {
    key: foodData.foodKey(row.source, row.source_id),
    source: row.source,
    source_label: SOURCE_LABELS[row.source] || row.source,
    source_id: String(row.source_id),
    food_id: row.id,
    barcode: row.barcode || null,
    name: row.name,
    brand: row.brand || null,
    serving_g: servingG,
    serving_label: row.serving_label || servingG + ' g',
    calories: foodData.round1(nz(row.calories) * factor),
    protein_g: foodData.round1(nz(row.protein_g) * factor),
    carbs_g: foodData.round1(nz(row.carbs_g) * factor),
    fat_g: foodData.round1(nz(row.fat_g) * factor),
    custom: false,
    favorite: favoriteId != null,
    favorite_id: favoriteId,
    recent: !!(opts && opts.recent),
  };
}

// Custom foods store nutrition per serving, so no scaling is needed here.
function customFoodPayload(row, favs, opts) {
  const favoriteId = favs.byCustom.get(row.id) || null;
  return {
    key: foodData.customFoodKey(row.id),
    source: 'custom',
    source_label: SOURCE_LABELS.custom,
    source_id: String(row.id),
    custom_food_id: row.id,
    barcode: null,
    name: row.name,
    brand: null,
    serving_g: nz(row.serving_g),
    serving_label: row.serving_label || nz(row.serving_g) + ' g',
    calories: foodData.round1(nz(row.calories)),
    protein_g: foodData.round1(nz(row.protein_g)),
    carbs_g: foodData.round1(nz(row.carbs_g)),
    fat_g: foodData.round1(nz(row.fat_g)),
    custom: true,
    favorite: favoriteId != null,
    favorite_id: favoriteId,
    recent: !!(opts && opts.recent),
  };
}

async function loadFavorites(userId) {
  const { rows } = await pool.query(
    'SELECT id, food_id, custom_food_id FROM food_favorites WHERE user_id = $1',
    [userId]
  );
  const byFood = new Map();
  const byCustom = new Map();
  for (const r of rows) {
    if (r.food_id != null) byFood.set(r.food_id, r.id);
    if (r.custom_food_id != null) byCustom.set(r.custom_food_id, r.id);
  }
  return { byFood, byCustom };
}

async function upsertCandidate(c) {
  const { rows } = await pool.query(
    `INSERT INTO foods
       (source, source_id, barcode, name, brand, calories, protein_g, carbs_g,
        fat_g, serving_g, serving_label, norm_name, norm_brand, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (source, source_id) DO UPDATE SET
       barcode = EXCLUDED.barcode,
       name = EXCLUDED.name,
       brand = EXCLUDED.brand,
       calories = EXCLUDED.calories,
       protein_g = EXCLUDED.protein_g,
       carbs_g = EXCLUDED.carbs_g,
       fat_g = EXCLUDED.fat_g,
       serving_g = EXCLUDED.serving_g,
       serving_label = EXCLUDED.serving_label,
       norm_name = EXCLUDED.norm_name,
       norm_brand = EXCLUDED.norm_brand,
       fetched_at = EXCLUDED.fetched_at
     RETURNING *`,
    [
      c.source, c.source_id, c.barcode || null, c.name, c.brand || null,
      c.calories_per_100g, c.protein_per_100g, c.carbs_per_100g, c.fat_per_100g,
      c.serving_g, c.serving_label, c.norm_name, c.norm_brand, c.fetched_at || new Date(),
    ]
  );
  return rows[0];
}

function sourceNotice(source) {
  return {
    source,
    label: SOURCE_LABELS[source],
    message: SOURCE_LABELS[source] + ' is unavailable right now.',
  };
}

// The search assembly pipeline: custom foods, then favorites and recents,
// then the shared cache, then live OFF and USDA. Live failures become a
// notice; when every live source fails and nothing else answers, the caller
// turns that into the retryable error. No step ever fabricates food data.
async function assembleSearch(userId, rawQuery) {
  const q = (rawQuery || '').trim();
  const notices = [];
  const favs = await loadFavorites(userId);

  const results = [];
  const seenFoodIds = new Set();
  const seenCustomIds = new Set();
  const sections = { recent: [], favorites: [], custom: [] };

  function pushDbFood(row, opts) {
    if (seenFoodIds.has(row.id)) return null;
    seenFoodIds.add(row.id);
    const payload = foodPayloadFromRow(row, favs, opts);
    results.push(payload);
    return payload;
  }
  function pushCustomFood(row, opts) {
    if (seenCustomIds.has(row.id)) return null;
    seenCustomIds.add(row.id);
    const payload = customFoodPayload(row, favs, opts);
    results.push(payload);
    return payload;
  }

  // 1. Custom foods matching q (exact user data, always freshest).
  const { rows: customMatches } = await pool.query(
    `SELECT * FROM custom_foods
      WHERE user_id = $1 AND ($2 = '' OR position(lower($2) in lower(name)) > 0)
      ORDER BY updated_at DESC LIMIT 20`,
    [userId, q]
  );
  for (const row of customMatches) {
    const p = pushCustomFood(row, null);
    if (p) sections.custom.push(p.key);
  }

  // 2a. Favorites matching q.
  const { rows: favFoodRows } = await pool.query(
    `SELECT f.* FROM foods f
       JOIN food_favorites fav ON fav.food_id = f.id
      WHERE fav.user_id = $1 AND ($2 = '' OR position(lower($2) in f.norm_name) > 0)
      ORDER BY fav.created_at DESC LIMIT 20`,
    [userId, q]
  );
  for (const row of favFoodRows) {
    const p = pushDbFood(row, null);
    if (p) sections.favorites.push(p.key);
  }
  const { rows: favCustomRows } = await pool.query(
    `SELECT cf.* FROM custom_foods cf
       JOIN food_favorites fav ON fav.custom_food_id = cf.id
      WHERE fav.user_id = $1 AND ($2 = '' OR position(lower($2) in lower(cf.name)) > 0)
      ORDER BY fav.created_at DESC LIMIT 20`,
    [userId, q]
  );
  for (const row of favCustomRows) {
    const p = pushCustomFood(row, null);
    if (p) sections.favorites.push(p.key);
  }

  // 2b. Recents derived from meal logs (manual rows with no food ref are
  // excluded, so only real database/custom foods appear here).
  const { rows: recentFoodRows } = await pool.query(
    `SELECT f.* FROM foods f
       JOIN (
         SELECT food_id, MAX(logged_at) AS last
           FROM meal_logs WHERE user_id = $1 AND food_id IS NOT NULL
          GROUP BY food_id
       ) m ON m.food_id = f.id
      WHERE ($2 = '' OR position(lower($2) in f.norm_name) > 0)
      ORDER BY m.last DESC LIMIT 20`,
    [userId, q]
  );
  for (const row of recentFoodRows) {
    const p = pushDbFood(row, { recent: true });
    if (p) sections.recent.push(p.key);
  }
  const { rows: recentCustomRows } = await pool.query(
    `SELECT cf.* FROM custom_foods cf
       JOIN (
         SELECT custom_food_id, MAX(logged_at) AS last
           FROM meal_logs WHERE user_id = $1 AND custom_food_id IS NOT NULL
          GROUP BY custom_food_id
       ) m ON m.custom_food_id = cf.id
      WHERE ($2 = '' OR position(lower($2) in lower(cf.name)) > 0)
      ORDER BY m.last DESC LIMIT 20`,
    [userId, q]
  );
  for (const row of recentCustomRows) {
    const p = pushCustomFood(row, { recent: true });
    if (p) sections.recent.push(p.key);
  }

  // 3 + 4 + 5. Cache and live sources, merged and deduplicated. Skipped
  // entirely when there is no query: the empty-query screen is "what you
  // reach for most", not a browse-everything list.
  if (q) {
    const { rows: cacheRows } = await pool.query(
      `SELECT * FROM foods WHERE position(lower($1) in norm_name) > 0
        ORDER BY fetched_at DESC NULLS LAST LIMIT 40`,
      [q]
    );

    const live = [];
    let attempted = 0;
    let failed = 0;

    attempted += 1;
    try {
      const off = await foodData.searchOpenFoodFacts(q);
      for (const c of off) live.push(c);
    } catch (err) {
      failed += 1;
      console.warn('Open Food Facts search failed: ' + err.message);
      notices.push(sourceNotice('off'));
    }

    if (USDA_FDC_API_KEY) {
      attempted += 1;
      try {
        const usda = await foodData.searchUsda(q, USDA_FDC_API_KEY);
        for (const c of usda) live.push(c);
      } catch (err) {
        failed += 1;
        console.warn('USDA search failed: ' + err.message);
        notices.push(sourceNotice('usda'));
      }
    }

    const merged = foodData.mergeFoodResults(live);
    const liveRows = [];
    for (const c of merged) {
      try {
        liveRows.push(await upsertCandidate(c));
      } catch (err) {
        console.warn('food cache upsert failed: ' + err.message);
      }
    }

    // Dedup the cache against the just-cached live rows by barcode, then by
    // normalized name + brand. The freshest cache row wins.
    const layerRows = [];
    const seenBarcode = new Set();
    const seenName = new Set();
    for (const row of cacheRows.concat(liveRows)) {
      const nk = (row.norm_name || '') + '\u0000' + (row.norm_brand || '');
      if (row.barcode && seenBarcode.has(row.barcode)) continue;
      if (seenName.has(nk)) continue;
      if (row.barcode) seenBarcode.add(row.barcode);
      seenName.add(nk);
      layerRows.push(row);
    }
    for (const row of layerRows) pushDbFood(row, null);

    // Every live source failed and nothing (cache or user data) answered:
    // that is the honest "search is down" case, not an empty result list.
    if (attempted > 0 && failed === attempted && results.length === 0) {
      const err = new Error('All food sources are unavailable');
      err.searchUnavailable = true;
      throw err;
    }
  }

  return { q, results: results.slice(0, 20), sections, notices };
}

app.get('/api/foods/search', async (req, res) => {
  if (isDemoRequest(req)) return res.json(demoSearchResponse(req.query.q || ''));
  const raw = req.query.q;
  const q = typeof raw === 'string' ? raw.slice(0, 120) : '';
  try {
    const payload = await assembleSearch(req.user.id, q);
    res.json(payload);
  } catch (err) {
    console.error('GET /api/foods/search failed: ' + err.message);
    res.status(502).json({ error: 'Food search is unavailable right now. Please try again.' });
  }
});

// Find a cached food row by its stable key (`<source>:<source_id>`).
async function findFoodByKey(key) {
  if (typeof key !== 'string') return null;
  const idx = key.indexOf(':');
  if (idx < 0) return null;
  const source = key.slice(0, idx);
  const sourceId = key.slice(idx + 1);
  if (!['off', 'usda'].includes(source) || !sourceId) return null;
  const { rows } = await pool.query(
    'SELECT * FROM foods WHERE source = $1 AND source_id = $2',
    [source, sourceId]
  );
  return rows[0] || null;
}

app.get('/api/foods/barcode/:code', async (req, res) => {
  if (isDemoRequest(req)) return demoBarcodeResponse(req, res);
  const code = String(req.params.code || '').trim();
  if (!/^\d{8,14}$/.test(code)) {
    return res.status(400).json({ error: 'Enter a valid barcode (8 to 14 digits)' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT * FROM foods WHERE barcode = $1 ORDER BY fetched_at DESC NULLS LAST LIMIT 1',
      [code]
    );
    if (rows[0]) {
      const favs = await loadFavorites(req.user.id);
      return res.json({ food: foodPayloadFromRow(rows[0], favs, null) });
    }
    let candidate = null;
    try {
      candidate = await foodData.lookupBarcode(code);
    } catch (err) {
      console.warn('barcode lookup failed: ' + err.message);
      return res.status(502).json({ error: 'Barcode lookup is unavailable right now. Please try again.' });
    }
    if (!candidate) {
      return res.status(404).json({ error: 'No food found for that barcode' });
    }
    const row = await upsertCandidate(candidate);
    const favs = await loadFavorites(req.user.id);
    res.json({ food: foodPayloadFromRow(row, favs, null) });
  } catch (err) {
    console.error('GET /api/foods/barcode failed: ' + err.message);
    res.status(502).json({ error: 'Barcode lookup is unavailable right now. Please try again.' });
  }
});

app.get('/api/foods/:source/:sourceId', async (req, res) => {
  if (isDemoRequest(req)) {
    const match = demoAllPayloads().find((f) => f.key === req.params.source + ':' + req.params.sourceId);
    if (!match) return res.status(404).json({ error: 'Food not found' });
    return res.json({ food: match });
  }
  const { source, sourceId } = req.params;
  if (!['off', 'usda'].includes(source) || !sourceId) {
    return res.status(404).json({ error: 'Food not found' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT * FROM foods WHERE source = $1 AND source_id = $2',
      [source, sourceId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Food not found' });
    const favs = await loadFavorites(req.user.id);
    res.json({ food: foodPayloadFromRow(rows[0], favs, null) });
  } catch (err) {
    console.error('GET /api/foods detail failed: ' + err.message);
    res.status(502).json({ error: 'That food is unavailable right now. Please try again.' });
  }
});

// --- Custom foods ---------------------------------------------------------

function validateCustomFood(body) {
  const errors = {};
  const value = {};

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) errors.name = 'Enter a name';
  else if (name.length > 120) errors.name = 'Name must be 120 characters or fewer';
  else value.name = name;

  const servingG = Number(body.serving_g);
  if (!Number.isFinite(servingG) || servingG < 1 || servingG > 500) {
    errors.serving_g = 'Enter a serving size between 1 and 500 g';
  } else value.serving_g = servingG;

  value.serving_label = typeof body.serving_label === 'string' && body.serving_label.trim()
    ? body.serving_label.trim().slice(0, 60) : null;

  const macros = [
    ['calories', 'calories'],
    ['protein_g', 'protein'],
    ['carbs_g', 'carbs'],
    ['fat_g', 'fat'],
  ];
  for (const [field, label] of macros) {
    const n = Number(body[field]);
    if (!Number.isFinite(n) || n < 0 || n > 5000) {
      errors[field] = 'Enter ' + label + ' between 0 and 5000';
    } else value[field] = n;
  }

  if (Object.keys(errors).length) return { errors };
  return { value };
}

app.get('/api/custom-foods', async (req, res) => {
  if (isDemoRequest(req)) return res.json({ foods: demoCustomPayloads() });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM custom_foods WHERE user_id = $1 ORDER BY updated_at DESC',
      [req.user.id]
    );
    const favs = await loadFavorites(req.user.id);
    res.json({ foods: rows.map((r) => customFoodPayload(r, favs, null)) });
  } catch (err) {
    console.error('GET /api/custom-foods failed: ' + err.message);
    res.status(500).json({ error: 'Could not load your foods. Please try again.' });
  }
});

app.post('/api/custom-foods', async (req, res) => {
  if (isDemoRequest(req)) return res.status(403).json({ error: 'Demo data is read-only' });
  const result = validateCustomFood(req.body || {});
  if (result.errors) {
    return res.status(400).json({ error: 'Please check the highlighted fields', errors: result.errors });
  }
  const v = result.value;
  try {
    const { rows } = await pool.query(
      `INSERT INTO custom_foods
         (user_id, name, serving_g, serving_label, calories, protein_g, carbs_g, fat_g, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW())
       RETURNING *`,
      [req.user.id, v.name, v.serving_g, v.serving_label, v.calories, v.protein_g, v.carbs_g, v.fat_g]
    );
    const favs = await loadFavorites(req.user.id);
    res.status(201).json({ food: customFoodPayload(rows[0], favs, null) });
  } catch (err) {
    console.error('POST /api/custom-foods failed: ' + err.message);
    res.status(500).json({ error: 'Could not save your food. Please try again.' });
  }
});

app.put('/api/custom-foods/:id', async (req, res) => {
  if (isDemoRequest(req)) return res.status(403).json({ error: 'Demo data is read-only' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Food not found' });
  const result = validateCustomFood(req.body || {});
  if (result.errors) {
    return res.status(400).json({ error: 'Please check the highlighted fields', errors: result.errors });
  }
  const v = result.value;
  try {
    const { rows } = await pool.query(
      `UPDATE custom_foods SET
         name = $3, serving_g = $4, serving_label = $5, calories = $6,
         protein_g = $7, carbs_g = $8, fat_g = $9, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, req.user.id, v.name, v.serving_g, v.serving_label, v.calories, v.protein_g, v.carbs_g, v.fat_g]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Food not found' });
    const favs = await loadFavorites(req.user.id);
    res.json({ food: customFoodPayload(rows[0], favs, null) });
  } catch (err) {
    console.error('PUT /api/custom-foods failed: ' + err.message);
    res.status(500).json({ error: 'Could not save your food. Please try again.' });
  }
});

app.delete('/api/custom-foods/:id', async (req, res) => {
  if (isDemoRequest(req)) return res.status(403).json({ error: 'Demo data is read-only' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Food not found' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM food_favorites WHERE user_id = $1 AND custom_food_id = $2', [req.user.id, id]);
    // A logged meal keeps its own name and macros snapshot; only the
    // reference to the deleted food is cleared, so the row stays valid.
    await client.query('UPDATE meal_logs SET custom_food_id = NULL WHERE user_id = $1 AND custom_food_id = $2', [req.user.id, id]);
    const { rows } = await client.query(
      'DELETE FROM custom_foods WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.id]
    );
    await client.query('COMMIT');
    if (!rows[0]) return res.status(404).json({ error: 'Food not found' });
    res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('DELETE /api/custom-foods failed: ' + err.message);
    res.status(500).json({ error: 'Could not delete your food. Please try again.' });
  } finally {
    client.release();
  }
});

// --- Favorites ------------------------------------------------------------

app.get('/api/favorites', async (req, res) => {
  if (isDemoRequest(req)) return res.json({ foods: demoFavoritePayloads() });
  try {
    const favs = await loadFavorites(req.user.id);
    const { rows: foodRows } = await pool.query(
      `SELECT f.* FROM foods f JOIN food_favorites fav ON fav.food_id = f.id
        WHERE fav.user_id = $1 ORDER BY fav.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    const { rows: customRows } = await pool.query(
      `SELECT cf.* FROM custom_foods cf JOIN food_favorites fav ON fav.custom_food_id = cf.id
        WHERE fav.user_id = $1 ORDER BY fav.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({
      foods: foodRows.map((r) => foodPayloadFromRow(r, favs, null))
        .concat(customRows.map((r) => customFoodPayload(r, favs, null))),
    });
  } catch (err) {
    console.error('GET /api/favorites failed: ' + err.message);
    res.status(500).json({ error: 'Could not load your favorites. Please try again.' });
  }
});

// Toggle a favorite by food key. `key` is `<source>:<source_id>` for a
// database food or `custom:<id>` for a user-created one.
app.post('/api/favorites', async (req, res) => {
  if (isDemoRequest(req)) return res.status(403).json({ error: 'Demo data is read-only' });
  const key = req.body && req.body.key;
  if (typeof key !== 'string' || !key) {
    return res.status(400).json({ error: 'A food key is required' });
  }
  try {
    let foodId = null;
    let customFoodId = null;
    if (key.startsWith('custom:')) {
      const id = Number(key.slice('custom:'.length));
      const { rows } = await pool.query(
        'SELECT id FROM custom_foods WHERE id = $1 AND user_id = $2',
        [id, req.user.id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Food not found' });
      customFoodId = rows[0].id;
    } else {
      const row = await findFoodByKey(key);
      if (!row) return res.status(404).json({ error: 'Food not found' });
      foodId = row.id;
    }
    const { rows } = await pool.query(
      `INSERT INTO food_favorites (user_id, food_id, custom_food_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [req.user.id, foodId, customFoodId]
    );
    let favoriteId = rows[0] ? rows[0].id : null;
    if (favoriteId == null) {
      const { rows: existing } = await pool.query(
        `SELECT id FROM food_favorites
          WHERE user_id = $1 AND food_id IS NOT DISTINCT FROM $2
            AND custom_food_id IS NOT DISTINCT FROM $3`,
        [req.user.id, foodId, customFoodId]
      );
      favoriteId = existing[0] ? existing[0].id : null;
    }
    res.status(201).json({ ok: true, id: favoriteId });
  } catch (err) {
    console.error('POST /api/favorites failed: ' + err.message);
    res.status(500).json({ error: 'Could not update your favorites. Please try again.' });
  }
});

app.delete('/api/favorites/:id', async (req, res) => {
  if (isDemoRequest(req)) return res.status(403).json({ error: 'Demo data is read-only' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Favorite not found' });
  try {
    const { rows } = await pool.query(
      'DELETE FROM food_favorites WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Favorite not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/favorites failed: ' + err.message);
    res.status(500).json({ error: 'Could not update your favorites. Please try again.' });
  }
});

// --- Meal logging ---------------------------------------------------------

// POST /api/meals — either a database/custom food (`{ key, meal_type,
// servings }`) or a manual quick add (`{ name, calories, ... }` with no food
// ref). Manual rows keep working exactly as in phase 1.
app.post('/api/meals', async (req, res) => {
  if (isDemoRequest(req)) return res.status(403).json({ error: 'Demo data is read-only' });
  const body = req.body || {};
  const mealType = body.meal_type;
  if (!MEAL_TYPES.includes(mealType)) {
    return res.status(400).json({ error: 'Choose a meal', errors: { meal_type: 'Choose a meal' } });
  }

  try {
    const loaded = await loadProfileAndGoal(req.user.id);
    if (!loaded || !loaded.goal) {
      return res.status(409).json({ error: 'Finish setting up your plan first' });
    }

    let insert;
    if (typeof body.key === 'string' && body.key) {
      const servings = Number(body.servings);
      if (!Number.isFinite(servings) || servings <= 0 || servings > 100) {
        return res.status(400).json({ error: 'Enter a serving amount between 0 and 100', errors: { servings: 'Enter a valid serving amount' } });
      }

      let foodId = null;
      let customFoodId = null;
      let servingG;
      let perServing;
      let name;

      if (body.key.startsWith('custom:')) {
        const id = Number(body.key.slice('custom:'.length));
        const { rows } = await pool.query(
          'SELECT * FROM custom_foods WHERE id = $1 AND user_id = $2',
          [id, req.user.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Food not found' });
        const cf = rows[0];
        customFoodId = cf.id;
        servingG = nz(cf.serving_g);
        perServing = { calories: nz(cf.calories), protein_g: nz(cf.protein_g), carbs_g: nz(cf.carbs_g), fat_g: nz(cf.fat_g) };
        name = cf.name;
      } else {
        const row = await findFoodByKey(body.key);
        if (!row) return res.status(404).json({ error: 'Food not found' });
        foodId = row.id;
        servingG = row.serving_g != null ? nz(row.serving_g) : 100;
        const f = servingG / 100;
        perServing = {
          calories: nz(row.calories) * f,
          protein_g: nz(row.protein_g) * f,
          carbs_g: nz(row.carbs_g) * f,
          fat_g: nz(row.fat_g) * f,
        };
        name = row.name;
      }

      const factor = servings;
      insert = [
        req.user.id, mealType, name,
        foodData.round1(perServing.calories * factor),
        foodData.round1(perServing.protein_g * factor),
        foodData.round1(perServing.carbs_g * factor),
        foodData.round1(perServing.fat_g * factor),
        foodId, customFoodId, servingG, servings,
      ];
    } else {
      // Manual quick add.
      const errors = {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) errors.name = 'Enter a name';
      else if (name.length > 120) errors.name = 'Name must be 120 characters or fewer';
      const values = {};
      for (const [field, label] of [['calories', 'calories'], ['protein_g', 'protein'], ['carbs_g', 'carbs'], ['fat_g', 'fat']]) {
        const n = Number(body[field]);
        if (!Number.isFinite(n) || n < 0 || n > 5000) errors[field] = 'Enter ' + label + ' between 0 and 5000';
        else values[field] = n;
      }
      if (Object.keys(errors).length) {
        return res.status(400).json({ error: 'Please check the highlighted fields', errors });
      }
      insert = [
        req.user.id, mealType, name,
        foodData.round1(values.calories),
        foodData.round1(values.protein_g),
        foodData.round1(values.carbs_g),
        foodData.round1(values.fat_g),
        null, null, null, null,
      ];
    }

    const { rows } = await pool.query(
      `INSERT INTO meal_logs
         (user_id, meal_type, name, calories, protein_g, carbs_g, fat_g,
          food_id, custom_food_id, serving_g, servings, log_date, logged_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
       RETURNING id, meal_type, name, calories, protein_g, carbs_g, fat_g, log_date, logged_at`,
      insert.concat([todayKey()])
    );
    res.status(201).json({ ok: true, meal: rows[0] });
  } catch (err) {
    console.error('POST /api/meals failed: ' + err.message);
    res.status(500).json({ error: 'Could not save that food. Please try again.' });
  }
});

app.delete('/api/meals/:id', async (req, res) => {
  if (isDemoRequest(req)) return res.status(403).json({ error: 'Demo data is read-only' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Entry not found' });
  try {
    const { rows } = await pool.query(
      'DELETE FROM meal_logs WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Entry not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/meals failed: ' + err.message);
    res.status(500).json({ error: 'Could not remove that entry. Please try again.' });
  }
});

// --- History --------------------------------------------------------------

async function historyRange(userId, loaded, date, days) {
  const start = addDays(date, -(days - 1));
  const { rows: mealRows } = await pool.query(
    `SELECT log_date,
            COALESCE(SUM(calories), 0) AS calories,
            COALESCE(SUM(protein_g), 0) AS protein_g,
            COALESCE(SUM(carbs_g), 0) AS carbs_g,
            COALESCE(SUM(fat_g), 0) AS fat_g
       FROM meal_logs
      WHERE user_id = $1 AND log_date BETWEEN $2 AND $3
      GROUP BY log_date`,
    [userId, start, date]
  );
  const { rows: waterRows } = await pool.query(
    `SELECT log_date, glasses FROM water_logs
      WHERE user_id = $1 AND log_date BETWEEN $2 AND $3`,
    [userId, start, date]
  );
  const mealsByDay = new Map();
  for (const r of mealRows) mealsByDay.set(dateKey(r.log_date), r);
  const waterByDay = new Map();
  for (const r of waterRows) waterByDay.set(dateKey(r.log_date), r.glasses);

  const targets = computeTargets(loaded.profile, loaded.goal);
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const d = addDays(start, i);
    const m = mealsByDay.get(d);
    out.push({
      date: d,
      calories: Math.round(nz(m && m.calories) * 10) / 10,
      protein_g: Math.round(nz(m && m.protein_g) * 10) / 10,
      carbs_g: Math.round(nz(m && m.carbs_g) * 10) / 10,
      fat_g: Math.round(nz(m && m.fat_g) * 10) / 10,
      water_glasses: waterByDay.has(d) ? waterByDay.get(d) : 0,
    });
  }

  const sum = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, water_glasses: 0 };
  for (const day of out) {
    sum.calories += day.calories;
    sum.protein_g += day.protein_g;
    sum.carbs_g += day.carbs_g;
    sum.fat_g += day.fat_g;
    sum.water_glasses += day.water_glasses;
  }
  const averages = {};
  for (const key of Object.keys(sum)) averages[key] = Math.round((sum[key] / days) * 10) / 10;

  return {
    start,
    end: date,
    target: {
      calorie_target: targets.calorieTarget,
      protein_g: targets.proteinGrams,
      carbs_g: targets.carbsGrams,
      fat_g: targets.fatGrams,
      water_target_ml: targets.waterTargetMl,
    },
    days: out,
    averages,
  };
}

// GET /api/history?range=day|week|month&date=YYYY-MM-DD — rolling window
// ending at `date` (today by default, clamped to the past). `day` returns
// the dashboard payload for that date; week and month return per-day
// summaries plus a target row and averages.
app.get('/api/history', async (req, res) => {
  const range = ['day', 'week', 'month'].includes(req.query.range) ? req.query.range : 'day';
  const date = clampDateToPast(req.query.date);
  if (isDemoRequest(req)) return res.json(demoHistoryResponse(range, date));
  try {
    const loaded = await loadProfileAndGoal(req.user.id);
    if (!loaded || !loaded.goal) {
      return res.status(409).json({ error: 'Finish setting up your plan first' });
    }
    if (range === 'day') {
      const { rows: mealRows } = await pool.query(
        `SELECT id, meal_type, name, calories, protein_g, carbs_g, fat_g, log_date, logged_at
           FROM meal_logs WHERE user_id = $1 AND log_date = $2 ORDER BY logged_at`,
        [req.user.id, date]
      );
      const { rows: waterRows } = await pool.query(
        'SELECT glasses FROM water_logs WHERE user_id = $1 AND log_date = $2',
        [req.user.id, date]
      );
      const glasses = waterRows[0] ? waterRows[0].glasses : 0;
      return res.json({ range: 'day', ...buildDashboard(loaded.profile, loaded.goal, mealRows, glasses, date) });
    }
    const days = range === 'week' ? 7 : 30;
    const summary = await historyRange(req.user.id, loaded, date, days);
    res.json({ range, ...summary });
  } catch (err) {
    console.error('GET /api/history failed: ' + err.message);
    res.status(500).json({ error: 'Could not load your history. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Staging demo data. Request-time injection behind IS_STAGING + ?demo=1:
// read-only, obviously fake, written to no table. The plain routes stay
// honest — the production answer for a new visitor is the onboarding
// wizard, and nothing here can make the app believe otherwise. Demo rows
// belong to fake identities only and never answer "has this user logged X?"
// for the visitor.
// ---------------------------------------------------------------------------

function isDemoRequest(req) {
  return IS_STAGING && req.query.demo === '1';
}

let demoCache = null;
function demoData() {
  if (demoCache) return demoCache;
  const target = new Date();
  target.setDate(target.getDate() + 90);
  const pad = (n) => String(n).padStart(2, '0');
  const targetDate = target.getFullYear() + '-' + pad(target.getMonth() + 1) + '-' + pad(target.getDate());
  const profile = {
    user_id: -1,
    username: 'staging-demo-user',
    name: 'Staging demo',
    age: 34,
    gender: 'female',
    height_cm: 170,
    weight_kg: 75,
    activity_level: 'moderate',
    email: null,
  };
  const goal = { goal_type: 'lose', target_weight_kg: 68, target_date: targetDate };
  const meals = [
    { id: -1, meal_type: 'breakfast', name: 'Staging demo oat bowl', calories: 420, protein_g: 18, carbs_g: 62, fat_g: 9, log_date: todayKey(), logged_at: new Date() },
    { id: -2, meal_type: 'lunch', name: 'Staging demo chicken salad', calories: 540, protein_g: 45, carbs_g: 20, fat_g: 28, log_date: todayKey(), logged_at: new Date() },
  ];
  demoCache = { profile, goal, meals };
  return demoCache;
}

function demoProfileResponse() {
  const demo = demoData();
  return {
    demo: true,
    onboarded: true,
    profile: demo.profile,
    goal: demo.goal,
    targets: computeTargets(demo.profile, demo.goal),
  };
}

// Demo food rows carry per-100 g nutrition (same basis as the real cache), so
// the payload shaping is identical to the shipped code path.
const DEMO_FOOD_ROWS = [
  {
    key: 'off:demo-oat-bowl', source: 'off', source_id: 'demo-oat-bowl', barcode: '1234567890123',
    name: 'Staging demo oat bowl', brand: null, serving_g: 100, serving_label: '1 bowl (100 g)',
    calories: 420, protein_g: 18, carbs_g: 62, fat_g: 9,
  },
  {
    key: 'off:demo-peanut-butter', source: 'off', source_id: 'demo-peanut-butter', barcode: null,
    name: 'Staging demo peanut butter', brand: 'Staging demo brand', serving_g: 30, serving_label: '2 tbsp (30 g)',
    calories: 588, protein_g: 25, carbs_g: 20, fat_g: 50,
  },
  {
    key: 'usda:demo-chicken-breast', source: 'usda', source_id: 'demo-chicken-breast', barcode: null,
    name: 'Staging demo chicken breast', brand: null, serving_g: 100, serving_label: '100 g',
    calories: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6,
  },
  {
    key: 'off:demo-greek-yogurt', source: 'off', source_id: 'demo-greek-yogurt', barcode: null,
    name: 'Staging demo greek yogurt', brand: 'Staging demo brand', serving_g: 170, serving_label: '1 cup (170 g)',
    calories: 59, protein_g: 10, carbs_g: 3.6, fat_g: 0.4,
  },
];

const DEMO_CUSTOM = {
  id: -1, name: 'Staging demo protein shake', serving_g: 30, serving_label: '1 scoop (30 g)',
  calories: 120, protein_g: 24, carbs_g: 3, fat_g: 1,
};

const DEMO_FAVORITE_KEYS = ['off:demo-oat-bowl', 'custom:-1'];
const DEMO_RECENT_KEYS = ['usda:demo-chicken-breast', 'off:demo-peanut-butter'];

function demoFoodPayload(row, favorite, recent) {
  const factor = row.serving_g / 100;
  return {
    key: row.key,
    source: row.source,
    source_label: SOURCE_LABELS[row.source],
    source_id: row.source_id,
    food_id: null,
    barcode: row.barcode || null,
    name: row.name,
    brand: row.brand || null,
    serving_g: row.serving_g,
    serving_label: row.serving_label,
    calories: foodData.round1(row.calories * factor),
    protein_g: foodData.round1(row.protein_g * factor),
    carbs_g: foodData.round1(row.carbs_g * factor),
    fat_g: foodData.round1(row.fat_g * factor),
    custom: false,
    favorite: !!favorite,
    favorite_id: favorite ? -1 : null,
    recent: !!recent,
  };
}

function demoCustomPayloads() {
  return [{
    key: foodData.customFoodKey(DEMO_CUSTOM.id),
    source: 'custom',
    source_label: SOURCE_LABELS.custom,
    source_id: String(DEMO_CUSTOM.id),
    custom_food_id: DEMO_CUSTOM.id,
    barcode: null,
    name: DEMO_CUSTOM.name,
    brand: null,
    serving_g: DEMO_CUSTOM.serving_g,
    serving_label: DEMO_CUSTOM.serving_label,
    calories: DEMO_CUSTOM.calories,
    protein_g: DEMO_CUSTOM.protein_g,
    carbs_g: DEMO_CUSTOM.carbs_g,
    fat_g: DEMO_CUSTOM.fat_g,
    custom: true,
    favorite: true,
    favorite_id: -1,
    recent: false,
  }];
}

function demoAllPayloads() {
  const foods = DEMO_FOOD_ROWS.map((r) =>
    demoFoodPayload(r, DEMO_FAVORITE_KEYS.includes(r.key), DEMO_RECENT_KEYS.includes(r.key)));
  return foods.concat(demoCustomPayloads());
}

function demoFavoritePayloads() {
  return demoAllPayloads().filter((f) => f.favorite);
}

function demoSearchResponse(q) {
  const all = demoAllPayloads();
  const normQ = foodData.normText(q || '');
  const matches = normQ
    ? all.filter((f) => foodData.normText(f.name).includes(normQ))
    : all;

  const sections = { recent: [], favorites: [], custom: [] };
  for (const f of matches) {
    if (f.custom) sections.custom.push(f.key);
    if (f.favorite) sections.favorites.push(f.key);
    else if (f.recent) sections.recent.push(f.key);
  }

  return {
    q: q || '',
    results: matches,
    sections,
    // One source deliberately unavailable so the partial-failure notice is
    // visible in the preview. Staging has no USDA key, which is the same
    // degraded path production takes before the key is set.
    notices: [sourceNotice('usda')],
  };
}

function demoBarcodeResponse(req, res) {
  const c = String(req.params.code || '').trim();
  if (!/^\d{8,14}$/.test(c)) {
    return res.status(400).json({ error: 'Enter a valid barcode (8 to 14 digits)' });
  }
  const match = DEMO_FOOD_ROWS.find((r) => r.barcode === c);
  if (!match) return res.status(404).json({ error: 'No food found for that barcode' });
  return res.json({ food: demoFoodPayload(match, false, false) });
}

// Deterministic history so before/after shots of the same route match run to
// run. Values are obviously fake and follow a fixed sequence.
function demoHistoryDays(days) {
  const end = todayKey();
  const start = addDays(end, -(days - 1));
  const out = [];
  for (let i = 0; i < days; i += 1) {
    out.push({
      date: addDays(start, i),
      calories: 1700 + ((i * 137) % 500),
      protein_g: 90 + ((i * 7) % 40),
      carbs_g: 150 + ((i * 11) % 60),
      fat_g: 50 + ((i * 5) % 25),
      water_glasses: 4 + (i % 4),
    });
  }
  return out;
}

function demoHistoryResponse(range, date) {
  const demo = demoData();
  const targets = computeTargets(demo.profile, demo.goal);
  if (range === 'day') {
    return { range: 'day', ...buildDashboard(demo.profile, demo.goal, demo.meals, 4, date) };
  }
  const days = range === 'week' ? 7 : 30;
  const rows = demoHistoryDays(days);
  const sum = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, water_glasses: 0 };
  for (const d of rows) {
    sum.calories += d.calories;
    sum.protein_g += d.protein_g;
    sum.carbs_g += d.carbs_g;
    sum.fat_g += d.fat_g;
    sum.water_glasses += d.water_glasses;
  }
  const averages = {};
  for (const key of Object.keys(sum)) averages[key] = Math.round((sum[key] / days) * 10) / 10;
  return {
    range,
    start: rows[0].date,
    end: rows[rows.length - 1].date,
    target: {
      calorie_target: targets.calorieTarget,
      protein_g: targets.proteinGrams,
      carbs_g: targets.carbsGrams,
      fat_g: targets.fatGrams,
      water_target_ml: targets.waterTargetMl,
    },
    days: rows,
    averages,
  };
}

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/my-fitness-8f158f/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/my-fitness-8f158f/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#16a34a;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      user_id INTEGER PRIMARY KEY,
      username VARCHAR(255) NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      age INTEGER NOT NULL,
      gender TEXT NOT NULL CHECK (gender IN ('male', 'female', 'other')),
      height_cm NUMERIC NOT NULL,
      weight_kg NUMERIC NOT NULL,
      activity_level TEXT NOT NULL CHECK (activity_level IN ('sedentary', 'light', 'moderate', 'active', 'very_active')),
      email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS goals (
      user_id INTEGER PRIMARY KEY,
      goal_type TEXT NOT NULL CHECK (goal_type IN ('lose', 'maintain', 'gain')),
      target_weight_kg NUMERIC,
      target_date DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Shared cache of global food-database entries. Public: third-party
  // reference data, no personal content, no FK to a private table. Rows are
  // shared across users, which is the whole point of the cache.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS foods (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('usda', 'off')),
      source_id TEXT NOT NULL,
      barcode TEXT,
      name TEXT NOT NULL,
      brand TEXT,
      calories NUMERIC,
      protein_g NUMERIC,
      carbs_g NUMERIC,
      fat_g NUMERIC,
      serving_g NUMERIC,
      serving_label TEXT,
      norm_name TEXT,
      norm_brand TEXT,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source, source_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS foods_barcode_idx ON foods (barcode)');
  await pool.query('CREATE INDEX IF NOT EXISTS foods_norm_name_idx ON foods (norm_name)');
  // User-created foods: personal content, schema-only in staging.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS custom_foods (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      serving_g NUMERIC NOT NULL,
      serving_label TEXT,
      calories NUMERIC NOT NULL DEFAULT 0,
      protein_g NUMERIC NOT NULL DEFAULT 0,
      carbs_g NUMERIC NOT NULL DEFAULT 0,
      fat_g NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS custom_foods_user_idx ON custom_foods (user_id)');
  // Favorites: personal content, schema-only in staging.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS food_favorites (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      food_id INTEGER REFERENCES foods(id),
      custom_food_id INTEGER REFERENCES custom_foods(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((food_id IS NULL) <> (custom_food_id IS NULL))
    )
  `);
  // Nulls are distinct in a plain UNIQUE, so two partial indexes are what
  // actually enforce "one favorite per food for this user".
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS food_favorites_food_uniq ON food_favorites (user_id, food_id) WHERE food_id IS NOT NULL');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS food_favorites_custom_uniq ON food_favorites (user_id, custom_food_id) WHERE custom_food_id IS NOT NULL');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meal_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      meal_type TEXT NOT NULL CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
      name TEXT NOT NULL,
      calories NUMERIC NOT NULL,
      protein_g NUMERIC NOT NULL DEFAULT 0,
      carbs_g NUMERIC NOT NULL DEFAULT 0,
      fat_g NUMERIC NOT NULL DEFAULT 0,
      log_date DATE NOT NULL,
      logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS meal_logs_user_date_idx ON meal_logs (user_id, log_date)');
  // Phase 2: optional food references plus the serving that was logged. The
  // original manual columns stay, so phase-1 rows and quick adds keep working.
  await pool.query('ALTER TABLE meal_logs ADD COLUMN IF NOT EXISTS food_id INTEGER REFERENCES foods(id)');
  await pool.query('ALTER TABLE meal_logs ADD COLUMN IF NOT EXISTS custom_food_id INTEGER REFERENCES custom_foods(id)');
  await pool.query('ALTER TABLE meal_logs ADD COLUMN IF NOT EXISTS serving_g NUMERIC');
  await pool.query('ALTER TABLE meal_logs ADD COLUMN IF NOT EXISTS servings NUMERIC');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS water_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      log_date DATE NOT NULL,
      glasses INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, log_date)
    )
  `);
  // Personal data: schema copies to staging, rows never do. `foods` stays
  // public on purpose (shared third-party reference data).
  await pool.query("COMMENT ON TABLE profiles IS 'staging:private'");
  await pool.query("COMMENT ON TABLE goals IS 'staging:private'");
  await pool.query("COMMENT ON TABLE meal_logs IS 'staging:private'");
  await pool.query("COMMENT ON TABLE water_logs IS 'staging:private'");
  await pool.query("COMMENT ON TABLE custom_foods IS 'staging:private'");
  await pool.query("COMMENT ON TABLE food_favorites IS 'staging:private'");
}

function start() {
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // Stop accepting connections, drain briefly, then close the pool.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => { pool.end().then(() => process.exit(0)); });
    setTimeout(() => { pool.end().then(() => process.exit(0)); }, 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return migrate();
}

start().catch(err => { console.error(err); process.exit(1); });
