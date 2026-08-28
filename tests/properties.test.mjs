/* tests/generator.test.mjs drives 24 seeds per tier, chosen once and written
   down, and that is the right shape for the assertions it makes: with the seeds
   fixed, a rate like "lands on target 22 of 24 times" is a constant, and a drop
   in it is a regression rather than a bad afternoon.

   What fixed seeds cannot do is look anywhere else. Every board that suite has
   ever judged comes from 96 of the 4294967296 seeds the generator accepts, so a
   fault that needs a different one is invisible and stays invisible, because
   the same 96 run again tomorrow. These properties say what must hold for any
   seed at all and let fast-check go looking, which is the complement of the
   file next door rather than a replacement for it.

   Run counts are deliberately small. Building a board is milliseconds of real
   search, not microseconds, so this is priced to stay inside the suite the
   hooks run on every commit. */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
require(join(root, 'generator.js'));
const { makePuzzle, gradePuzzle, countSolutions, GRADE_NAMES } = globalThis.SudokuGenerator;
delete globalThis.SudokuGenerator;

/* The whole 32 bit space the generator documents, not a friendly corner of it.
   fast-check shrinks a failure towards zero, so a report names the smallest
   seed that still breaks. */
const seed = fc.integer({ min: 0, max: 4294967295 });
const preset = fc.constantFrom(
  { clues: 40, grade: 1 },
  { clues: 28, grade: 2 },
  { clues: 32, grade: 3 },
  { clues: 24, grade: 4 },
);

const boxOf = (i) => ((((i / 9) | 0) / 3) | 0) * 3 + (((i % 9) / 3) | 0);

test('a seed always rebuilds the same board', () => {
  /* The promise the code shown at the end of a game makes to the player. */
  fc.assert(
    fc.property(seed, preset, (s, p) => {
      const first = makePuzzle({ clues: p.clues, grade: p.grade, seed: s });
      const second = makePuzzle({ clues: p.clues, grade: p.grade, seed: s });
      assert.deepEqual(first.puzzle, second.puzzle);
      assert.deepEqual(first.solution, second.solution);
      assert.equal(first.grade, second.grade);
    }),
    { numRuns: 40 },
  );
});

test('every board is a legal grid with exactly one solution', () => {
  fc.assert(
    fc.property(seed, preset, (s, p) => {
      const made = makePuzzle({ clues: p.clues, grade: p.grade, seed: s });

      for (let i = 0; i < 81; i++) {
        if (made.puzzle[i] !== 0) {
          assert.equal(
            made.puzzle[i],
            made.solution[i],
            `the clue at ${i} contradicts the solution`,
          );
        }
      }

      /* A second solution makes the board a guess, and the mistake counter
         punishes a player for a digit that was never wrong. */
      assert.equal(countSolutions(made.puzzle, 3), 1, `seed ${s} is not uniquely solvable`);

      const rows = Array.from({ length: 9 }, () => new Set());
      const cols = Array.from({ length: 9 }, () => new Set());
      const boxes = Array.from({ length: 9 }, () => new Set());
      for (let i = 0; i < 81; i++) {
        const v = made.solution[i];
        assert.ok(v >= 1 && v <= 9, `the solution holds ${v} at ${i}`);
        rows[(i / 9) | 0].add(v);
        cols[i % 9].add(v);
        boxes[boxOf(i)].add(v);
      }
      for (let u = 0; u < 9; u++) {
        assert.equal(rows[u].size, 9, `row ${u} repeats a digit`);
        assert.equal(cols[u].size, 9, `column ${u} repeats a digit`);
        assert.equal(boxes[u].size, 9, `box ${u} repeats a digit`);
      }
    }),
    { numRuns: 25 },
  );
});

test('the grade reported is the grade measured, and it is a grade that has a name', () => {
  /* The search is allowed to miss the tier it was asked for. It is not allowed
     to misreport what it found: the player is told the truth about the board
     in front of them, whichever tier it landed on. */
  fc.assert(
    fc.property(seed, preset, (s, p) => {
      const made = makePuzzle({ clues: p.clues, grade: p.grade, seed: s });
      assert.equal(
        made.grade,
        gradePuzzle(made.puzzle),
        `seed ${s} reports a grade it does not have`,
      );
      assert.ok(
        Object.hasOwn(GRADE_NAMES, made.grade),
        `seed ${s} reports grade ${made.grade}, which no label covers`,
      );
    }),
    { numRuns: 30 },
  );
});

test('the clue count is the count of clues, and it leaves a puzzle', () => {
  /* Seventeen is the proven floor for a uniquely solvable sudoku, so anything
     under it is a board that cannot be what it claims. */
  fc.assert(
    fc.property(seed, preset, (s, p) => {
      const made = makePuzzle({ clues: p.clues, grade: p.grade, seed: s });
      assert.equal(made.clues, made.puzzle.filter((v) => v !== 0).length);
      assert.ok(made.clues >= 17 && made.clues < 81, `seed ${s} produced ${made.clues} clues`);
    }),
    { numRuns: 30 },
  );
});
