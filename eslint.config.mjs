import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import html from '@html-eslint/eslint-plugin';
import oxlint from 'eslint-plugin-oxlint';
import globals from 'globals';

export default defineConfig([
  {
    files: ['**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: 'module', globals: globals.node },
  },

  {
    files: ['e2e/**/*.mjs'],
    rules: { 'no-undef': 'off' },
  },

  {
    files: ['generator.js'],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...globals.worker } },
    rules: { 'no-implicit-globals': ['error', { lexicalBindings: true }] },
  },

  {
    files: ['stats.js'],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: 'script', globals: { self: 'readonly' } },
    rules: { 'no-implicit-globals': ['error', { lexicalBindings: true }] },
  },

  {
    files: ['sw.js'],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: 'script', globals: globals.serviceworker },
  },

  {
    files: ['app.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, SudokuGenerator: 'readonly', SudokuStats: 'readonly' },
    },
    rules: { 'no-empty': ['error', { allowEmptyCatch: true }] },
  },

  {
    files: ['**/*.html'],
    plugins: { html },
    extends: ['html/recommended'],
    language: 'html/html',
    rules: {
      'html/no-restricted-attr-values': [
        'error',
        {
          attrPatterns: ['href', 'src'],
          attrValuePatterns: ['^/[^/]*'],
          message: 'absolute path: Pages serves this repository under /sudoku/, use a relative one',
        },
      ],

      'html/require-input-label': 'error',
      'html/no-positive-tabindex': 'error',
      'html/no-aria-hidden-on-focusable': 'error',
      'html/no-aria-hidden-body': 'error',
      'html/no-abstract-roles': 'error',
      'html/no-invalid-role': 'error',
      'html/no-nested-interactive': 'error',
      'html/require-frame-title': 'error',
      'html/require-meta-description': 'error',
      'html/no-duplicate-class': 'error',

      'html/indent': ['error', 4],
    },
  },

  ...oxlint.buildFromOxlintConfigFile('.oxlintrc.json'),
]);
