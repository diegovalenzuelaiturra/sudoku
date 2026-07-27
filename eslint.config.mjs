/* ESLint runs second, after oxlint, and deliberately overlaps with it as little
   as possible. The last entry below hands .oxlintrc.json to eslint-plugin-oxlint,
   which switches off the 68 ESLint rules oxlint already reports and turns that
   file's ignorePatterns into ESLint's global ignores, so the two tools share one
   ignore list and never print the same problem twice.

   What ESLint is here for, then, is the part oxlint does not do: HTML, through
   @html-eslint, and the scope and globals analysis that needs to know which of
   the four environments in this repository a file runs in. There are four, and
   getting one wrong is not cosmetic: no-undef reports every global of an
   environment it was not told about, which is a wall of noise that gets the rule
   switched off.

   One thing this does not cover, which is worth knowing before trusting a green
   run: the game itself. index.html carries the whole application in an inline
   script, and @html-eslint lints the markup around that script rather than the
   JavaScript inside it, so those lines are checked by the unit and e2e suites
   and by nothing here. */

import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import html from '@html-eslint/eslint-plugin';
import oxlint from 'eslint-plugin-oxlint';
import globals from 'globals';

export default defineConfig([
  /* Everything with an .mjs extension is node, and is not published: the build
     scripts, the unit tests, the Playwright specs and their config. */
  {
    files: ['**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: 'module', globals: globals.node },
  },

  /* A Playwright spec holds two languages. Outside page.evaluate it is node;
     inside it, the callback is serialised and run in the browser, where the
     app's own globals exist and nothing in this process does. ESLint resolves
     both against the same scope, so it reports the second kind as undefined.

     Measured rather than assumed before switching the rule off: all 109 hits sit
     inside an evaluate, waitForFunction or addInitScript callback, and every
     name is one the page defines (values, solution, sel, saveGame, GRADE_WORDS).
     None is a typo in node code. Declaring those names as globals here was the
     alternative and was rejected: the list would be a copy of the app's internals
     that nothing keeps honest, so renaming one in index.html would leave a stale
     entry here and no failure anywhere. What is given up is catching a misspelt
     identifier in the node half of these files, which throws on the first run
     instead. */
  {
    files: ['e2e/**/*.mjs'],
    rules: { 'no-undef': 'off' },
  },

  /* generator.js is a classic script, not a module, and that is load bearing:
     it normally runs as a worker and index.html injects it as a plain <script>
     when constructing one throws. Parsed as a module it would be given module
     scope and strict mode, which is not how either of those runs it. Both
     environments are declared for the same reason. */
  {
    files: ['generator.js'],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...globals.worker } },
  },

  {
    files: ['sw.js'],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: 'script', globals: globals.serviceworker },
  },

  {
    files: ['**/*.html'],
    plugins: { html },
    extends: ['html/recommended'],
    language: 'html/html',
    rules: {
      /* The plugin's own default is 4. Two is what .editorconfig declares for
         every file in this repository and what every tracked file already uses,
         and the whole point of that file is that a tool with different defaults
         does not get to quietly reindent a file and bury the next real change
         in noise. This is that tool, so it is told. */
      'html/indent': ['error', 2],
    },
  },

  ...oxlint.buildFromOxlintConfigFile('.oxlintrc.json'),
]);
