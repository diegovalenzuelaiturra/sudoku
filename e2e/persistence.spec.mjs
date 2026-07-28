/* The game autosaves to localStorage and resumes on the next load.

   What has to hold: a reload lands the player back on the same puzzle with the
   same digits, pencil marks, counters and clock, and never on a stale or
   finished one. Everything storage touches is also allowed to fail: Safari in
   private mode throws from setItem, so a dead localStorage must cost the save
   and nothing else.

   This is the browser version of what tests/persistence.test.mjs asked a DOM
   simulator before it was deleted. Three things it can assert that the
   simulator could not:

   1. The reload is a real reload. Every simulated document got its own
      localStorage, so the old suite had to hand the page an in-memory
      stand-in and boot a second document against it. Here the page writes to
      the browser's own storage and page.reload() re-runs the same document
      the player would get.
   2. Restoring means the board is exposed again. The old suite could only read
      back the inert property it had just seen the page set; with no
      accessibility tree, it could not tell whether the 81 cells were
      actually readable. These tests ask Chrome over CDP for the tree it hands
      assistive tech, where an inert subtree is dropped wholesale, and compare
      the names it exposes before and after the reload.
   3. A service worker exists. The simulator had none, so the half of the reload
      path where the app shell comes out of the cache instead of off the server
      was invisible to the old suite. */

import { expect, test } from '@playwright/test';

const SAVE_KEY = 'sudoku:save';

/* The name render() gives every cell: "Fila 3, columna 7, 4, dada". */
const CELL_NAME = /^Fila \d, columna \d/;

/* Loads the page with the console under watch. The returned array is the
   browser's answer to the old helper's `errors`: it is filled by uncaught
   exceptions and console errors for the rest of the test, reloads included. */
async function boot(page) {
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
  /* Relative, so the request goes through the /sudoku/ prefix in baseURL. */
  await page.goto('./');
  await expect(page.locator('#board .cell')).toHaveCount(81);
  return problems;
}

async function startGame(page, diff = 'medium') {
  await page.locator(`#startOverlay button.diff[data-d="${diff}"]`).click();
  await expect(page.locator('#startOverlay')).toBeHidden();
}

const readRawSave = (page) => page.evaluate((key) => localStorage.getItem(key), SAVE_KEY);

async function readSave(page) {
  const raw = await readRawSave(page);
  expect(raw, 'nothing was saved').not.toBeNull();
  return JSON.parse(raw);
}

/* Reads the board as the player sees it: the digit in each cell plus whatever
   pencil marks it carries. Enough to prove a restore is faithful. */
const readBoard = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#board .cell')].map((cell) => ({
      value: cell.firstChild.textContent,
      given: cell.classList.contains('given'),
      notes: [...cell.lastChild.children].map((s) => s.textContent).join(''),
    })),
  );

/* The board cells Chrome would hand to assistive tech, by name. Ignored nodes
   are dropped, and an inert subtree is ignored, so this is empty whenever a
   dialog is up and the app behind it is inert. */
async function accessibleCells(cdp) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  return nodes
    .filter(
      (node) =>
        !node.ignored &&
        (node.role?.value ?? '') === 'button' &&
        CELL_NAME.test(node.name?.value ?? ''),
    )
    .map((node) => node.name.value);
}

/* Polled rather than read once: the accessibility tree is rebuilt off the back
   of the DOM change, and CI hardware is slower than a laptop. */
function expectExposedCells(cdp, count) {
  return expect
    .poll(async () => (await accessibleCells(cdp)).length, {
      message: `expected ${count} board cells in the accessibility tree Chrome exposes`,
      /* Longer than the default expect timeout: the tree is rebuilt off the
         back of a render that can be competing with puzzle generation, and 10
         seconds is where this poll flaked under load. */
      timeout: 15_000,
    })
    .toBe(count);
}

/* The whole board as a screen reader would hear it, returned once Chrome's
   tree agrees with the markup render() wrote. Comparing this across a reload
   is the strong form of "the restored board is the saved board": it proves
   both that every value came back and that nothing left the board inert. */
