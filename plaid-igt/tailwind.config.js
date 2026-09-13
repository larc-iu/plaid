import animate from 'tailwindcss-animate';
import typography from '@tailwindcss/typography';
import plaidUi, { PLAID_UI_CONTENT } from '../plaid-ui/tailwind.preset.js';

/** @type {import('tailwindcss').Config} */
export default {
  // Dark mode, the shadcn token names, the radii and the accordion keyframes.
  presets: [plaidUi],
  // Preflight is ON (global). Mantine is fully removed, so the app is pure
  // shadcn/Tailwind and wants the standard base reset (incl. the sans-serif font
  // stack — without it the app falls back to the browser serif default). The old
  // `:where(.tw)` opt-in scoping is retired; `.tw` classNames are now no-ops.
  // The package's glob rides here and not in the preset: Tailwind 3 does not
  // merge `content` across presets, it takes the last one declared.
  content: ['./index.html', './src/**/*.{js,jsx}', PLAID_UI_CONTENT],
  plugins: [animate, typography],
};
