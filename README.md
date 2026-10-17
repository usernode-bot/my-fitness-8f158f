# My Fitness

A diet and nutrition program web app on [Homeroom](https://app.onhomeroom.com):
it turns your body stats and goal into an automatic daily plan (calories,
macros, water) and tracks how you are doing against it, day by day.

## What works today

- **Sign-in** happens through Homeroom itself. Open the app from the shell and
  you are already signed in; the app never sees or stores a password. Direct
  visits outside the shell are refused.
- **Onboarding wizard** collects name, age, gender, height, weight and activity
  level, then your goal (lose / maintain / gain, with target weight and date)
  and shows the computed plan before saving.
- **Automatic targets**, computed server-side with the Mifflin-St Jeor formula:
  BMI (with category), BMR, TDEE (daily burn), a daily calorie target adjusted
  for your goal (floored at 1200 kcal for safety), goal-adjusted protein/carb/
  fat targets, and a daily water target of roughly 35 ml per kg of body weight.
- **Dashboard** with a calorie progress ring, today's meals grouped by meal,
  a water tracker with +1 / −1 glass controls, and your plan facts. The ring
  and macro bars update as soon as food is logged.
- **Food log** (a third nav item) with three tabs:
  - **Today**: the day's meals with per-meal Add buttons, day totals, and the
    water tracker, so logging and drinking live in one place.
  - **Week**: the last 7 days of calories against your target, average per day,
    and water per day.
  - **Month**: the last 30 days, same shape.
- **Global food search** across Open Food Facts and USDA FoodData Central, run
  server-side with caching and per-source timeouts. Results from both sources
  are merged and deduplicated, and each result names the source it came from.
  Recent foods, favorites and your own custom foods appear before you type.
  Adding food is a guided three-step flow — **Which meal? → Find your food →
  How much?** — with barcode scanning/typing and food creation as quieter
  "More ways to add" below the results.
- **Barcode lookup**: a Scan barcode button where the browser supports
  `BarcodeDetector` and the camera is granted, plus an "Enter a barcode"
  field to type or paste a number everywhere else.
- **Custom foods** ("My foods") you create, edit and delete; the form asks
  for the name and serving first, then the nutrition numbers, and the saved
  food is selected straight away for logging. They behave exactly like
  database foods. **Favorites** star any food for one-tap access later.
- **Water** uses 250 ml glasses with a target computed from your plan, also
  visible over the week and month. The card keeps one-tap **+1 glass** /
  **−1**, and a **Log water…** sheet adds a stepper and quick amounts (a
  glass, a 500 ml bottle) saved in one go.
- **Your data is real**: everything is stored in the app's own PostgreSQL
  database, scoped to your platform user id. Error states show real errors;
  there is no demo or mock mode in the product. A food search that cannot reach
  a source says so and offers Retry rather than filling in fake data.

## Running locally

```sh
npm ci --include=dev
npm run build          # compiles public/tailwind.css
DATABASE_URL=postgres://... node server.js
```

`DATABASE_URL`, `PORT`, `USERNODE_JWT_PUBLIC_KEY`, `USERNODE_APP_ID` and
`USERNODE_ENV` are injected by the platform at runtime.

### Optional: USDA FoodData Central

Food search always queries **Open Food Facts** (keyless). To also get **USDA
FoodData Central** results, set the app secret `USDA_FDC_API_KEY` in
Settings → Secrets. Get a free key at
https://fdc.nal.usda.gov/api-key-signup. The key is optional and private: with
no value set, search simply returns Open Food Facts plus the cache, and the app
shows a small notice naming USDA as unavailable. The key is never committed,
and staging runs without it.

## Project layout

- `server.js` — Express app: platform JWT auth, schema migration, JSON API.
- `calculations.js` — the health math (BMI/BMR/TDEE/macros/water) and
  server-side validation, shared by every route.
- `foods.js` — the food-data module: OFF/USDA clients, normalization,
  dedup/merge, and the search assembly helpers.
- `public/index.html` — the whole frontend (vanilla JS + precompiled Tailwind).
- `dapp.json` — platform manifest (secrets, permissions) and the proposal
  checks ("CI") that run against every staging build.

## Roadmap

Meal plans and recipes, progress tracking with charts, AI features (via the
platform LLM proxy), push notifications, PWA, exports and i18n.
