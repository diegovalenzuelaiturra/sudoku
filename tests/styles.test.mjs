/* Biome lints the CSS inside index.html, and it lints property NAMES. Given
   .a{animation-duration:NaNs;width:bogus;color:notacolor} it reports nothing,
   because every one of those names exists. Nothing in this repository read a
   declaration VALUE until this file, which is how a minifier was able to write
   NaNs into the published stylesheet and have four linters, two scanners and a
   browser suite all agree the page was fine.

   Run against the built page rather than the source, because that is where the
   class of failure lives: the source value was legal the whole time and the
   minifier is what made it not. ESLint is driven through Linter here rather
   than through eslint.config.mjs, because @html-eslint ships no processor, so
   the ordinary CLI cannot reach CSS that lives inside an HTML file.

   use-baseline is deliberately not enabled. lightningcss is given the browser
   floor in scripts/build.mjs and adds the prefixes the floor needs, which
   enforces the same thing by construction; use-baseline would still report the
   unprefixed source spelling and the report would be noise. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import css from '@eslint/css';
import { Linter } from 'eslint';

const root = join(import.meta.dirname, '..');
const published = join(root, '_site', 'index.html');

/* tests/site.test.mjs owns building _site and reports a build failure itself.
   This skips rather than duplicating that report. */
const haveSite = existsSync(published);

const stylesheet = () => {
  const html = readFileSync(published, 'utf8');
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gu)]
    .map((match) => match[1])
    .join('\n');
};

/* allowUnknownVariables, because app.js sets --dur and --fall on the element at
   run time. The rule cannot see a custom property that never appears in the
   stylesheet, and without this it reports each use as invalid. */
const check = (code) =>
  new Linter().verify(code, {
    plugins: { css },
    language: 'css/css',
    rules: { 'css/no-invalid-properties': ['error', { allowUnknownVariables: true }] },
  });

test('every declaration in the published stylesheet has a value the property accepts', (t) => {
  if (!haveSite) return t.skip('no _site to check yet');

  const problems = check(stylesheet()).map((m) => `${m.line}:${m.column} ${m.message}`);

  assert.deepEqual(
    problems,
    [],
    'the published stylesheet holds a declaration no browser will apply. If the source spells it ' +
      'legally, the minifier in scripts/build.mjs rewrote it.',
  );
});

test('the check can still see a broken value', (t) => {
  if (!haveSite) return t.skip('no _site to check yet');

  /* A rule that has been quietly switched off by a config change reports zero
     forever, which is indistinguishable from a clean stylesheet. This is the
     assertion that tells the two apart, and it is the exact bug that shipped. */
  const problems = check(`${stylesheet()}\n.probe{animation-duration:NaNs}`);

  assert.equal(
    problems.length,
    1,
    'the value check reports nothing even for animation-duration:NaNs, so it is no longer running',
  );
});
