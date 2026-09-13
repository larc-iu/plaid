import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The Tailwind theme every app that mounts this package shares, plus the glob
// that makes the package's own classes reach the stylesheet.
//
// It was the same 40 lines pasted into three configs, and it had already
// drifted: plaid-dict was missing the accordion keyframes the other two had, so
// a shared component that animated in one app did not in another.
//
// The shadcn TOKENS themselves stay per app, in each `index.css`. A dictionary
// reader and an annotation editor are allowed to look different; what has to
// agree is the NAMES they answer to, which is what this file fixes. Plugins
// stay per app too, since they are the app's own dependencies.
//
// Spread it as a preset, and list the package's sources alongside the app's:
//
//   import plaidUi, { PLAID_UI_CONTENT } from '../plaid-ui/tailwind.preset.js';
//   export default {
//     presets: [plaidUi],
//     content: ['./index.html', './src/**/*.{js,jsx}', PLAID_UI_CONTENT],
//     plugins: [animate, typography],
//   };
//
// `theme.extend` merges across presets. `content` does NOT: Tailwind 3 takes
// the last one declared, so a preset's glob is silently dropped by any app that
// names its own, and every class this package uses goes missing from the
// stylesheet. Hence the separate export, which an app spreads into its list.

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * This package's own sources. Absolute, so it holds wherever Tailwind is run
 * from rather than depending on the app directory being the working directory.
 */
export const PLAID_UI_CONTENT = path.join(here, 'src/**/*.{js,jsx}');

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: [PLAID_UI_CONTENT],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
};
