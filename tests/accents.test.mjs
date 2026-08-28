/* The half of Spanish spelling a spell checker structurally cannot see.

   cspell reads a word against a dictionary, and in Spanish the unaccented form
   of an accented word is very often another real word: numero is a verb, esta
   is a demonstrative, papa is not papá. Both spellings are in the dictionary,
   so both pass, and the reader gets the wrong one. Accents are also the first
   thing lost to a keyboard layout, a copy paste through a lossy tool, or an
   editor that saved as latin-1 and back.

   So this does the opposite of a dictionary lookup. It takes the words this
   interface actually uses, in the spelling it actually uses, and asserts the
   unaccented form never appears in player-facing text. The list is built from
   the copy rather than from a grammar, and every entry is a word whose bare
   form would be wrong here even though it is a word somewhere.

   Deliberately not a general rule about Spanish. mas, si, tu, el and solo are
   all correct unaccented in ordinary prose, so a checker that flagged them
   would be wrong more often than right and would be switched off. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const sources = ['index.html', 'app.js', '404.html'];

/* Each pair is [the spelling this interface uses, the spelling that must never
   appear]. Two filters decide what belongs here, and both were learned by
   running it.

   The bare form must not be right in Spanish: numero is dropped, because "yo
   numero" is a sentence, while the plural numeros is never right and stays.

   The bare form must also not be an English word, because the comments and the
   identifiers in these files are English and they are in the same text. That
   rules out récord and versión: this repository says version dozens of times,
   correctly, in English, and a guard that failed on those would be deleted
   within a day. cspell covers the English half; this covers the Spanish half
   it cannot see. */
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

/* Read as words, so "record" inside "recordStatus" or an English comment about
   a record is not a Spanish accent that went missing. The boundary either side
   is what makes this usable at all. */
const bare = (word) =>
  new RegExp(`(?<![A-Za-zÁÉÍÓÚÜÑáéíóúüñ])${word}(?![A-Za-zÁÉÍÓÚÜÑáéíóúüñ])`, 'iu');

const text = sources.map((name) => readFileSync(join(root, name), 'utf8')).join('\n');

test('no Spanish word in the interface has lost its accent', () => {
  const offences = [];
  for (const [correct, wrong] of ACCENTED) {
    /* English prose in the comments legitimately uses some of these letters in
       a row. The pair is only interesting when the accented spelling is also
       present, which is what says the word belongs to the Spanish copy. */
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
  /* A list that has drifted out of the copy reports zero forever, which reads
     exactly like a clean check. This is what tells the two apart. */
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
