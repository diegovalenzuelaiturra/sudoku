/* Three linters run over this tree: oxlint, ESLint and Biome. ESLint owns the
   markup and the scope analysis, which needs to know which of four environments
   a file runs in. The last entry hands .oxlintrc.json to eslint-plugin-oxlint,
   which switches off the 68 rules oxlint already reports and reuses its ignore
   list.

   .oxlintrc.json is plain JSON so every JSON tool can read it, which leaves it
   nowhere to record two things:

   Only the correctness category is on. The others were run over this tree
   first: suspicious 33 findings, perf 22, pedantic 202, restriction 341, style
   1403, and what is not opinion is a false positive here. Two that look like
   bugs and are not: no-unmodified-loop-condition on the "while (left > 0)"
   search in generator.js, where left is decremented by a helper it cannot see
   through, and require-post-message-target-origin on that file's worker
   replies, which have no target origin to pass.

   unicorn/no-new-array is off because all 33 sites are new Array(n).fill(x).

   .claude is ignored because it holds git worktrees, so from the main checkout
   a linter descending into it reads a second copy of the repository for every
   open branch. tests/typography.test.mjs skips it for the same reason. */

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

  /* A Playwright spec holds two languages: node outside page.evaluate, and page
     code inside it, which ESLint resolves against the same scope and reports as
     undefined. All 109 hits were inside an evaluate, waitForFunction or
     addInitScript callback, naming globals app.js defines. Declaring those here
     would be a copy of the app's internals that nothing keeps honest. */
  {
    files: ['e2e/**/*.mjs'],
    rules: { 'no-undef': 'off' },
  },

  /* A classic script, not a module: it runs as a worker, and index.html injects
     it as a plain script when constructing one throws.

     no-implicit-globals is the "exactly one global" rule. On the fallback path
     this file shares global scope with app.js, so a second top level binding of
     a name they both use is a SyntaxError, and only on that path. */
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

  /* The game. The build inlines it into index.html as a classic script.
     localStorage throws in private modes, and every one of those reads is best
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
         tests/assets.test.mjs checks the same thing over five named files; this
         checks every HTML file. */
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
         not on two spaces. .editorconfig carries the matching [*.html] block and
         has to keep saying the same number, or an editor and this rule take
         turns rewriting the file. */
      'html/indent': ['error', 4],
    },
  },

  ...oxlint.buildFromOxlintConfigFile('.oxlintrc.json'),
]);
