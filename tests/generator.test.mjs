/* Validates the puzzle generator by extracting the LOGIC section straight out of
   index.html, so the test exercises the shipped code rather than a copy.

   Regression target: makePuzzle used to remove clues in 180-degree-symmetric
   pairs, so parity stranded the count one below an even target while the
   compensating pass never ran. Piola advertised 40 clues and shipped 39 about
   two thirds of the time. The clue-count assertions below fail on that bug. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

const lines = html.split('\n');
const start = lines.findIndex((l) => l.includes('LOGIC') && l.includes('====='));
const end = lines.findIndex((l) => l.includes('END LOGIC'));
assert.ok(start !== -1 && end > start, 'could not locate the LOGIC section in index.html');

/* The evaluated string is this repository's own committed index.html, run by a
   test inside that repository's CI. Anyone able to change it could change this
   file just as easily, so evaluating it adds no attack surface - and extracting
   the shipped code is the whole point: a hand-copied generator would silently
   drift from the one users actually run. */
const logic = lines.slice(start, end + 1).join('\n');
const { makePuzzle, countSolutions } = new Function(
  `${logic}\nreturn { makePuzzle, countSolutions };`,
)();

/* Kept in sync with the DIFF map in index.html. */
const PRESETS = [
  { key: 'easy', label: 'Piola', clues: 40 },
  { key: 'medium', label: 'Normal', clues: 34 },
  { key: 'hard', label: 'Peludo', clues: 28 },
  { key: 'expert', label: 'Brígido', clues: 24 },
];

const SAMPLES = 50;
/* Digging is greedy, so the sparsest preset occasionally settles one clue above
   target even after the bounded retry. Measured: 100/100/100/96 percent exact. */
const MIN_EXACT_RATE = 0.85;
const MAX_OVERSHOOT = 2;

const boxOf = (i) => ((((i / 9) | 0) / 3) | 0) * 3 + (((i % 9) / 3) | 0);

function assertCompleteValidGrid(solution) {
  const rows = [];
  const cols = [];
  const boxes = [];
  for (let i = 0; i < 9; i++) {
    rows.push(new Set());
    cols.push(new Set());
    boxes.push(new Set());
  }
  for (let i = 0; i < 81; i++) {
    const v = solution[i];
    assert.ok(v >= 1 && v <= 9, `solution cell ${i} is not 1-9`);
    const r = (i / 9) | 0;
    const c = i % 9;
    const b = boxOf(i);
    assert.ok(!rows[r].has(v), `solution repeats ${v} in row ${r}`);
    assert.ok(!cols[c].has(v), `solution repeats ${v} in column ${c}`);
    assert.ok(!boxes[b].has(v), `solution repeats ${v} in box ${b}`);
    rows[r].add(v);
    cols[c].add(v);
    boxes[b].add(v);
  }
}

for (const preset of PRESETS) {
  test(`${preset.label} (${preset.clues} clues) generates valid, uniquely solvable puzzles`, () => {
    let exact = 0;

    for (let n = 0; n < SAMPLES; n++) {
      const { puzzle, solution, clues } = makePuzzle(preset.clues);
      const actual = puzzle.filter((v) => v !== 0).length;

      assert.equal(actual, clues, 'reported clue count disagrees with the board');

      /* Never fewer clues than advertised - that is the parity bug's signature. */
      assert.ok(
        actual >= preset.clues,
        `${preset.label}: ${actual} clues, fewer than the advertised ${preset.clues}`,
      );
      assert.ok(
        actual <= preset.clues + MAX_OVERSHOOT,
        `${preset.label}: ${actual} clues, more than ${preset.clues + MAX_OVERSHOOT}`,
      );
      if (actual === preset.clues) exact++;

      assertCompleteValidGrid(solution);

      for (let i = 0; i < 81; i++) {
        if (puzzle[i] !== 0) {
          assert.equal(puzzle[i], solution[i], `clue at ${i} contradicts the solution`);
        }
      }

      assert.equal(countSolutions(puzzle, 3), 1, 'puzzle is not uniquely solvable');
    }

    const rate = exact / SAMPLES;
    assert.ok(
      rate >= MIN_EXACT_RATE,
      `${preset.label}: only ${(rate * 100).toFixed(1)}% of puzzles hit exactly ` +
        `${preset.clues} clues (need ${MIN_EXACT_RATE * 100}%)`,
    );
  });
}
