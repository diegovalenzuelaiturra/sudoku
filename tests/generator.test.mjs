/* Validates the puzzle generator by evaluating generator.js itself, so the test
   exercises the shipped code rather than a copy. It used to cut the same code
   out of index.html between LOGIC markers; the generator has since moved into
   its own file so it can run in a worker, and this reads that file directly.

   Every case below is driven by an explicit seed. That is the point of seeding
   the generator: these assertions used to run against whatever the last call
   happened to produce, so a rate like "grades on target 85 percent of the time"
   could only be asserted with enough slack to never mean anything. With fixed
   seeds the same boards are built on every machine and the rate is a constant.

   Regression target, still: makePuzzle used to remove clues in 180-degree
   symmetric pairs, so parity stranded the count one below an even target while
   the compensating pass never ran. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'generator.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

/* The evaluated string is this repository's own committed generator.js, run by
   a test inside that repository's CI. Anyone able to change it could change
   this file just as easily, so evaluating it adds no attack surface, and
   running the shipped code is the whole point: a hand copied generator would
   silently drift from the one players actually run.

   generator.js exports onto whatever `self` is, so it is handed an object to
   export onto rather than being let near this process's globals. That is also
   what keeps the worker wiring at the bottom of it dormant here: it is behind a
   WorkerGlobalScope check, and node has no such thing. */
const exported = {};
new Function('self', source)(exported);
const { makePuzzle, gradePuzzle, countSolutions, GRADE_NAMES } = exported.SudokuGenerator;

/* Kept in sync with the DIFF map in index.html, which the last test here checks
   rather than trusts. `hits` is what was measured over the 24 seeds below, and
   the assertion is set at that number: with the seeds fixed there is no run to
   run variation to leave slack for, so a drop is a real regression in how often
   the search finds the tier it was asked for. */
const PRESETS = [
  { key: 'easy', label: 'Piola', clues: 40, grade: 1, hits: 24 },
  { key: 'medium', label: 'Normal', clues: 28, grade: 2, hits: 24 },
  { key: 'hard', label: 'Peludo', clues: 32, grade: 3, hits: 22 },
  { key: 'expert', label: 'Brígido', clues: 24, grade: 4, hits: 24 },
];

const SEEDS = [...Array(24).keys()].map((n) => 1000 + n * 7);

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
  test(`${preset.label} generates valid, uniquely solvable, honestly graded puzzles`, () => {
    let onTarget = 0;

    for (const seed of SEEDS) {
      const made = makePuzzle({ clues: preset.clues, grade: preset.grade, seed });

      assertCompleteValidGrid(made.solution);

      assert.equal(
        made.clues,
        made.puzzle.filter((v) => v !== 0).length,
        'the reported clue count disagrees with the board',
      );
      /* A board with fewer than 17 clues cannot have a unique solution, so this
         is a floor no correct generator can go under, and an 81 clue board is
         not a puzzle. The count is otherwise free to move: it is where the
         search starts now, not the promise, which is why nothing here pins it
         to preset.clues the way this file used to. */
      assert.ok(
        made.clues >= 17 && made.clues < 81,
        `${preset.label}: ${made.clues} clues is not a puzzle`,
      );

      for (let i = 0; i < 81; i++) {
        if (made.puzzle[i] !== 0) {
          assert.equal(made.puzzle[i], made.solution[i], `clue at ${i} contradicts the solution`);
        }
      }

      assert.equal(countSolutions(made.puzzle, 3), 1, 'puzzle is not uniquely solvable');

      /* The one assertion here with no tolerance at all. The search is allowed
         to miss the tier it aimed for, because some tiers are narrow, but it is
         never allowed to report a grade the board does not have: index.html
         shows that grade to the player as what they just solved. */
      assert.equal(
        made.grade,
        gradePuzzle(made.puzzle),
        `${preset.label}: seed ${seed} reports grade ${made.grade}, which the board does not have`,
      );

      if (made.grade === preset.grade) onTarget++;
    }

    assert.ok(
      onTarget >= preset.hits,
      `${preset.label}: landed on grade ${preset.grade} for ${onTarget} of ` +
        `${SEEDS.length} seeds, down from the ${preset.hits} measured`,
    );
  });
}

