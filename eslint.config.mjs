/* ESLint runs second, after oxlint, and deliberately overlaps with it as little
   as possible. The last entry below hands .oxlintrc.json to eslint-plugin-oxlint,
   which switches off the 68 ESLint rules oxlint already reports and turns that
   file's ignorePatterns into ESLint's global ignores, so the two tools share one
   ignore list and never print the same problem twice.

   .oxlintrc.json is plain JSON, with no comments, so that every tool which
   reads JSON can read it. The three things a reader would otherwise ask it are
   recorded here instead.

   Why only the correctness category. It is the one oxlint reserves for code
   that is simply wrong. The others were run over this tree before being left
   out rather than dismissed: suspicious adds 33 findings, perf 22, pedantic
   202, restriction 341 and style 1403, and the ones that are not pure opinion
   are false positives here. Two worth naming so they are not rediscovered and
   mistaken for bugs: no-unmodified-loop-condition flags the "while (left > 0)"
   search in generator.js, where left is decremented by a helper the rule cannot
   see through, and require-post-message-target-origin flags that file's worker
   replies, where no target origin exists to pass.

   Why unicorn/no-new-array is off. All 33 sites it fired on are
   new Array(n).fill(x), where the ambiguity it exists to catch, whether the
   argument is a length or a lone element, is answered by the very next call.

   Why .claude is in ignorePatterns. It holds git worktrees, so from the main
   checkout a linter that descends into it reads a full second copy of this
   repository for every branch anyone has open, and reports on files belonging
   to another branch. tests/typography.test.mjs skips it for the same reason.

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
      /* Four, which is the plugin's own default and is written out anyway so
         that this file and .editorconfig say the same number in the same words.
         HTML is the one exception to the two spaces the rest of the tree uses,
         because markup nests far deeper than the code does: the board sits
         eight levels in, and at two spaces the indentation stops being a cue
         about depth. .editorconfig carries the matching [*.html] block, and the
         two have to be changed together or an editor and this rule will take
         turns reformatting the file. */
      'html/indent': ['error', 4],
    },
  },

  ...oxlint.buildFromOxlintConfigFile('.oxlintrc.json'),
]);
