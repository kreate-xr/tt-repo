// Flat config, ESLint 9+. Ran for the first time long after the codebase was
// written, so the rule set starts from `recommended` with a few adjustments
// where the existing style is deliberate (unused underscore-prefixed args,
// empty catch blocks used as "best effort" guards around teardown).
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'vr-assets/**', 'ai-docs/**'],
  },

  js.configs.recommended,

  // Game/browser source. ESM throughout.
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // Substituted at build time by vite.config.js's `define`. All are read
      // behind a typeof guard (js/analytics/session.js, js/analytics/gtm.js,
      // js/network/appCheck.js) so the modules also work under Jest, where
      // nothing is substituted.
      globals: {
        ...globals.browser,
        __APP_VERSION__: 'readonly',
        __GTM_CONTAINER_ID__: 'readonly',
        __RECAPTCHA_SITE_KEY__: 'readonly',
        __APPCHECK_DEBUG_TOKEN__: 'readonly',
        __IS_DEV_SERVER__: 'readonly',
        __PAYLAYER_URL__: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Node-side: dev server, scripts, build config.
  {
    files: ['server/**/*.js', 'scripts/**/*.{js,mjs}', 'babel.config.cjs', 'vite.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // Playwright e2e: Node, plus browser globals for the page.evaluate()
  // callbacks that run inside the page.
  {
    files: ['e2e/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Cloud Functions backend: Node 22, ESM ("type": "module").
  {
    files: ['functions/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['**/*.cjs', 'server/**/*.js'],
    languageOptions: { sourceType: 'commonjs' },
  },

  // Jest suites: ESM syntax (babel-jest transpiles) with the occasional
  // require(), plus jest/browser globals.
  {
    files: ['tests/**/*.js', 'tests-rules/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.jest, ...globals.node, ...globals.commonjs, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
