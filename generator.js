/* Puzzle generation and grading, off the main thread.

   This used to live inline in index.html, between LOGIC markers, and ran on the
   main thread. Generating a Brígido board froze the page for long enough that
   index.html carried a workaround for its own freeze: clicks made during the
   hang were dropped by comparing their timeStamp against the moment generation
   finished. That workaround is gone, and this file is why.

   It is loaded two ways and must work under both:
     - as a worker, `new Worker('./generator.js')`, which is the normal path;
     - as a plain <script>, injected by index.html only if constructing that
       worker throws, which puts window.SudokuGenerator on the page and lets the
       game generate synchronously rather than not at all.
   So nothing here may touch `document`, and the worker wiring at the bottom is
   behind a check for the worker global rather than assumed.

   Classic script, not a module. A module worker would be the tidier spelling,
   but the fallback above needs the same file to work as a <script> tag, and the
   published copy is minified by terser at its defaults, which leave the one
   exported name unmangled. */

/* Everything below is wrapped so that the generator and the page share no
   global names at all. That is not tidiness: on the fallback path this file is
   injected into the document as a plain script, and index.html declares its own
   `boxOf` and `PEERS` for highlighting the selected cell. Two classic scripts
   declaring the same const at global scope is a SyntaxError, so the fallback
   loaded a file the engine refused to run and the player got no board at all.
   One name is exported instead, and it is the only one this file adds. */
