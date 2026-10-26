import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const sources = ['index.html', 'app.js', '404.html'];

const ACCENTED = [
  ['cronómetro', 'cronometro'],
  ['cuadrícula', 'cuadricula'],
  ['Brígido', 'Brigido'],
  ['código', 'codigo'],
  ['página', 'pagina'],
  ['español', 'espanol'],
  ['técnica', 'tecnica'],
  ['todavía', 'todavia'],
  ['después', 'despues'],
  ['días', 'dias'],
  ['rápido', 'rapido'],
  ['mayoría', 'mayoria'],
  ['última', 'ultima'],
  ['lápiz', 'lapiz'],
  ['típico', 'tipico'],
  ['números', 'numeros'],
];

const bare = (word) =>
  new RegExp(`(?<![A-Za-zÁÉÍÓÚÜÑáéíóúüñ])${word}(?![A-Za-zÁÉÍÓÚÜÑáéíóúüñ])`, 'iu');

const text = sources.map((name) => readFileSync(join(root, name), 'utf8')).join('\n');

test('no Spanish word in the interface has lost its accent', () => {
  const offences = [];
  for (const [correct, wrong] of ACCENTED) {
    if (!text.includes(correct.toLowerCase()) && !text.includes(correct)) continue;
    if (bare(wrong).test(text)) offences.push(`${wrong} should be ${correct}`);
  }

  assert.deepEqual(
    offences,
    [],
    'a word the interface spells with an accent also appears without one. A spell checker cannot ' +
      'catch this, because the unaccented spelling is usually another real Spanish word.',
  );
});

test('the words this guard watches are still in the interface', () => {
  const missing = ACCENTED.filter(([correct]) => !bare(correct).test(text)).map(
    ([correct]) => correct,
  );

  assert.deepEqual(
    missing,
    [],
    'tests/accents.test.mjs watches words the interface no longer uses, so those entries guard ' +
      'nothing. Remove them, or restore the copy that used them.',
  );
});
