import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

// The same flat config the apps use, kept in step with them by hand: this
// package's files end up compiled into each app, so a rule that gates there has
// to gate here. The React Compiler rules are off for the same reason they are
// off in plaid-igt.
//
// The package has its own eslint rather than borrowing an app's because ESLint
// 10 refuses to lint files outside its config's directory. Tests are the other
// way round, since they run under plaid-igt's vitest, which has the React and the
// happy-dom. See README.md.
export default [
  { ignores: ['dist', 'node_modules', 'test-results', 'playwright-report'] },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // The hooks plugin's React Compiler rules are deferred: on 2026-09-10 they
      // reported 52 set-state-in-effect, 47 refs, 8 immutability, and 2
      // preserve-manual-memoization sites across fifty files, most of them the
      // deliberate ref-mirroring the islands and media hooks rely on. Adopting
      // them is a project of its own; until then the rules that ran before
      // (rules-of-hooks, exhaustive-deps) are the ones that gate.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-unused-vars': ['warn', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
    },
  },
  {
    // A context module exports its provider and its hook together, and a
    // vendored shadcn primitive exports its variants beside the component.
    // Everything else keeps plain functions out of .jsx.
    files: ['src/components/shared/ConfirmProvider.jsx', 'src/components/ui/*.jsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
];
