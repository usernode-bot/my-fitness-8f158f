// Tailwind config for this app's precompiled stylesheet.
//
// npm run build (Docker or Paketo) runs the Tailwind CLI over the globs below
// and writes public/tailwind.css, which public/index.html links as
// /tailwind.css. Nothing is committed — every image build regenerates it.
//
// To build it locally (optional; the image build does this for you):
//   npm ci --include=dev
//   npm run build
const { green, orange } = require('tailwindcss/colors');

// ---------------------------------------------------------------------
// Brand palette — THE ONE PLACE to change the app's colors.
//
// Swap either entry for any palette from `tailwindcss/colors` (e.g. blue,
// rose) or for an object with shades 50–950. Accessibility guardrails:
// keep 600 dark enough that white button text still passes WCAG AA
// (4.5:1), and 400 light enough to read as text on dark backgrounds.
// Shades the app actually uses: primary 400–700, accent 400–600.
// ---------------------------------------------------------------------
const brand = {
  primary: green,
  accent: orange,
};

module.exports = {
  // Every file that can contain a class name. Tailwind's extractor is a
  // regex over source text, so it finds class names written as whole
  // literals — including ones inside JS strings in these files.
  content: [
    './public/**/*.html',
    './public/**/*.js',
  ],

  // Classes this app builds dynamically (if it ever does) go here, since the
  // extractor cannot see them. Prefer whole literals in the markup instead.
  safelist: [],

  // dark: variants key off the .dark class that the theme script in
  // public/index.html toggles from the platform's Light/Dark setting.
  darkMode: 'class',

  // Stops hover: styles sticking after a tap on touch screens. Required by
  // the usernode-native UI kit and harmless without it.
  future: { hoverOnlyWhenSupported: true },

  // Brand palette: green is the primary (rings, buttons, active nav),
  // orange the accent (over-target states, secondary bars, demo badge).
  theme: {
    extend: {
      colors: {
        primary: green,
        accent: orange,
      },
    },
  },
  plugins: [],
};
