import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';

const root = join(import.meta.dirname, '..');
const appSource = readFileSync(join(root, 'app.js'), 'utf8');
const statsSource = readFileSync(join(root, 'stats.js'), 'utf8');

const require = createRequire(import.meta.url);
require(join(root, 'generator.js'));
const { makePuzzle } = globalThis.SudokuGenerator;
delete globalThis.SudokuGenerator;

const BOARD = makePuzzle({ clues: 40, grade: 1, seed: 1000 });
const SAVE = 'sudoku:save';
const WALLET = 'sudoku:wallet';
const FAILURE_COPY = 'No se pudo armar el tablero. Prueba de nuevo.';

class ClassList {
  constructor() {
    this.names = new Set();
  }
  add(...names) {
    for (const name of names) this.names.add(name);
  }
  remove(...names) {
    for (const name of names) this.names.delete(name);
  }
  toggle(name, force) {
    const on = force === undefined ? !this.names.has(name) : Boolean(force);
    if (on) this.names.add(name);
    else this.names.delete(name);
    return on;
  }
  contains(name) {
    return this.names.has(name);
  }
}

function boot({ storage = new Map(), hidden = false, wakeLock } = {}) {
  const store = new Map(storage);
  const writes = [];
  const timers = { timeouts: [], intervals: 0, frames: 0 };
  const listeners = {};
  const byId = new Map();
  const bySelector = new Map();
  const doc = {
    hidden,
    activeElement: null,
    htmlWrites: [],
    head: null,
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new El(id));
      return byId.get(id);
    },
    querySelector(selector) {
      if (!bySelector.has(selector)) bySelector.set(selector, new El(selector));
      return bySelector.get(selector);
    },
    querySelectorAll: () => [],
    createElement: (tag) => new El(tag),
    addEventListener(type, fn) {
      listeners[type] = [...(listeners[type] ?? []), fn];
    },
  };

  class El {
    constructor(name) {
      this.name = name;
      this.classList = new ClassList();
      this.style = { setProperty() {} };
      this.dataset = {};
      this.children = [];
      this.attributes = {};
      this.found = new Map();
      this.text = '';
      this.hidden = false;
      this.disabled = false;
      this.inert = false;
    }
    get textContent() {
      return this.text;
    }
    set textContent(value) {
      this.text = String(value);
      this.children = [];
    }
    set innerHTML(value) {
      doc.htmlWrites.push(this.name);
      this.text = String(value);
    }
    set className(value) {
      this.classList = new ClassList();
      this.classList.add(...String(value).split(' ').filter(Boolean));
    }
    get firstChild() {
      return this.children[0];
    }
    get lastChild() {
      return this.children.at(-1);
    }
    append(...nodes) {
      this.children.push(...nodes);
    }
    setAttribute(key, value) {
      this.attributes[key] = String(value);
    }
    addEventListener() {}
    querySelector(selector) {
      if (selector.includes('data-autofocus')) return null;
      if (!this.found.has(selector)) this.found.set(selector, new El(`${this.name} ${selector}`));
      return this.found.get(selector);
    }
    focus() {
      doc.activeElement = this;
    }
  }
  doc.head = new El('head');

  const ctx = {
    document: doc,
    navigator: wakeLock ? { wakeLock } : {},
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem(key, value) {
        writes.push(key);
        store.set(key, String(value));
      },
      removeItem: (key) => store.delete(key),
    },
    matchMedia: () => ({ matches: false }),
    setTimeout(fn, ms) {
      timers.timeouts.push({ fn, ms });
      return timers.timeouts.length;
    },
    clearTimeout() {},
    setInterval() {
      timers.intervals += 1;
      return timers.intervals;
    },
    clearInterval() {},
    requestAnimationFrame() {
      timers.frames += 1;
      return timers.frames;
    },
    addEventListener() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(statsSource, ctx, { filename: 'harness:stats.js' });
  vm.runInContext(appSource, ctx, { filename: 'harness:app.js' });

  return {
    ctx,
    doc,
    store,
    writes,
    timers,
    read: (expression) => vm.runInContext(expression, ctx),
    $: (id) => doc.getElementById(id),
    fire(type) {
      for (const fn of listeners[type] ?? []) fn();
    },
  };
}

function started(options) {
  const app = boot(options);
  app.ctx.startGame('easy', BOARD);
  return app;
}