async function exposedBoard(page, cdp) {
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('#board .cell')].map((cell) => cell.getAttribute('aria-label')),
  );
  await expect
    .poll(() => accessibleCells(cdp), {
      message: 'Chrome exposes every board cell under the name render() gave it',
    })
    .toEqual(labels);
  return labels;
}

/* Leaves a pencil mark, a placed digit and a non-zero clock. The moves go
   through the same clicks and keypresses a player would use, which the old
   suite could not do: it called inputDigit() directly, so it never exercised
   the path from a real event to a written save. */
async function playAndSave(page) {
  const plan = await page.evaluate(() => {
    const a = values.findIndex((v, i) => !fixed[i]);
    const b = values.findIndex((v, i) => !fixed[i] && i !== a);
    /* a digit that is not the one about to be placed at b, so filling b does
       not sweep the pencil mark off a as a now-impossible candidate */
    return { a, b, note: (solution[b] % 9) + 1, digit: solution[b] };
  });
  const cell = (i) => page.locator('#board .cell').nth(i);

  await page.locator('#notesBtn').click();
  await cell(plan.a).click();
  await page.keyboard.press(String(plan.note));
  await page.locator('#notesBtn').click();

  await cell(plan.b).click();
  await page.keyboard.press(String(plan.digit));

  /* Both moves have to be on the board before the save is flushed, or the
     assertions below would be reading an empty grid and calling it a match. */
  await expect(cell(plan.a).locator('.notes span').nth(plan.note - 1)).toHaveText(
    String(plan.note),
  );
  await expect(cell(plan.b).locator('.v')).toHaveText(String(plan.digit));

  /* The clock cannot be waited out. Setting it and flushing the save in one
     synchronous step keeps the saved value exact: no tick can land between
     the two statements. */
  await page.evaluate(() => {
    seconds = 42;
    saveGame();
  });
}

test('a game in progress survives a reload', async ({ page, context }) => {
  const problems = await boot(page);
  test.skip(
    test.info().project.name !== 'chromium',
    'reads the accessibility tree, which only Chromium exposes over CDP',
  );
  const cdp = await context.newCDPSession(page);

  await startGame(page, 'medium');
  await playAndSave(page);
  const before = await readBoard(page);
  const heardBefore = await exposedBoard(page, cdp);
  expect(problems).toEqual([]);

  const saved = await readSave(page);
  expect(saved.v, 'save is not stamped with the schema version').toBe(1);
  expect(saved.diffKey).toBe('medium');
  expect(saved.puzzle, 'the original givens are not saved').toHaveLength(81);
  expect(saved.solution).toHaveLength(81);
  expect(saved.notes).toHaveLength(81);
  expect(
    saved.notes.some((n) => n.length > 0),
    'pencil marks were not serialised out of their Sets',
  ).toBe(true);
  expect(saved.seconds).toBe(42);

  /* A genuine reload of the genuine save, not a second document pointed at a
     stand-in for storage. */
  await page.reload();
  expect(problems, 'restoring threw').toEqual([]);

  await expect(
    page.locator('#startOverlay'),
    'the difficulty picker interrupted a resumable game',
  ).toBeHidden();
  expect(await readBoard(page), 'the restored board differs').toEqual(before);
  /* The old suite could only check that .app.inert was not true. This is what
     that property was standing in for: all 81 cells are back in the tree
     Chrome exposes, under the same names, so nothing was left inert and
     nothing came back wrong. */
  expect(
    await exposedBoard(page, cdp),
    'the restored board is not the board that was saved',
  ).toEqual(heardBefore);
  await expect(page.locator('#diffLabel')).toHaveText('Normal');
  /* The restored clock resumes running, so this allows the seconds that pass
     while it is read on a slow runner, but not a reset to 0:00 and not a lost
     minute. */
  await expect(page.locator('#time')).toHaveText(/^0:[45]\d$/);
  expect(await page.evaluate(() => playing), 'restored game is not playable').toBe(true);
});

