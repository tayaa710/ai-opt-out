// ESLint flat config (ESLint 10). Run with `npm run lint`.
// Extension code runs in the browser (extension pages, the MV3 service worker and
// classic content scripts); scripts and tests run in Node.
import js from '@eslint/js';
import globals from 'globals';

/** Globals the classic content scripts define for each other (see extension/content/*.js). */
const contentScriptGlobals = { NoTrainEngine: 'readonly', NoTrainOverlay: 'readonly' };

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'test-results/**',
      'playwright-report/**',
      'blob-report/**',
      '.cache/**',
      'registry/dist/**',
      'registry/snapshots/**',
      'extension/data/**',
    ],
  },
  js.configs.recommended,
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-eval': 'error',
      'no-script-url': 'error',
    },
  },
  {
    // Extension pages, service worker and shared ES modules.
    files: ['extension/**/*.js', 'extension/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        ...globals.webextensions,
      },
    },
  },
  {
    // Content scripts are classic scripts injected into web pages; they cannot use
    // import/export and share state through deliberate globals (NoTrainEngine, NoTrainOverlay).
    files: ['extension/content/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...contentScriptGlobals,
      },
    },
  },
  {
    // Static landing page (GitHub Pages): plain browser scripts.
    files: ['site/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ['scripts/**/*.{js,mjs}', 'tests/**/*.{js,mjs}', '*.config.{js,mjs}', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Playwright tests evaluate callbacks inside pages and extension contexts.
    files: ['tests/e2e/**/*.{js,mjs}', 'tests/fixtures/**/*.{js,mjs}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...globals.webextensions, ...contentScriptGlobals },
    },
  },
];