const emptyCells = () => [...BOARD.puzzle.keys()].filter((i) => BOARD.puzzle[i] === 0);
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the game save is pinned to SAVE_VERSION, and every grid it writes is checked on the way back in', () => {
  const first = started();
  const saved = JSON.parse(first.store.get(SAVE));
  assert.deepEqual(
    { v: saved.v, keys: Object.keys(saved).toSorted() },
    {
      v: 1,
      keys: [
        'diffKey',
        'fixed',
        'grade',
        'hints',
        'mistakes',
        'notes',
        'puzzle',
        'seconds',
        'seed',
        'sel',
        'solution',
        'solved',
        'v',
        'values',
      ],
    },
    'the save payload changed shape: bump SAVE_VERSION and loadGame() shape checks together, then move this pin, or a returning player restores a malformed board or loses the one they had',
  );

  const reloaded = boot({ storage: first.store });
  assert.equal(reloaded.read('playing'), true, 'a save this build just wrote no longer restores');
  assert.deepEqual(
    [...reloaded.read('values')],
    BOARD.puzzle,
    'the restored board is not the board that was saved',
  );

  const newer = new Map([[SAVE, JSON.stringify({ ...saved, v: saved.v + 1 })]]);
  assert.equal(
    boot({ storage: newer }).read('playing'),
    false,
    'a save from a newer SAVE_VERSION is restored as if this build knew its shape',
  );

  const grids = Object.keys(saved).filter(
    (key) => Array.isArray(saved[key]) && saved[key].length === 81,
  );
  assert.ok(grids.length >= 5, 'the save no longer writes the grids this test checks');
  for (const key of grids) {
    const broken = new Map([[SAVE, JSON.stringify({ ...saved, [key]: saved[key].slice(1) })]]);
    assert.equal(
      boot({ storage: broken }).read('playing'),
      false,
      `loadGame() restores a save whose ${key} is not 81 cells, so the save gained a grid its shape checks never learned about`,
    );
  }
});

test('revealed cells are not read back from the save, so a planted list buys no free hints', () => {
  const first = started();
  const saved = JSON.parse(first.store.get(SAVE));
  const all = [...Array(81).keys()];
  const planted = { ...saved, hints: 0, revealed: all, revealedThisSession: all };
  const app = boot({ storage: new Map([[SAVE, JSON.stringify(planted)]]) });
  assert.equal(
    app.read('playing'),
    true,
    'the planted save did not restore, so this test proves nothing',
  );

  app.read(`sel = ${emptyCells()[0]}`);
  app.ctx.hint();
  assert.equal(
    app.read('hints'),
    1,
    'a hint on a restored board cost nothing: the revealed cells came back from storage the player can edit, and a save listing all 81 keeps the flawless prize on a board of free answers',
  );
  assert.doesNotMatch(
    app.store.get(SAVE),
    /reveal/iu,
    'the revealed cells are written into the save, where the player can edit them',
  );
});

test('a dialog takes focus in the same task that opens it, before any frame is granted', () => {
  const app = started();
  const dialog = app.$('recordOverlay');
  app.doc.activeElement = null;
  app.ctx.showOverlay(dialog);
  assert.ok(
    app.doc.activeElement?.name.startsWith('recordOverlay'),
    'focus did not land inside the dialog synchronously: a tab that is never given an animation frame or a timer leaves focus behind the dialog',
  );
});

test('a board laid out in a background tab starts paused, with no clock running', () => {
  const shown = boot();
  shown.ctx.startGame('easy', BOARD);
  assert.equal(shown.read('paused'), false, 'a board laid out in a visible tab starts paused');
  assert.equal(shown.timers.intervals, 1, 'a board laid out in a visible tab starts no clock');

  const hidden = boot({ hidden: true });
  hidden.ctx.startGame('easy', BOARD);
  assert.equal(
    hidden.read('paused'),
    true,
    'a board laid out while the tab is hidden starts unpaused, and the minutes nobody watched go into the best time',
  );
  assert.equal(
    hidden.timers.intervals,
    0,
    'the clock started on a board laid out in a background tab',
  );
  assert.ok(
    hidden.$('veil').classList.contains('show'),
    'the board laid out in the background is not veiled',
  );
});

test('coming back to the tab neither resumes the game nor takes the screen lock again', async () => {
  const requests = [];
  const released = [];
  const wakeLock = {
    request(type) {
      requests.push(type);
      const sentinel = {
        release() {
          released.push(sentinel);
          return Promise.resolve();
        },
        addEventListener() {},
      };
      return Promise.resolve(sentinel);
    },
  };
  const app = started({ wakeLock });
  await settle();
  assert.equal(requests.length, 1, 'a game in a visible tab never asked for the screen lock');

  app.doc.hidden = true;
  app.fire('visibilitychange');
  await settle();
  assert.equal(app.read('paused'), true, 'hiding the tab no longer pauses the game');
  assert.equal(released.length, 1, 'hiding the tab no longer releases the screen lock');

  app.doc.hidden = false;
  app.fire('visibilitychange');
  await settle();
  assert.equal(
    app.read('paused'),
    true,
    'coming back to the tab resumed the game on its own, which starts the clock before the player is looking',
  );
  assert.equal(
    requests.length,
    1,
    'coming back to the tab took the screen lock again, which holds the screen awake over a veiled board with a stopped clock',
  );

  app.ctx.setPaused(false);
  await settle();
  assert.equal(requests.length, 2, 'resuming with Seguir no longer takes the screen lock back');
});

