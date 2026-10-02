# My Fitness

A diet and nutrition program web app on [Homeroom](https://app.onhomeroom.com):
it turns your body stats and goal into an automatic daily plan (calories,
macros, water) and tracks how today is going against it.

## What works today (phase 1)

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
- **Dashboard** with a calorie progress ring, today's meals summary (populated
  by food logging, arriving in a later phase), a water tracker with a +1 glass
  control, and your plan facts. Mobile-first: bottom navigation on phones,
  a sidebar on desktop, from 320 px up.
- **Your data is real**: everything is stored in the app's own PostgreSQL
  database, scoped to your platform user id. Error states show real errors;
  there is no demo or mock mode in the product.

## Running locally

```sh
npm ci --include=dev
npm run build          # compiles public/tailwind.css
DATABASE_URL=postgres://... node server.js
```

`DATABASE_URL`, `PORT`, `USERNODE_JWT_PUBLIC_KEY`, `USERNODE_APP_ID` and
`USERNODE_ENV` are injected by the platform at runtime; the app needs no extra
secrets and calls no third-party APIs in this phase (later phases add USDA
FoodData Central, Open Food Facts, recipe and LLM integrations via the
platform's proxy).

## Project layout

- `server.js` — Express app: platform JWT auth, schema migration, JSON API.
- `calculations.js` — the health math (BMI/BMR/TDEE/macros/water) and
  server-side validation, shared by every route.
- `public/index.html` — the whole frontend (vanilla JS + precompiled Tailwind).
- `dapp.json` — platform manifest and the proposal checks ("CI") that run
  against every staging build.

## Roadmap

Food tracking against a global food database, meal plans and recipes,
progress tracking with charts, AI features (via the platform LLM proxy),
push notifications, PWA, exports and i18n.
