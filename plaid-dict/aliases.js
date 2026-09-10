import { fileURLToPath, URL } from 'node:url';

export const DICT_SRC = fileURLToPath(new URL('./src', import.meta.url));
export const IGT_SRC = fileURLToPath(new URL('../plaid-igt/src', import.meta.url));
export const PLAID_CLIENT_SRC = fileURLToPath(new URL('../plaid-client-js/src', import.meta.url));
// The shared UI package, at its REAL source path so it stays first-party — one
// module instance, watched, no immutable `?v=`. Its own bare imports are
// resolved from this app by the plaidUiDeps plugin; see the long note in
// ../plaid-ui/vite.js for what went wrong when this pointed through the
// node_modules symlink instead.
export const PLAID_UI_SRC = fileURLToPath(new URL('../plaid-ui/src', import.meta.url));

/**
 * The app's module aliases, shared by the dev/build config and the test config
 * (a vitest.config.js REPLACES vite.config.js rather than merging with it).
 *
 * `@igt` is the whole point: the sense tree, the entry numbering, the field
 * schema and the document machinery have ONE definition, plaid-igt's, and
 * numbers on screen are the most visible thing that could drift between the
 * editor and the dictionary.
 *
 * The `@` entry carries a resolver because plaid-igt's own modules import each
 * other as `@/domain/...`. That specifier hits THIS app's `@` and would land in
 * plaid-dict/src, so when the importer is a plaid-igt file it is rebased onto
 * plaid-igt/src. A plugin cannot do this on Vite 5, which the app builds with:
 * it runs its alias plugin BEFORE user plugins, `enforce: 'pre'` included, so
 * the rule has to live in the alias itself.
 *
 * Vite 7 (which vitest brings its own copy of, hence the deprecation warning on
 * `npm test`) reversed that order and drops `customResolver` in Vite 9. When
 * this app moves off Vite 5, replace this entry with a plugin whose `resolveId`
 * rebases the same way, under `enforce: 'pre'`.
 */
export const aliases = [
  {
    find: /^@\//,
    replacement: `${DICT_SRC}/`,
    customResolver(id, importer, options) {
      const target = importer?.startsWith(IGT_SRC) ? id.replace(DICT_SRC, IGT_SRC) : id;
      return this.resolve(target, importer, { ...options, skipSelf: true });
    },
  },
  { find: /^@igt\//, replacement: `${IGT_SRC}/` },
  { find: /^@ui\//, replacement: `${PLAID_UI_SRC}/` },
  // Aliased to its real source path rather than reached through the
  // node_modules symlink: as a "dependency" Vite stamps the import URL with the
  // dep optimizer's `?v=<browserHash>` and serves it back immutable, and that
  // hash comes from the lockfile, not from the client's source. A new client
  // method then arrives as `undefined` in the app forever. Same fix as
  // plaid-igt and plaid-ud.
  {
    find: '@larc-iu/plaid-client',
    replacement: fileURLToPath(new URL('../plaid-client-js/src/index.js', import.meta.url)),
  },
];