test('a failure laying out a board that arrived is thrown, not told to the player as a generator failure', async () => {
  const app = boot();
  app.ctx.requestPuzzle = async () => BOARD;
  app.ctx.startGame = () => {
    throw new Error('layout broke');
  };
  await assert.rejects(
    app.ctx.newGame('easy'),
    /layout broke/u,
    'newGame() swallowed a bug in laying the board out, so it is reported as a generator that could not answer and nothing ever surfaces it',
  );
  assert.notEqual(
    app.$('genStatus').textContent,
    FAILURE_COPY,
    'a layout bug is shown to the player as the generator having failed',
  );
});

test('the generator failure message survives the end of the busy state', async () => {
  const app = boot();
  app.ctx.requestPuzzle = async () => {
    throw new Error('no board');
  };
  await app.ctx.newGame('easy');
  assert.equal(app.read('generating'), false, 'a failed generation left the picker busy');
  assert.equal(
    app.$('genStatus').textContent,
    FAILURE_COPY,
    'the failure message was written before setGenerating(false) emptied the element, so neither a sighted nor a screen reader player ever hears why nothing happened',
  );
});

test('a key press that changes nothing leaves the undo history alone', () => {
  const app = started();
  const [cell] = emptyCells();
  const digit = BOARD.solution[cell];
  app.read(`sel = ${cell}`);
  app.ctx.inputDigit(digit);
  assert.equal(app.read('undoStack.length'), 1, 'a real move no longer records an undo step');

  app.read('while (undoStack.length < 300) snapshot()');
  app.read('globalThis.oldest = undoStack[0]');
  const same = () => app.read('undoStack.length === 300 && undoStack[0] === globalThis.oldest');

  app.ctx.inputDigit(digit);
  assert.equal(
    app.read(`values[${cell}]`),
    digit,
    'entering the digit already in a cell cleared it',
  );
  assert.ok(
    same(),
    'entering the digit already in a cell recorded an undo step, and with the history full that evicts the oldest real move',
  );

  app.ctx.setNotes(true);
  app.ctx.inputDigit(digit === 9 ? 1 : digit + 1);
  assert.ok(
    same(),
    'a pencil mark on a filled cell recorded an undo step, and with the history full that evicts the oldest real move',
  );
});

test('a record is judged against the counts before this win moves them', () => {
  const times = boot();
  assert.deepEqual(
    { ...times.ctx.recordWin('easy', 100, false) },
    { time: false, streak: false },
    'a first win is reported as a personal best, against nothing',
  );
  assert.equal(
    times.ctx.recordWin('easy', 50, false).time,
    true,
    'a faster second win is not reported as a personal best',
  );
  assert.equal(
    times.ctx.recordWin('easy', 80, false).time,
    false,
    'a slower win is reported as a personal best',
  );

  const instant = boot();
  instant.ctx.recordWin('easy', 0, false);
  assert.equal(
    instant.ctx.recordWin('easy', 5, false).time,
    false,
    'a best time of zero was read as no win at all, so the next slower win beat it',
  );

  const streak = boot();
  const said = [1, 2, 3].map(() => streak.ctx.recordWin('easy', 100, true).streak);
  assert.deepEqual(
    said,
    [false, false, true],
    'a run of three clean wins is not announced as a new best streak exactly once, on the third, so the best was read after it moved',
  );
});

