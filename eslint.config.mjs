/* ESLint owns the markup and the scope analysis. The last entry hands
   .oxlintrc.json to eslint-plugin-oxlint, which switches off the 68 rules oxlint
   already reports and reuses its ignore list.

   .oxlintrc.json is plain JSON, so its three decisions are recorded here.

   oxlint runs its correctness category plus seven rules enabled one at a time.
   Four rules from those categories stay off, each because it is wrong here
   rather than because it is inconvenient:

   consistent-function-scoping wants functions hoisted out of their parent, and
   cannot see that four of the six it flags sit inside a page.evaluate or
   addInitScript callback, which is serialised and run in the browser. Hoisting
   those breaks the test.

   require-post-message-target-origin wants a target origin on a worker's
   postMessage, which has none to give.

   no-array-reverse wants toReversed, which is Safari 16.4 and the floor here is
   15.4. The one site already copies with slice first.

   no-unmodified-loop-condition flags the "while (left > 0)" search in
   generator.js, where left is decremented by a helper it cannot see through.

   unicorn/no-new-array is off because all 38 sites are new Array(n).fill(x).

   .claude is ignored because it holds git worktrees, so from the main checkout
   a linter descending into it reads a second copy of the repository for every
   open branch. */

import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import html from '@html-eslint/eslint-plugin';
import oxlint from 'eslint-plugin-oxlint';
import globals from 'globals';

export default defineConfig([
  /* Every .mjs is node and none of it is published. */
  {
    files: ['**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: 'module', globals: globals.node },
  },

  /* A spec holds two languages: node outside page.evaluate, and page code
     inside it, which ESLint resolves against the same scope and reports as
     undefined. All 109 hits were of that second kind. Declaring those names here
     would be a copy of app.js's internals that nothing keeps honest. */
  {
    files: ['e2e/**/*.mjs'],
    rules: { 'no-undef': 'off' },
  },

  /* A classic script: it runs as a worker, and app.js injects it as a plain
     script when constructing one throws. On that fallback path it shares global
     scope with app.js, so a second top level binding of a shared name is a
     SyntaxError. no-implicit-globals is that rule. */
  {
    files: ['generator.js'],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...globals.worker } },
    rules: { 'no-implicit-globals': ['error', { lexicalBindings: true }] },
  },

  /* No no-implicit-globals here: a service worker has a global scope of its own
     with no other script in it. */
  {
    files: ['sw.js'],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: 'script', globals: globals.serviceworker },
  },

  /* The game, which the build inlines into index.html as a classic script.
     localStorage throws in private modes and every one of those reads is best
     effort, so an empty catch is the handling rather than a missing one. */
  {
    files: ['app.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, SudokuGenerator: 'readonly' },
    },
    rules: { 'no-empty': ['error', { allowEmptyCatch: true }] },
  },

  {
    files: ['**/*.html'],
    plugins: { html },
    extends: ['html/recommended'],
    language: 'html/html',
    rules: {
      /* Pages serves this repository under /sudoku/, so a rooted path resolves
         against a different site and 404s in production only.
         tests/assets.test.mjs checks five named files; this checks all of them. */
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

      /* Markup nests deeper than the code, so HTML is the one place this tree is
         not on two spaces. .editorconfig and biome.json carry the same number
         and have to keep doing so. */
      'html/indent': ['error', 4],
    },
  },

  ...oxlint.buildFromOxlintConfigFile('.oxlintrc.json'),
]);
