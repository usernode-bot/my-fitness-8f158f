const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const {
  computeTargets,
  validateProfilePayload,
} = require('./calculations');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Staging gets request-time demo data so the post-onboarding dashboard can
// be previewed and screenshotted. Data and preview state only — never a
// feature, a screen, or a code path (see the platform's USERNODE_ENV rule).
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

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
// My Fitness data. All four tables hold personal health data, so each is
// marked `staging:private`: staging copies their schema but never their
// rows, which is why the staging preview always opens on the onboarding
// wizard — the production-shaped answer for a brand-new user.
// ---------------------------------------------------------------------------

// Local calendar date (YYYY-MM-DD) a log belongs to. Server-local time is
// acceptable for phase 1; revisit when per-user timezones matter.
function todayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

const MAX_GLASSES = 20;

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
// ships (same shaping, same response shape, different data).
function buildDashboard(profile, goal, mealRows, glasses) {
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

  let daysToTarget = null;
  if (goal.target_date) {
    const target = new Date(goal.target_date + 'T00:00:00');
    const today = new Date(todayKey() + 'T00:00:00');
    daysToTarget = Math.max(0, Math.round((target - today) / 86400000));
  }

  return {
    date: todayKey(),
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
// Staging demo data. Request-time injection behind IS_STAGING + ?demo=1:
// read-only, obviously fake, written to no table. The plain routes stay
// honest — the production answer for a new visitor is the onboarding
// wizard, and nothing here can make the app believe otherwise.
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
  await pool.query(
    'CREATE INDEX IF NOT EXISTS meal_logs_user_date_idx ON meal_logs (user_id, log_date)'
  );
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
  // Health data: schema copies to staging, rows never do.
  await pool.query("COMMENT ON TABLE profiles IS 'staging:private'");
  await pool.query("COMMENT ON TABLE goals IS 'staging:private'");
  await pool.query("COMMENT ON TABLE meal_logs IS 'staging:private'");
  await pool.query("COMMENT ON TABLE water_logs IS 'staging:private'");
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