test('the same seed rebuilds the same board', () => {
  for (const preset of PRESETS) {
    const request = { clues: preset.clues, grade: preset.grade, seed: 4242 };
    const first = makePuzzle(request);
    const second = makePuzzle(request);
    assert.deepEqual(first.puzzle, second.puzzle, `${preset.label}: the seed did not reproduce`);
    assert.deepEqual(first.solution, second.solution, `${preset.label}: the solution moved`);
    assert.equal(first.grade, second.grade);
    assert.equal(first.code, second.code, 'the code shown to the player is not stable');
  }
});

test('different seeds build different boards', () => {
  /* Guards the failure a seeded generator invites: wiring a seed in but never
     threading it through, so every board comes out identical. */
  const boards = SEEDS.slice(0, 6).map((seed) =>
    JSON.stringify(makePuzzle({ clues: 28, grade: 2, seed }).puzzle),
  );
  assert.equal(new Set(boards).size, boards.length, 'two seeds produced the same board');
});

test('a board is graded by technique, not by how many clues it shows', () => {
  /* The claim the grading exists to make. Difficulty used to be the clue count
     and nothing else, so this looks for the case that arrangement could not
     represent: the same number of clues on the board, and a different technique
     needed to finish it.

     Measured over the seeds below, seven different clue counts turn up at both
     bloques and pares, so this is not a lucky coincidence being pinned down. */
  const seen = new Map();
  for (const grade of [2, 3]) {
    const clues = new Set();
    for (const seed of SEEDS) {
      const made = makePuzzle({ clues: 28, grade, seed });
      if (made.grade === grade) clues.add(made.clues);
    }
    seen.set(grade, clues);
  }

  const shared = [...seen.get(2)].filter((c) => seen.get(3).has(c));
  assert.ok(
    shared.length > 0,
    'no clue count produced both a bloques board and a pares board, so on this ' +
      'evidence the clue count would still explain the difficulty',
  );
});

test('the grade words index.html shows come from the generator', () => {
  /* index.html is inline and generator.js has to run in a worker, so the table
     is written twice. This is what stops the two drifting: a tier renamed in
     one and not the other would put a word on the difficulty buttons that no
     board is ever graded with. */
  const literal = html.match(/const GRADE_WORDS=\{([^}]*)\}/);
  assert.ok(literal, 'GRADE_WORDS is not where this test expects to find it');

  const shown = {};
  for (const [, key, word] of literal[1].matchAll(/(\d+):'([^']+)'/g)) shown[key] = word;

  assert.deepEqual(shown, GRADE_NAMES, 'the grade words in index.html and generator.js disagree');
  assert.equal(Object.keys(shown).length, 4, 'there are not four tiers any more');
});

test('every difficulty asks for a grade, and harder ones ask for more', () => {
  const literal = html.match(/const DIFF=\{(.+)\};/);
  assert.ok(literal, 'the DIFF table is not where this test expects to find it');

  const rows = new Map();
  for (const [, key, body] of literal[1].matchAll(/(\w+):\{([^}]*)\}/g)) {
    const grade = body.match(/grade:(\d+)/);
    const clues = body.match(/clues:(\d+)/);
    rows.set(key, {
      grade: grade === null ? null : Number(grade[1]),
      clues: clues === null ? null : Number(clues[1]),
    });
  }

  assert.deepEqual(
    [...rows.keys()],
    PRESETS.map((p) => p.key),
    'the difficulties are not the four this file was measured against',
  );
  for (const preset of PRESETS) {
    const row = rows.get(preset.key);
    assert.equal(row.grade, preset.grade, `${preset.label} no longer asks for grade ${preset.grade}`);
    assert.equal(row.clues, preset.clues, `${preset.label} starts its search somewhere else now`);
    assert.ok(GRADE_NAMES[row.grade], `${preset.label} asks for a grade with no name`);
  }

  const grades = PRESETS.map((p) => rows.get(p.key).grade);
  for (let i = 1; i < grades.length; i++) {
    assert.ok(grades[i] > grades[i - 1], 'the difficulties do not ask for increasing grades');
  }
});