/* Moving the selection is a saved action too, and it is the only one that can
   autorepeat, so it is saved on two paths with different timing: a click writes
   at once, a held arrow key coalesces. Both are asserted here rather than
   through a reload, because a reload cannot tell either of them apart from
   nothing at all. */
test('selecting a cell is saved at once by a click, once per burst by the arrows', async ({
  page,
}) => {
  const problems = await boot(page);
  await startGame(page, 'medium');

  /* Counting writes, not watching the stored value: the count is the whole
     difference between a coalesced burst and one save per keystroke, and the
     value is identical either way. */
  await page.evaluate((key) => {
    window.__writes = [];
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) window.__writes.push(value);
      return real.call(this, name, value);
    };
  }, SAVE_KEY);
  const writes = () => page.evaluate(() => window.__writes.length);

  /* Read while the page is still open, which is the part that matters. A
     "click a cell, reload, expect that cell" test passes with the click
     handler's saveGame() deleted: leaving the page fires visibilitychange,
     which pauses, and pausing saves. Measured, that write comes out of
     setPaused() during unload, so the reload proves nothing about the click. */
  await page.locator('#board .cell').nth(40).click();
  expect(await writes(), 'clicking a cell did not save the selection').toBe(1);
  expect((await readSave(page)).sel).toBe(40);

  /* Dispatched in one task, the way a held key autorepeats. Pressing through
     the runner is slower than the 250ms coalescing window on a loaded machine,
     so that would measure the machine rather than the code. */
  await page.evaluate(() => {
    for (let n = 0; n < 20; n++) {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      );
    }
  });
  expect(await writes(), 'a burst of arrow keys wrote once per keystroke').toBe(1);
  await expect
    .poll(writes, { message: 'the coalesced selection was never written' })
    .toBe(2);

  /* Compared against the live selection rather than a hardcoded index: the
     arrows clamp at the edge of the board, so where 20 of them land is the
     board's business, not this test's. */
  const live = await page.evaluate(() => sel);
  expect(live, 'the arrow keys never reached the board').not.toBe(40);
  expect((await readSave(page)).sel).toBe(live);
  expect(problems).toEqual([]);
});

test('a new game replaces the previous save immediately, before any move', async ({ page }) => {
  const problems = await boot(page);

  await startGame(page, 'medium');
  await playAndSave(page);
  const stale = await readRawSave(page);

  await page.locator('#newBtn').click();
  await expect(page.getByRole('dialog', { name: 'SUDOKU' })).toBeVisible();
  await startGame(page, 'hard');

  const raw = await readRawSave(page);
  expect(raw, 'the previous puzzle is still the save').not.toBe(stale);
  const fresh = JSON.parse(raw);
  expect(fresh.diffKey).toBe('hard');
  /* A difficulty no longer deals a fixed number of clues: it asks for a grade
     and the generator moves the count to reach one. So the count is taken from
     the payload and used as the expectation below, rather than written here. */
  const givens = fresh.puzzle.filter((v) => v !== 0).length;
  expect(givens).toBeGreaterThanOrEqual(17);
  expect(givens).toBeLessThan(81);
  expect(problems).toEqual([]);

  await page.reload();
  await expect(page.locator('#diffLabel')).toHaveText('Peludo');
  /* The clue count on screen, not only in the payload: a stale restore would
     put the givens of the abandoned Normal puzzle back on the board. */
  await expect(page.locator('#board .cell.given')).toHaveCount(givens);
  expect(problems).toEqual([]);
});

