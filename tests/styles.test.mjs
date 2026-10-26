import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import css from '@eslint/css';
import { Linter } from 'eslint';

const root = join(import.meta.dirname, '..');
const published = join(root, '_site', 'index.html');

const haveSite = existsSync(published);

const stylesheet = () => {
  const html = readFileSync(published, 'utf8');
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gu)]
    .map((match) => match[1])
    .join('\n');
};

// MUST KILL: allowUnknownVariables exists only because app.js sets --dur and --fall at run time and the stylesheet never declares them
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

  const problems = check(`${stylesheet()}\n.probe{animation-duration:NaNs}`);

  assert.equal(
    problems.length,
    1,
    'the value check reports nothing even for animation-duration:NaNs, so it is no longer running',
  );
});
