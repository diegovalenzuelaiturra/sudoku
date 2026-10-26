import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const app = readFileSync(join(root, 'app.js'), 'utf8');

const require = createRequire(import.meta.url);
require(join(root, 'generator.js'));
const { makePuzzle, gradePuzzle, countSolutions, GRADE_NAMES } = globalThis.SudokuGenerator;
delete globalThis.SudokuGenerator;

const PRESETS = [
  { key: 'easy', label: 'Piola', clues: 40, grade: 1, hits: 24 },
  { key: 'medium', label: 'Normal', clues: 28, grade: 2, hits: 24 },
  { key: 'hard', label: 'Peludo', clues: 32, grade: 3, hits: 22 },
  { key: 'expert', label: 'Brígido', clues: 24, grade: 4, hits: 24 },
];

const SEEDS = [...Array(24).keys()].map((n) => 1000 + n * 7);
const MIN_UNIQUE_CLUES = 17;

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
      assert.ok(
        made.clues >= MIN_UNIQUE_CLUES && made.clues < 81,
        `${preset.label}: ${made.clues} clues is not a puzzle`,
      );

      for (let i = 0; i < 81; i++) {
        if (made.puzzle[i] !== 0) {
          assert.equal(made.puzzle[i], made.solution[i], `clue at ${i} contradicts the solution`);
        }
      }

      assert.equal(countSolutions(made.puzzle, 3), 1, 'puzzle is not uniquely solvable');

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
  const boards = SEEDS.slice(0, 6).map((seed) =>
    JSON.stringify(makePuzzle({ clues: 28, grade: 2, seed }).puzzle),
  );
  assert.equal(new Set(boards).size, boards.length, 'two seeds produced the same board');
});

test('a board is graded by technique, not by how many clues it shows', () => {
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

test('the grade words the game shows come from the generator', () => {
  const literal = app.match(/const GRADE_WORDS\s*=\s*\{([^}]*)\}/u);
  assert.ok(literal, 'GRADE_WORDS is not where this test expects to find it');

  const shown = {};
  for (const [, key, word] of literal[1].matchAll(/(\d+):\s*'([^']+)'/gu)) shown[key] = word;

  assert.deepEqual(shown, GRADE_NAMES, 'the grade words in app.js and generator.js disagree');
  assert.equal(Object.keys(shown).length, 4, 'there are not four tiers any more');
});

test('every difficulty asks for a grade, and harder ones ask for more', () => {
  const literal = app.match(/const DIFF\s*=\s*\{([\s\S]*?)\n\};/u);
  assert.ok(literal, 'the DIFF table is not where this test expects to find it');

  const rows = new Map();
  for (const [, key, body] of literal[1].matchAll(/(\w+):\s*\{([^}]*)\}/gu)) {
    const grade = body.match(/grade:\s*(\d+)/u);
    const clues = body.match(/clues:\s*(\d+)/u);
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
    assert.equal(
      row.grade,
      preset.grade,
      `${preset.label} no longer asks for grade ${preset.grade}`,
    );
    assert.equal(row.clues, preset.clues, `${preset.label} starts its search somewhere else now`);
    assert.ok(GRADE_NAMES[row.grade], `${preset.label} asks for a grade with no name`);
  }

  const grades = PRESETS.map((p) => rows.get(p.key).grade);
  for (let i = 1; i < grades.length; i++) {
    assert.ok(grades[i] > grades[i - 1], 'the difficulties do not ask for increasing grades');
  }
});