test('solving the puzzle clears the save, so the next load starts fresh', async ({
  page,
  context,
}) => {
  const problems = await boot(page);

  await startGame(page, 'medium');
  expect(await readRawSave(page), 'nothing was saved to clear').not.toBeNull();

  /* Driven through the game's own entry point rather than 81 clicks: this
     test is about what solving does to the save, and the click path is
     covered by playAndSave() above. */
  await page.evaluate(() => {
    for (let i = 0; i < 81; i++) {
      if (values[i] !== solution[i]) {
        sel = i;
        inputDigit(solution[i]);
      }
    }
  });
  expect(await page.evaluate(() => solved), 'the board did not register as solved').toBe(true);
  expect(await readRawSave(page), 'a finished game stayed resumable').toBeNull();
  expect(problems).toEqual([]);

  await page.reload();
  await expect(
    page.getByRole('dialog', { name: 'SUDOKU' }),
    'the start dialog did not come back after a finished game',
  ).toBeVisible();
  /* Everything above is what solving does to the save, and it runs on both
     engines, which is where it belongs: WebKit is what an installed copy runs
     and its localStorage is the one that gets partitioned and evicted. Only
     the last assertion is Chromium bound. */
  test.skip(
    test.info().project.name !== 'chromium',
    'reads the accessibility tree, which only Chromium exposes over CDP',
  );
  const cdp = await context.newCDPSession(page);
  /* And it is a real modal: the board behind it is inert, so the tree Chrome
     exposes holds none of its cells. */
  await expectExposedCells(cdp, 0);
});

/* Anything that is not a save this version wrote must be discarded silently and
   fall back to the start dialog, never restore half a board. */
for (const [name, payload] of [
  ['not JSON at all', 'not json {'],
  ['a JSON scalar', '"nope"'],
  /* Otherwise a perfectly restorable save. Stamped {v: 99, diffKey: 'medium'}
     and nothing else, as it was, this payload was rejected a line later by the
     grid shape check, so deleting the version check left the suite green: the
     test named a guarantee it was not testing. Filled in, the version stamp is
     the only thing standing between this and a restored board. */
  ['an unknown schema version', JSON.stringify({
    v: 99,
    puzzle: new Array(81).fill(0),
    solution: new Array(81).fill(1),
    values: new Array(81).fill(0),
    fixed: new Array(81).fill(false),
    notes: new Array(81).fill([]),
    diffKey: 'medium',
  })],
  ['a truncated grid', JSON.stringify({
    v: 1,
    puzzle: new Array(80).fill(0),
    solution: new Array(81).fill(1),
    values: new Array(81).fill(0),
    fixed: new Array(81).fill(false),
    notes: new Array(81).fill([]),
    diffKey: 'medium',
  })],
  ['an unknown difficulty', JSON.stringify({
    v: 1,
    puzzle: new Array(81).fill(0),
    solution: new Array(81).fill(1),
    values: new Array(81).fill(0),
    fixed: new Array(81).fill(false),
    notes: new Array(81).fill([]),
    diffKey: 'imposible',
  })],
  /* "imposible" above is the honest typo. This one is the difficulty that is not
     a difficulty: every name on Object.prototype answers truthy to a bare
     DIFF[key] lookup, so a plain `if(!DIFF[s.diffKey])` accepted this save and
     restored a playable board with no row behind it. Winning then multiplied
     undefined, banked NaN, and wrote a wallet of nulls that read back as zero,
     taking every prize the player had ever earned with it. */
  ['a difficulty borrowed from Object.prototype', JSON.stringify({
    v: 1,
    puzzle: new Array(81).fill(0),
    solution: new Array(81).fill(1),
    values: new Array(81).fill(0),
    fixed: new Array(81).fill(false),
    notes: new Array(81).fill([]),
    diffKey: 'constructor',
  })],
  ['an already-solved game', JSON.stringify({
    v: 1,
    puzzle: new Array(81).fill(0),
    solution: new Array(81).fill(1),
    values: new Array(81).fill(1),
    fixed: new Array(81).fill(false),
    notes: new Array(81).fill([]),
    diffKey: 'medium',
    solved: true,
  })],
]) {
  test(`a save that is ${name} is ignored and the start dialog opens`, async ({ page, context }) => {
    const problems = await boot(page);

    /* Planted in the browser's own storage and then reloaded, so the page
       reads it back through the same localStorage a visitor would. */
    await page.evaluate(
      ([key, value]) => localStorage.setItem(key, value),
      [SAVE_KEY, payload],
    );
    await page.reload();

    expect(problems, 'a bad save threw during boot').toEqual([]);
    /* By role and name: the picker has to reach assistive tech as a dialog,
       not merely carry a class that makes it visible. */
    await expect(
      page.getByRole('dialog', { name: 'SUDOKU' }),
      'the start dialog did not open',
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /Normal/ })).toBeVisible();
    await expect(page.locator('#remaining')).toHaveText('81 por llenar');

    /* Everything above is the rejection itself and runs on both engines, which
       is where it belongs: WebKit is what an installed copy runs, and its
       localStorage is the one that gets partitioned and evicted. Only the last
       assertion is Chromium bound. */
    test.skip(
      test.info().project.name !== 'chromium',
      'reads the accessibility tree, which only Chromium exposes over CDP',
    );
    const cdp = await context.newCDPSession(page);
    /* Nothing of the rejected board leaked out from behind the dialog. */
    await expectExposedCells(cdp, 0);
  });
}