(function (root) {
  /* ---- seeded randomness ----
     Every puzzle is now a pure function of its seed, which is the point: the same
     seed rebuilds the same board on any machine, so a puzzle can be reproduced
     from a bug report and the tests can stop asserting over whatever the last run
     happened to produce. Math.random cannot do that, and it was the only source
     of randomness here before.

     mulberry32: 32 bits of state, passes the usual smoke tests for this kind of
     use, and is nine lines. Nothing here is security sensitive, so a cryptographic
     generator would buy nothing and cost the reproducibility that is the feature. */
  function rngFrom(seed) {
    let state = seed >>> 0;
    return function random() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Takes the generator rather than reaching for Math.random, which is what makes
     every shuffle below replayable. */
  function shuffle(list, random) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = (random() * (i + 1)) | 0;
      const swap = list[i];
      list[i] = list[j];
      list[j] = swap;
    }
    return list;
  }

  /* ---- board geometry ----
     Fixed for every puzzle, so it is built once at load rather than per call. */
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
  /* The 27 places a digit may appear exactly once. */
  const UNITS = [...ROWS, ...COLS, ...BOXES];

  const PEERS = [];
  for (let i = 0; i < 81; i++) {
    const set = new Set([...ROWS[(i / 9) | 0], ...COLS[i % 9], ...BOXES[boxOf(i)]]);
    set.delete(i);
    PEERS.push([...set]);
  }

  /* Candidates are a bitmask, bit d for digit d, so bit 0 is unused and the mask
     for "any of 1 to 9" is 0b1111111110. */
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

  /* Counts solutions up to `limit`, which is all any caller here needs: the only
     question ever asked is whether there is exactly one. */
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

  /* ---- grading ----
     Difficulty used to be the clue count and nothing else, which is a poor proxy:
     24 clues that fall to naked singles is an easier board than 30 that need a
     pointing pair, so "Brígido" was a promise the generator did not keep.

     So a board is graded by the hardest technique a solver needs to finish it,
     working strictly up the ladder and never guessing. The tiers are deliberately
     coarse. A finer ladder would need the solver to implement every technique it
     names, and each one it lacks silently inflates the grade of every board that
     needs it. Four tiers, with the top one meaning "more than this solver knows",
     is a claim the code can actually keep. */
  const GRADE_SINGLES = 1;
  const GRADE_LOCKED = 2;
  const GRADE_SUBSETS = 3;
  const GRADE_BEYOND = 4;

  /* The word each tier is offered under. Kept here rather than in index.html so
     the label and the technique that earns it cannot drift apart. */
  const GRADE_NAMES = {
    1: 'directas',
    2: 'bloques',
    3: 'pares',
    4: 'avanzado',
  };

  /* Solves as far as the ladder reaches, and reports the hardest rung it had to
     stand on. Returns solved:false with GRADE_BEYOND when it stalls, which is a
     statement about this solver, not about the board: the board is still uniquely
     solvable, because nothing becomes a puzzle here without countSolutions saying
     so first. */
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

    /* Naked singles (one candidate left in a cell) and hidden singles (one cell
       left for a digit in a unit). Both place a digit rather than eliminate a
       candidate, which is why they share a tier. */
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

    /* Locked candidates, both directions. Pointing: every place a digit can go
       inside a box shares one row or column, so it can go nowhere else on that
       line. Claiming: every place it can go on a line sits inside one box, so it
       can go nowhere else in that box. These only eliminate, never place. */
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

    /* Naked pairs and triples (n cells in a unit whose candidates union to n
       digits, so those digits belong to those cells and to nothing else in the
       unit) and hidden pairs (two digits in a unit that fit in only two cells, so
       those cells hold nothing else). */
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
                if (i === open[a] || i === open[b] || i === open[c] || !(cand[i] & triple)) continue;
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
        /* A cell with no candidates left cannot be filled by any technique, so
           there is nothing to be gained by carrying on. */
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

  /* The grade on its own, which is all the generator and the tests want. */
  function gradePuzzle(puzzle) {
    return solveGraded(puzzle).hardest;
  }

  /* ---- digging ---- */
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
    /* pass 1: 180-degree-symmetric pairs, walking one index per pair (0..40) so a
       rejected pair is never re-tested from its partner index */
    for (const i of shuffle([...Array(41).keys()], random)) {
      if (filled <= clues) break;
      if (i === 80 - i) tryRemove([i]);
      else if (filled - 2 >= clues) tryRemove([i, 80 - i]);
    }
    /* pass 2: single cells, to land on the clue count the dig was asked for */
    if (filled > clues) {
      for (const i of shuffle([...Array(81).keys()], random)) {
        if (filled <= clues) break;
        if (g[i] !== 0) tryRemove([i]);
      }
    }
    return { puzzle: g, solution, clues: filled };
  }

  /* Removing a clue can only take information away, so it never makes a board
     easier: this walks the remaining clues in seeded order, dropping any whose
     removal keeps the solution unique, and stops the moment the grade reaches the
     target. Bounded by the clues on the board, so it always terminates.

     `strict` is what makes the middle grades reachable. One removal can take a
     board from bloques straight past pares to avanzado, and the pares tier is
     narrow enough that stepping over it was the usual outcome: measured 9 hits in
     20 on Peludo before this existed. A strict pass refuses any removal that
     overshoots and keeps looking for one that lands, which costs a grade per
     rejected cell and finds the tier far more often. The permissive pass runs
     after it, for the boards where nothing lands and something is better than a
     board that never got harder at all. */
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
      /* Refuse a removal that steps over the target rather than taking it and
         trying to climb back. One removal can take a board from bloques straight
         past pares to avanzado, and pares is narrow enough that overshooting was
         the usual outcome: measured 9 hits in 20 on Peludo before this refusal
         existed. Rejecting costs one grade per rejected cell and keeps looking. */
      if (grade > target) {
        board.puzzle[i] = saved;
        continue;
      }
      board.clues--;
      board.grade = grade;
      record(board, target);
    }
  }

  /* The other direction. Putting a clue back can only add information, so it
     never makes a board harder, and a board with every clue showing grades at the
     bottom rung: this terminates on the target or on a full grid. Uniqueness is
     not rechecked because a cell filled with its own solution value cannot admit
     a solution the board did not already have.

     It mirrors tighten's refusal: an addition that drops the grade below the
     target is undone, so the walk down settles on the tier instead of falling
     through it and filling the board on the way. An early version without that
     refusal answered a request for Peludo with a 61 clue board graded directas. */
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

  /* Keeps the closest board the walk has stood on, rather than wherever it
     stopped. Both walks refuse to cross the target, so they can end short of it
     after having passed through something better, and the player gets the board
     that was actually closest to what they asked for. Ties break towards fewer
     clues, which is the sparser and more interesting board of the two. */
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

  /* One attempt at a board for the requested grade: dig to roughly the requested
     density, then walk the grade to the target from whichever side it landed on.

     The clue count is the starting point, not the promise. It used to be the
     promise, advertised on the difficulty buttons as "34 números", and that is
     exactly the number this has to be free to move in order to hit a grade. The
     buttons now advertise the technique instead, which is the thing the player
     actually feels. */
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

    /* Repeated rather than single, and this is not belt and braces. A removal
       rejected for overshooting is rejected against the board as it stood then,
       and every later removal changes that board, so a cell refused on one pass
       can be exactly the cell that lands on the next. Bounded by a pass that
       removes nothing, and by the count, so a board that cannot be tightened
       costs one wasted pass rather than a loop. */
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

  /* Tries whole boards until one grades exactly on target, and returns the
     closest it saw if none does. The returned grade is always the board's real
     grade, never the one that was asked for: a near miss has to be visible to the
     caller, because index.html shows the player what they are actually playing.

     Attempts are seeded off the caller's seed, so the whole search is replayable
     from the one number in the save file. */
  function makePuzzle(request) {
    const clues = request.clues;
    const target = request.grade;
    /* Sixteen, and only the misses ever spend them: the loop stops on the first
       board that grades exactly on target, so the common case is one attempt.
       Measured over 30 boards per tier, going from 8 attempts to 16 took Normal
       from 29/30 to 30/30 and Peludo from 24/30 to 28/30, for a worst case around
       115ms. Off the main thread that is invisible, and it is the difference
       between a tier that means something and one that misses one board in five. */
    const attempts = request.attempts || 16;
    const baseSeed = (request.seed === undefined ? (Math.random() * 4294967296) >>> 0 : request.seed) >>> 0;

    let best = null;
    for (let t = 0; t < attempts; t++) {
      /* The golden ratio step keeps consecutive attempts from sharing a prefix of
         the generator's state, which sequential seeds would. */
      const seed = (baseSeed + Math.imul(t, 0x9e3779b1)) >>> 0;
      const board = attemptPuzzle(clues, target, seed);
      if (best === null || Math.abs(board.grade - target) < Math.abs(best.grade - target)) {
        best = board;
      }
      if (board.grade === target) break;
    }

    return {
      puzzle: best.puzzle,
      solution: best.solution,
      clues: best.puzzle.filter((v) => v !== 0).length,
      grade: best.grade,
      gradeName: GRADE_NAMES[best.grade],
      seed: best.seed,
      /* The seed the player sees and could quote back, kept short. */
      code: best.seed.toString(36),
    };
  }

  /* ---- worker wiring ----
     Only when this file is running as a worker. Loaded as a <script> fallback it
     must define the functions above and do nothing else, and in node, where the
     tests evaluate this source directly, neither global exists. */
  if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined') {
    self.addEventListener('message', (event) => {
      const request = event.data || {};
      try {
        const result = makePuzzle(request);
        result.id = request.id;
        result.ok = true;
        self.postMessage(result);
      } catch (error) {
        /* Posted rather than thrown: index.html is waiting on a reply and an
           uncaught worker error would leave it waiting forever. */
        self.postMessage({
          id: request.id,
          ok: false,
          error: String((error && error.message) || error),
        });
      }
    });
  }

  root.SudokuGenerator = { makePuzzle, gradePuzzle, countSolutions, rngFrom, GRADE_NAMES };
})(typeof self !== "undefined" ? self : globalThis);
