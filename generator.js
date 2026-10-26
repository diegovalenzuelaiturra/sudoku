(function (root) {
  function rngFrom(seed) {
    let state = seed >>> 0;
    return function random() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(list, random) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = (random() * (i + 1)) | 0;
      const swap = list[i];
      list[i] = list[j];
      list[j] = swap;
    }
    return list;
  }

  const boxOf = (i) => ((((i / 9) | 0) / 3) | 0) * 3 + (((i % 9) / 3) | 0);

  const ROWS = [];
  const COLS = [];
  const BOXES = [];
  for (let u = 0; u < 9; u++) {
    ROWS.push([]);
    COLS.push([]);
    BOXES.push([]);
  }
  for (let i = 0; i < 81; i++) {
    ROWS[(i / 9) | 0].push(i);
    COLS[i % 9].push(i);
    BOXES[boxOf(i)].push(i);
  }
  const UNITS = [...ROWS, ...COLS, ...BOXES];

  const PEERS = [];
  for (let i = 0; i < 81; i++) {
    const set = new Set([...ROWS[(i / 9) | 0], ...COLS[i % 9], ...BOXES[boxOf(i)]]);
    set.delete(i);
    PEERS.push([...set]);
  }

  const ALL = 0b1111111110;
  const bitCount = (mask) => {
    let n = 0;
    let m = mask;
    while (m) {
      m &= m - 1;
      n++;
    }
    return n;
  };
  const firstDigit = (mask) => {
    let d = 1;
    while (d <= 9 && !(mask & (1 << d))) d++;
    return d;
  };

  function generateFull(random) {
    const grid = new Array(81).fill(0);
    const rows = new Array(9).fill(0);
    const cols = new Array(9).fill(0);
    const boxes = new Array(9).fill(0);
    function fill(i) {
      if (i === 81) return true;
      const r = (i / 9) | 0;
      const c = i % 9;
      const b = boxOf(i);
      for (const d of shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9], random)) {
        const bit = 1 << d;
        if ((rows[r] | cols[c] | boxes[b]) & bit) continue;
        grid[i] = d;
        rows[r] |= bit;
        cols[c] |= bit;
        boxes[b] |= bit;
        if (fill(i + 1)) return true;
        grid[i] = 0;
        rows[r] ^= bit;
        cols[c] ^= bit;
        boxes[b] ^= bit;
      }
      return false;
    }
    fill(0);
    return grid;
  }

  function countSolutions(grid, limit) {
    const rows = new Array(9).fill(0);
    const cols = new Array(9).fill(0);
    const boxes = new Array(9).fill(0);
    const empties = [];
    for (let i = 0; i < 81; i++) {
      const v = grid[i];
      const r = (i / 9) | 0;
      const c = i % 9;
      const b = boxOf(i);
      if (v) {
        const bit = 1 << v;
        if ((rows[r] | cols[c] | boxes[b]) & bit) return 0;
        rows[r] |= bit;
        cols[c] |= bit;
        boxes[b] |= bit;
      } else empties.push(i);
    }
    let count = 0;
    function dfs(k) {
      if (count >= limit) return;
      if (k === empties.length) {
        count++;
        return;
      }
      let best = k;
      let bestN = 10;
      for (let j = k; j < empties.length; j++) {
        const i = empties[j];
        const used = rows[(i / 9) | 0] | cols[i % 9] | boxes[boxOf(i)];
        let n = 0;
        for (let d = 1; d <= 9; d++) if (!(used & (1 << d))) n++;
        if (n < bestN) {
          bestN = n;
          best = j;
          if (n <= 1) break;
        }
      }
      const swap = empties[k];
      empties[k] = empties[best];
      empties[best] = swap;
      const i = empties[k];
      const r = (i / 9) | 0;
      const c = i % 9;
      const b = boxOf(i);
      const used = rows[r] | cols[c] | boxes[b];
      for (let d = 1; d <= 9; d++) {
        const bit = 1 << d;
        if (used & bit) continue;
        rows[r] |= bit;
        cols[c] |= bit;
        boxes[b] |= bit;
        dfs(k + 1);
        rows[r] ^= bit;
        cols[c] ^= bit;
        boxes[b] ^= bit;
        if (count >= limit) break;
      }
      empties[best] = empties[k];
      empties[k] = swap;
    }
    dfs(0);
    return count;
  }

  const GRADE_SINGLES = 1;
  const GRADE_LOCKED = 2;
  const GRADE_SUBSETS = 3;
  const GRADE_BEYOND = 4;

  const GRADE_NAMES = {
    1: 'directas',
    2: 'bloques',
    3: 'pares',
    4: 'avanzado',
  };

  function solveGraded(puzzle) {
    const values = puzzle.slice();
    const cand = new Array(81).fill(0);
    let left = 0;
    for (let i = 0; i < 81; i++) {
      if (values[i]) continue;
      left++;
      let mask = ALL;
      for (const p of PEERS[i]) if (values[p]) mask &= ~(1 << values[p]);
      cand[i] = mask;
    }

    let hardest = 0;

    function place(i, d) {
      values[i] = d;
      cand[i] = 0;
      for (const p of PEERS[i]) cand[p] &= ~(1 << d);
      left--;
    }

    function singles() {
      let did = false;
      for (let i = 0; i < 81; i++) {
        if (!values[i] && bitCount(cand[i]) === 1) {
          place(i, firstDigit(cand[i]));
          did = true;
        }
      }
      if (did) return true;
      for (const unit of UNITS) {
        for (let d = 1; d <= 9; d++) {
          const bit = 1 << d;
          let spot = -1;
          let n = 0;
          let taken = false;
          for (const i of unit) {
            if (values[i] === d) {
              taken = true;
              break;
            }
            if (!values[i] && cand[i] & bit) {
              spot = i;
              n++;
            }
          }
          if (!taken && n === 1) {
            place(spot, d);
            did = true;
          }
        }
      }
      return did;
    }

    function locked() {
      let did = false;
      for (let d = 1; d <= 9; d++) {
        const bit = 1 << d;
        for (let b = 0; b < 9; b++) {
          const spots = BOXES[b].filter((i) => !values[i] && cand[i] & bit);
          if (spots.length < 2) continue;
          const rows = new Set(spots.map((i) => (i / 9) | 0));
          const cols = new Set(spots.map((i) => i % 9));
          const line =
            rows.size === 1 ? ROWS[[...rows][0]] : cols.size === 1 ? COLS[[...cols][0]] : null;
          if (line === null) continue;
          for (const i of line) {
            if (boxOf(i) === b || values[i] || !(cand[i] & bit)) continue;
            cand[i] &= ~bit;
            did = true;
          }
        }
        for (const line of [...ROWS, ...COLS]) {
          const spots = line.filter((i) => !values[i] && cand[i] & bit);
          if (spots.length < 2) continue;
          const boxes = new Set(spots.map((i) => boxOf(i)));
          if (boxes.size !== 1) continue;
          const b = [...boxes][0];
          for (const i of BOXES[b]) {
            if (line.includes(i) || values[i] || !(cand[i] & bit)) continue;
            cand[i] &= ~bit;
            did = true;
          }
        }
      }
      return did;
    }

    function subsets() {
      let did = false;
      for (const unit of UNITS) {
        const open = unit.filter((i) => !values[i]);

        for (let a = 0; a < open.length; a++) {
          for (let b = a + 1; b < open.length; b++) {
            const pair = cand[open[a]] | cand[open[b]];
            if (bitCount(pair) === 2) {
              for (const i of open) {
                if (i === open[a] || i === open[b] || !(cand[i] & pair)) continue;
                cand[i] &= ~pair;
                did = true;
              }
            }
            for (let c = b + 1; c < open.length; c++) {
              const triple = pair | cand[open[c]];
              if (bitCount(triple) !== 3) continue;
              for (const i of open) {
                if (i === open[a] || i === open[b] || i === open[c] || !(cand[i] & triple))
                  continue;
                cand[i] &= ~triple;
                did = true;
              }
            }
          }
        }

        for (let d1 = 1; d1 <= 9; d1++) {
          for (let d2 = d1 + 1; d2 <= 9; d2++) {
            const pair = (1 << d1) | (1 << d2);
            const spots = open.filter((i) => cand[i] & pair);
            if (spots.length !== 2) continue;
            if (!(cand[spots[0]] & (1 << d1)) || !(cand[spots[0]] & (1 << d2))) continue;
            if (!(cand[spots[1]] & (1 << d1)) || !(cand[spots[1]] & (1 << d2))) continue;
            for (const i of spots) {
              if (cand[i] === pair) continue;
              cand[i] &= pair;
              did = true;
            }
          }
        }
      }
      return did;
    }

    while (left > 0) {
      for (let i = 0; i < 81; i++) {
        if (!values[i] && cand[i] === 0) return { solved: false, hardest: GRADE_BEYOND };
      }
      if (singles()) {
        hardest = Math.max(hardest, GRADE_SINGLES);
        continue;
      }
      if (locked()) {
        hardest = Math.max(hardest, GRADE_LOCKED);
        continue;
      }
      if (subsets()) {
        hardest = Math.max(hardest, GRADE_SUBSETS);
        continue;
      }
      return { solved: false, hardest: GRADE_BEYOND };
    }
    return { solved: true, hardest: hardest || GRADE_SINGLES };
  }

  function gradePuzzle(puzzle) {
    return solveGraded(puzzle).hardest;
  }

  function dig(clues, random) {
    const solution = generateFull(random);
    const g = solution.slice();
    let filled = 81;
    function tryRemove(cells) {
      const saved = cells.map((i) => g[i]);
      for (const i of cells) g[i] = 0;
      if (countSolutions(g, 2) !== 1) {
        cells.forEach((i, k) => {
          g[i] = saved[k];
        });
        return false;
      }
      filled -= cells.length;
      return true;
    }
    for (const i of shuffle([...Array(41).keys()], random)) {
      if (filled <= clues) break;
      if (i === 80 - i) tryRemove([i]);
      else if (filled - 2 >= clues) tryRemove([i, 80 - i]);
    }
    if (filled > clues) {
      for (const i of shuffle([...Array(81).keys()], random)) {
        if (filled <= clues) break;
        if (g[i] !== 0) tryRemove([i]);
      }
    }
    return { puzzle: g, solution, clues: filled };
  }

  function tighten(board, target) {
    const order = shuffle(
      [...Array(81).keys()].filter((i) => board.puzzle[i] !== 0),
      board.random,
    );
    for (const i of order) {
      if (board.grade >= target) return;
      const saved = board.puzzle[i];
      board.puzzle[i] = 0;
      if (countSolutions(board.puzzle, 2) !== 1) {
        board.puzzle[i] = saved;
        continue;
      }
      const grade = gradePuzzle(board.puzzle);
      if (grade > target) {
        board.puzzle[i] = saved;
        continue;
      }
      board.clues--;
      board.grade = grade;
      record(board, target);
    }
  }

  function loosen(board, target) {
    const order = shuffle(
      [...Array(81).keys()].filter((i) => board.puzzle[i] === 0),
      board.random,
    );
    for (const i of order) {
      if (board.grade <= target) return;
      board.puzzle[i] = board.solution[i];
      const grade = gradePuzzle(board.puzzle);
      if (grade < target) {
        board.puzzle[i] = 0;
        continue;
      }
      board.clues++;
      board.grade = grade;
      record(board, target);
    }
  }

  function record(board, target) {
    const distance = Math.abs(board.grade - target);
    if (
      board.best === null ||
      distance < board.bestDistance ||
      (distance === board.bestDistance && board.clues < board.best.clues)
    ) {
      board.best = { puzzle: board.puzzle.slice(), clues: board.clues, grade: board.grade };
      board.bestDistance = distance;
    }
  }

  function attemptPuzzle(clues, target, seed) {
    const random = rngFrom(seed);
    const dug = dig(clues, random);
    const board = {
      puzzle: dug.puzzle,
      solution: dug.solution,
      clues: dug.clues,
      grade: gradePuzzle(dug.puzzle),
      best: null,
      bestDistance: Infinity,
      random,
      seed,
    };
    record(board, target);

    for (let pass = 0; pass < 3 && board.grade < target; pass++) {
      const before = board.clues;
      tighten(board, target);
      if (board.clues === before) break;
    }
    if (board.grade > target) loosen(board, target);

    return {
      puzzle: board.best.puzzle,
      solution: board.solution,
      clues: board.best.clues,
      grade: board.best.grade,
      seed,
    };
  }

  function makePuzzle(request) {
    const clues = request.clues;
    const target = request.grade;
    const attempts = request.attempts || 16;
    const searchSeed =
      (request.seed === undefined ? (Math.random() * 4294967296) >>> 0 : request.seed) >>> 0;

    let best = null;
    for (let t = 0; t < attempts; t++) {
      const attemptSeed = (searchSeed + Math.imul(t, 0x9e3779b1)) >>> 0;
      const board = attemptPuzzle(clues, target, attemptSeed);
      if (best === null || Math.abs(board.grade - target) < Math.abs(best.grade - target)) {
        best = board;
      }
      if (board.grade === target) break;
    }

    return {
      puzzle: best.puzzle,
      solution: best.solution,
      clues: best.clues,
      grade: best.grade,
      gradeName: GRADE_NAMES[best.grade],
      seed: searchSeed,
      code: searchSeed.toString(36),
    };
  }

  if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined') {
    self.addEventListener('message', (event) => {
      const request = event.data || {};
      try {
        const result = makePuzzle(request);
        result.id = request.id;
        result.ok = true;
        self.postMessage(result);
      } catch (error) {
        self.postMessage({
          id: request.id,
          ok: false,
          error: String(error?.message || error),
        });
      }
    });
  }

  root.SudokuGenerator = { makePuzzle, gradePuzzle, countSolutions, rngFrom, GRADE_NAMES };
})(typeof self !== 'undefined' ? self : globalThis);