test('a localStorage that throws costs the save, not the game', async ({ page }) => {
  const problems = await boot(page);

  /* The real Storage methods, made to throw the way Safari in private mode
     throws: a DOMException off the real API, not a hand-rolled object handed
     to the page in place of storage. */
  await page.addInitScript(() => {
    const dead = () => {
      throw new DOMException('storage is disabled (private mode)', 'SecurityError');
    };
    for (const name of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) {
      Storage.prototype[name] = dead;
    }
  });
  await page.reload();

  expect(problems, 'a dead localStorage threw during boot').toEqual([]);
  await expect(page.getByRole('dialog', { name: 'SUDOKU' })).toBeVisible();

  await startGame(page, 'medium');
  const plan = await page.evaluate(() => {
    const i = values.findIndex((v, k) => !fixed[k]);
    return { index: i, digit: solution[i] };
  });
  await page.locator('#board .cell').nth(plan.index).click();
  await page.keyboard.press(String(plan.digit));

  /* The digit is on the board and the cell announces it, with every call into
     storage still throwing underneath. */
  await expect(page.locator('#board .cell').nth(plan.index).locator('.v')).toHaveText(
    String(plan.digit),
  );
  await expect(page.locator('#board .cell').nth(plan.index)).toHaveAccessibleName(
    new RegExp(`^Fila \\d, columna \\d, ${plan.digit}$`),
  );
  expect(problems, 'playing threw with storage disabled').toEqual([]);
  expect(await page.evaluate(() => playing)).toBe(true);
});

test('pausing captures the clock', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page, 'medium');

  /* The runner cannot wait out two minutes, so the clock is set by hand.
     Stopping the tick first is what makes the assertion exact: unlike a
     simulator driven by the test, a real browser keeps firing the interval
     between these two steps. */
  await page.evaluate(() => {
    clearInterval(tick);
    seconds = 123;
  });
  await page.locator('#pauseBtn').click();
  await expect(page.locator('#veil')).toBeVisible();

  expect((await readSave(page)).seconds).toBe(123);
  expect(problems).toEqual([]);

  /* What the captured clock is for: the player gets those two minutes back on
     the next load. Tolerant of the seconds that pass while it is read, since
     the restored clock starts running again. */
  await page.reload();
  await expect(page.locator('#time')).toHaveText(/^2:[01]\d$/);
});

test('a save survives a reload the service worker serves from cache', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page, 'medium');
  await playAndSave(page);
  const before = await readBoard(page);

  /* Without a browser there is no service worker, so this reload path never
     existed for the old suite. Once the worker controls the page the next load comes out of
     its cache rather than off the server, and the restore has to survive
     being handed a cached app shell. */
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
      message: 'the service worker never took control of the page',
      timeout: 15_000,
    })
    .toBe(true);
  await page.reload();

  expect(
    await page.evaluate(() => navigator.serviceWorker.controller !== null),
    'the reload was not served by the worker',
  ).toBe(true);
  await expect(page.locator('#startOverlay')).toBeHidden();
  expect(await readBoard(page), 'the cached shell came back with a different board').toEqual(
    before,
  );
  expect(problems).toEqual([]);
});
