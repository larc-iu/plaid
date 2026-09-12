import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** This package's source directory, for aliases and watchers. */
export const PLAID_UI_SRC = fileURLToPath(new URL('./src', import.meta.url));

/**
 * Static files every app serves at its root: the mark the browser tab shows and
 * the bits that hang off it. Each app points `publicDir` here rather than
 * keeping its own copy, so the three tabs cannot drift apart from each other or
 * from the artwork in `src/components/assistant/PlaidMarks.jsx`. Vite copies
 * whatever is in here into each app's `dist/`, under that app's base path.
 *
 * `plaid.svg` is `PlaidMark`, the rounded swatch, cropped to its own bounds
 * because a tab supplies its own padding.
 *
 * `plaid-square.png` is the same sett with the rounded clip removed, so it is
 * opaque edge to edge. That is on purpose: iOS and Android both apply their own
 * mask to a home-screen icon, so a rounded one with transparent corners comes
 * out with black notches, and a sett survives being cropped to a circle. To
 * redo it after an artwork change: drop the `<clipPath>` and the `clip-path`
 * attribute from plaid.svg, then
 * `inkscape -w 512 -h 512 <that> -o raw.png && convert raw.png -alpha off -strip PNG24:plaid-square.png`.
 *
 * The three `manifest-*.webmanifest` files differ only in the app's name, and
 * live here rather than in each app because the icons are what they are mostly
 * for. Every path inside them is relative, so one file works both at the dev
 * server's root and under the jar's `/igt/`, `/ud/` or `/dict/` base. They say
 * `"display": "browser"` deliberately: this gives a pinned shortcut the app's
 * name and mark, and changes nothing about how the app runs. Sharing one
 * directory means each app ships all three, which is a few hundred bytes and
 * not a mistake; each `index.html` links only its own.
 */
export const PLAID_UI_PUBLIC = fileURLToPath(new URL('./public', import.meta.url));

/**
 * Resolve this package's own bare imports: react, lucide-react, sonner, the
 * Radix primitives, from the app that is compiling it.
 *
 * Why it is needed: `@ui` aliases straight to `plaid-ui/src`, which is OUTSIDE
 * any app and has no node_modules, so a bare specifier in here resolves against
 * nothing. Node's own answer is a node_modules symlink, and aliasing through
 * one does make bare imports resolve, but it also puts every file in this
 * package under `node_modules/`, which is Vite's definition of a dependency.
 * The optimizer then pre-bundles them, and a module imported BOTH by an app
 * (`@ui/lib/uiConfig.js`, optimized) and by a sibling in here (`../lib/
 * uiConfig.js`, source) exists twice. That is not a theoretical concern: it
 * shipped, and `configureUi` wrote to one copy of the config while the hooks
 * read the other, so plaid-igt's compose codes went dead in React fields and
 * every remembered list sort silently rekeyed itself.
 *
 * So the alias points at the real source path, this package stays first-party
 * (one instance, watched, hot-reloaded, no immutable `?v=`), and its bare
 * imports are resolved here as though the app had written them itself.
 *
 * `enforce: 'pre'` puts this ahead of Vite's own resolution. It is deliberately
 * blind to relative and absolute ids, which resolve correctly on their own.
 */
export const plaidUiDeps = (appRoot) => ({
  name: 'plaid-ui-deps',
  enforce: 'pre',
  async resolveId(id, importer, options) {
    if (!importer || !importer.startsWith(PLAID_UI_SRC)) return null;
    if (id[0] === '.' || id[0] === '/' || id[0] === '\0') return null;
    const resolved = await this.resolve(id, path.join(appRoot, 'index.html'), {
      ...options,
      skipSelf: true,
    });
    return resolved ?? null;
  },
});