test('no screen reader action part ends in a full stop, because the announcement adds its own', () => {
  const statements = [...appSource.matchAll(/\bsrAction = ([^;]+);/gu)].map((m) => m[1]);
  assert.ok(
    statements.length >= 4,
    'the srAction assignments are not where this test looks for them',
  );
  for (const statement of statements) {
    for (const [, single, template] of statement.matchAll(/'([^']*)'|`([^`]*)`/gu)) {
      const text = single ?? template;
      assert.ok(
        !text.endsWith('.'),
        `srAction is given "${text}", which ends in a full stop, so the announcement reads two of them`,
      );
    }
  }

  const app = started();
  const doubled = /\.\s*\./u;
  let before = app.$('srStatus').textContent;
  const heard = (what) => {
    const said = app.$('srStatus').textContent;
    assert.ok(
      said.length > 0 && said !== before,
      `${what} announced nothing new, so this check reads nothing`,
    );
    before = said;
    assert.doesNotMatch(said, doubled, `${what} is announced with a doubled full stop: "${said}"`);
  };

  const [one, two] = emptyCells();
  app.read(`sel = ${one}`);
  app.ctx.inputDigit(BOARD.solution[one] === 9 ? 1 : BOARD.solution[one] + 1);
  app.ctx.undo();
  heard('Deshacer');

  app.read(`sel = ${BOARD.puzzle.findIndex((v) => v !== 0)}`);
  app.ctx.hint();
  heard('a hint asked for on a given cell');

  app.read('sel = -1');
  app.ctx.hint();
  heard('a hint asked for with nothing selected');

  const apart = emptyCells().find(
    (i) =>
      i !== two &&
      i !== app.read('sel') &&
      !app.read(`PEERS[${i}].has(${two})`) &&
      app.read(`values[${i}]`) === 0,
  );
  for (const i of emptyCells()) {
    if (i !== two && i !== apart) app.read(`values[${i}] = solution[${i}]`);
  }
  app.read(`notes[${two}] = new Set([solution[${two}]])`);
  app.ctx.settleSingles();
  heard('confirming a single pencil mark');
});

test('the prize is in storage before any win animation timer fires', () => {
  const app = started();
  const [last, ...rest] = emptyCells();
  for (const i of rest) app.read(`values[${i}] = solution[${i}]`);
  app.read(`sel = ${last}`);
  app.ctx.inputDigit(BOARD.solution[last]);
  assert.equal(app.read('solved'), true, 'the board did not finish, so this test proves nothing');

  const wallet = JSON.parse(app.store.get(WALLET) ?? 'null');
  assert.deepEqual(
    wallet && { fries: wallet.fries, choco: wallet.choco },
    { fries: 10, choco: 1 },
    'the prize for a flawless Piola win (double papas and its chocolate) was not in storage before the animation timers ran, so a player who closes the tab during the rain loses what they won',
  );
});

test('pausing leaves Nueva partida usable, so a paused game can be abandoned', () => {
  const app = started();
  app.ctx.setPaused(true);
  assert.equal(
    app.$('hintBtn').inert,
    true,
    'pausing no longer inerts Pista, so this test cannot see a pause',
  );
  assert.notEqual(
    app.$('newBtn').inert,
    true,
    'pausing inerts Nueva partida, so a player has to resume a game just to abandon it',
  );
});

test('a fresh tab writes no wallet unless an old save carried papas across', () => {
  const fresh = boot();
  assert.ok(
    !fresh.writes.includes(WALLET),
    'booting with no wallet wrote an empty one, which is a storage event that zeroes the totals of every other open tab',
  );

  const legacy = boot({ storage: new Map([[SAVE, JSON.stringify({ v: 1, friesTotal: 7 })]]) });
  const wallet = JSON.parse(legacy.store.get(WALLET) ?? 'null');
  assert.equal(
    wallet?.fries,
    7,
    'papas left in a save from before the wallet existed were not carried across',
  );
});

test('the record dialog paints stored data without parsing it as markup', () => {
  const storage = new Map([
    [
      WALLET,
      JSON.stringify({
        v: 2,
        fries: 3,
        choco: 1,
        ledger: [
          { t: Date.UTC(2026, 0, 2), k: 'win', f: 5, c: 1, d: 'easy' },
          { t: Date.UTC(2026, 0, 3), k: 'redeem', f: -2, c: 0, d: '' },
        ],
      }),
    ],
    [
      'sudoku:stats',
      JSON.stringify({
        v: 1,
        d: { easy: { played: 2, won: 1, best: 90 } },
        streak: 1,
        bestStreak: 1,
      }),
    ],
    [
      'sudoku:history',
      JSON.stringify({ v: 1, games: [{ t: 1, s: 90, m: 0, h: 0, g: 1, d: 'easy' }] }),
    ],
  ]);
  const app = boot({ storage });
  app.doc.htmlWrites.length = 0;
  app.ctx.paintRecord();
  assert.ok(
    app.$('purseFries').textContent === '3',
    'the stored wallet did not reach the record dialog',
  );
  assert.deepEqual(
    app.doc.htmlWrites,
    [],
    'paintRecord() writes innerHTML, and what it paints comes out of localStorage, which anything on this origin can write',
  );
});
