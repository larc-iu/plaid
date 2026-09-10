import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

// Mirrors plaid-ud's flat config (the modern Vite React template): js.recommended
// + react-hooks + react-refresh. We deliberately omit eslint-plugin-react's full
// recommended set (display-name, prop-types, no-unescaped-entities) — noise for
// this app, not correctness.
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
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-unused-vars': ['warn', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
    },
  },
  {
    // A context module exports its provider and its hook together, and a
    // vendored shadcn primitive exports its variants beside the component.
    // Everything else keeps plain functions out of .jsx.
    files: [
      'src/contexts/*.jsx',
      'src/**/contexts/*.jsx',
      'src/components/shared/ConfirmProvider.jsx',
      'src/components/ui/*.jsx',
    ],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
];
