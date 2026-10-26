import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
require(join(root, 'generator.js'));
const { makePuzzle } = globalThis.SudokuGenerator;
delete globalThis.SudokuGenerator;

const UNITS = [];
for (let r = 0; r < 9; r++) UNITS.push(Array.from({ length: 9 }, (_, c) => r * 9 + c));
for (let c = 0; c < 9; c++) UNITS.push(Array.from({ length: 9 }, (_, r) => r * 9 + c));
for (let b = 0; b < 9; b++) {
  const top = Math.floor(b / 3) * 27 + (b % 3) * 3;
  const box = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) box.push(top + r * 9 + c);
  UNITS.push(box);
}

const PEERS = Array.from({ length: 81 }, (_, i) => {
  const peers = new Set();
  for (const unit of UNITS) {
    if (!unit.includes(i)) continue;
    for (const j of unit) if (j !== i) peers.add(j);
  }
  return peers;
});

const candidates = (cells, i) => {
  const taken = new Set();
  for (const p of PEERS[i]) if (cells[p] !== 0) taken.add(cells[p]);
  const open = new Set();
  for (let d = 1; d <= 9; d++) if (!taken.has(d)) open.add(d);
  return open;
};

// MUST KILL: the full board check has to run before the placement pass, so the loop shape is order dependent; restructure as a loop while empty cells remain
function singlesAloneSolve(puzzle) {
  const cells = Array.from(puzzle, (v) => v || 0);

  for (;;) {
    if (cells.every((v) => v !== 0)) return true;

    let placed = false;

    for (let i = 0; i < 81; i++) {
      if (cells[i] !== 0) continue;
      const open = candidates(cells, i);
      if (open.size === 0) return false;
      if (open.size === 1) {
        cells[i] = [...open][0];
        placed = true;
      }
    }
    if (placed) continue;

    for (const unit of UNITS) {
      for (let d = 1; d <= 9; d++) {
        if (unit.some((i) => cells[i] === d)) continue;
        const spots = unit.filter((i) => cells[i] === 0 && candidates(cells, i).has(d));
        if (spots.length === 0) return false;
        if (spots.length === 1) {
          cells[spots[0]] = d;
          placed = true;
        }
      }
    }
    if (!placed) return false;
  }
}

const SEEDS = [...Array(24).keys()].map((n) => 1000 + n * 7);
const PRESETS = [
  { label: 'Piola', clues: 40, grade: 1 },
  { label: 'Normal', clues: 28, grade: 2 },
  { label: 'Peludo', clues: 32, grade: 3 },
  { label: 'Brígido', clues: 24, grade: 4 },
];

const boards = [];
for (const preset of PRESETS) {
  for (const seed of SEEDS) {
    boards.push({
      preset,
      seed,
      made: makePuzzle({ clues: preset.clues, grade: preset.grade, seed }),
    });
  }
}

test('a board offered as directas is one an independent solver finishes with singles', () => {
  const offences = [];
  for (const { preset, seed, made } of boards) {
    if (made.grade !== 1) continue;
    if (!singlesAloneSolve(made.puzzle)) {
      offences.push(`${preset.label} seed ${seed}`);
    }
  }

  assert.deepEqual(
    offences,
    [],
    'a board graded 1 stalls a naked and hidden singles solver, so the player is promised a ' +
      'board that needs no technique and handed one that does',
  );
});

test('a board offered above directas is one singles alone cannot finish', () => {
  const offences = [];
  for (const { preset, seed, made } of boards) {
    if (made.grade < 2) continue;
    if (singlesAloneSolve(made.puzzle)) {
      offences.push(`${preset.label} seed ${seed} graded ${made.grade}`);
    }
  }

  assert.deepEqual(
    offences,
    [],
    'a board graded above directas is finished by naked and hidden singles alone, so its grade ' +
      'overstates what it asks of the player. Check that every rung of the ladder in ' +
      'generator.js still runs.',
  );
});
