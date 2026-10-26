import { expect, test } from '@playwright/test';

const SAVE_KEY = 'sudoku:save';

const CELL_NAME = /^Fila \d, columna \d/u;

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

const readBoard = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#board .cell')].map((cell) => ({
      value: cell.firstChild.textContent,
      given: cell.classList.contains('given'),
      notes: [...cell.lastChild.children].map((s) => s.textContent).join(''),
    })),
  );

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

function expectExposedCells(cdp, count) {
  return expect
    .poll(async () => (await accessibleCells(cdp)).length, {
      message: `expected ${count} board cells in the accessibility tree Chrome exposes`,
      timeout: 15_000,
    })
    .toBe(count);
}

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

async function playAndSave(page) {
  const plan = await page.evaluate(() => {
    const a = values.findIndex((_v, i) => !fixed[i]);
    const b = values.findIndex((_v, i) => !fixed[i] && i !== a);
    return { a, b, note: (solution[b] % 9) + 1, digit: solution[b] };
  });
  const cell = (i) => page.locator('#board .cell').nth(i);

  await page.locator('#notesBtn').click();
  await cell(plan.a).click();
  await page.keyboard.press(String(plan.note));
  await page.locator('#penBtn').click();

  await cell(plan.b).click();
  await page.keyboard.press(String(plan.digit));

  await expect(
    cell(plan.a)
      .locator('.notes span')
      .nth(plan.note - 1),
  ).toHaveText(String(plan.note));
  await expect(cell(plan.b).locator('.v')).toHaveText(String(plan.digit));

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

  await page.reload();
  expect(problems, 'restoring threw').toEqual([]);

  await expect(
    page.locator('#startOverlay'),
    'the difficulty picker interrupted a resumable game',
  ).toBeHidden();
  expect(await readBoard(page), 'the restored board differs').toEqual(before);
  expect(
    await exposedBoard(page, cdp),
    'the restored board is not the board that was saved',
  ).toEqual(heardBefore);
  await expect(page.locator('#diffLabel')).toHaveText('Normal');
  await expect(page.locator('#time')).toHaveText(/^00:[45]\d$/u);
  expect(await page.evaluate(() => playing), 'restored game is not playable').toBe(true);
});

test('selecting a cell is saved at once by a click, once per burst by the arrows', async ({
  page,
}) => {
  const problems = await boot(page);
  await startGame(page, 'medium');

  await page.evaluate((key) => {
    window.__writes = [];
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) window.__writes.push(value);
      return real.call(this, name, value);
    };
  }, SAVE_KEY);
  const writes = () => page.evaluate(() => window.__writes.length);

  await page.locator('#board .cell').nth(40).click();
  expect(await writes(), 'clicking a cell did not save the selection').toBe(1);
  expect((await readSave(page)).sel).toBe(40);

  await page.evaluate(() => {
    for (let n = 0; n < 20; n++) {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      );
    }
  });
  expect(await writes(), 'a burst of arrow keys wrote once per keystroke').toBe(1);
  await expect.poll(writes, { message: 'the coalesced selection was never written' }).toBe(2);

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
  const givens = fresh.puzzle.filter((v) => v !== 0).length;
  expect(givens).toBeGreaterThanOrEqual(17);
  expect(givens).toBeLessThan(81);
  expect(problems).toEqual([]);

  await page.reload();
  await expect(page.locator('#diffLabel')).toHaveText('Peludo');
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
  test.skip(
    test.info().project.name !== 'chromium',
    'reads the accessibility tree, which only Chromium exposes over CDP',
  );
  const cdp = await context.newCDPSession(page);
  await expectExposedCells(cdp, 0);
});

for (const [name, payload] of [
  ['not JSON at all', 'not json {'],
  ['a JSON scalar', '"nope"'],
  [
    'an unknown schema version',
    JSON.stringify({
      v: 99,
      puzzle: new Array(81).fill(0),
      solution: new Array(81).fill(1),
      values: new Array(81).fill(0),
      fixed: new Array(81).fill(false),
      notes: Array.from({ length: 81 }, () => []),
      diffKey: 'medium',
    }),
  ],
  [
    'a truncated grid',
    JSON.stringify({
      v: 1,
      puzzle: new Array(80).fill(0),
      solution: new Array(81).fill(1),
      values: new Array(81).fill(0),
      fixed: new Array(81).fill(false),
      notes: Array.from({ length: 81 }, () => []),
      diffKey: 'medium',
    }),
  ],
  [
    'an unknown difficulty',
    JSON.stringify({
      v: 1,
      puzzle: new Array(81).fill(0),
      solution: new Array(81).fill(1),
      values: new Array(81).fill(0),
      fixed: new Array(81).fill(false),
      notes: Array.from({ length: 81 }, () => []),
      diffKey: 'imposible',
    }),
  ],
  [
    'a difficulty borrowed from Object.prototype',
    JSON.stringify({
      v: 1,
      puzzle: new Array(81).fill(0),
      solution: new Array(81).fill(1),
      values: new Array(81).fill(0),
      fixed: new Array(81).fill(false),
      notes: Array.from({ length: 81 }, () => []),
      diffKey: 'constructor',
    }),
  ],
  [
    'an already-solved game',
    JSON.stringify({
      v: 1,
      puzzle: new Array(81).fill(0),
      solution: new Array(81).fill(1),
      values: new Array(81).fill(1),
      fixed: new Array(81).fill(false),
      notes: Array.from({ length: 81 }, () => []),
      diffKey: 'medium',
      solved: true,
    }),
  ],
]) {
  test(`a save that is ${name} is ignored and the start dialog opens`, async ({
    page,
    context,
  }) => {
    const problems = await boot(page);

    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [SAVE_KEY, payload]);
    await page.reload();

    expect(problems, 'a bad save threw during boot').toEqual([]);
    await expect(
      page.getByRole('dialog', { name: 'SUDOKU' }),
      'the start dialog did not open',
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /Normal/u })).toBeVisible();
    await expect(page.locator('#remaining')).toHaveText('81 por llenar');

    test.skip(
      test.info().project.name !== 'chromium',
      'reads the accessibility tree, which only Chromium exposes over CDP',
    );
    const cdp = await context.newCDPSession(page);
    await expectExposedCells(cdp, 0);
  });
}

test('a localStorage that throws costs the save, not the game', async ({ page }) => {
  const problems = await boot(page);

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
    const i = values.findIndex((_v, k) => !fixed[k]);
    return { index: i, digit: solution[i] };
  });
  await page.locator('#board .cell').nth(plan.index).click();
  await page.keyboard.press(String(plan.digit));

  await expect(page.locator('#board .cell').nth(plan.index).locator('.v')).toHaveText(
    String(plan.digit),
  );
  await expect(page.locator('#board .cell').nth(plan.index)).toHaveAccessibleName(
    new RegExp(`^Fila \\d, columna \\d, ${plan.digit}$`, 'u'),
  );
  expect(problems, 'playing threw with storage disabled').toEqual([]);
  expect(await page.evaluate(() => playing)).toBe(true);
});

test('pausing captures the clock', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page, 'medium');

  await page.evaluate(() => {
    clearInterval(tick);
    seconds = 123;
  });
  await page.locator('#pauseBtn').click();
  await expect(page.locator('#veil')).toBeVisible();

  expect((await readSave(page)).seconds).toBe(123);
  expect(problems).toEqual([]);

  await page.reload();
  await expect(page.locator('#time')).toHaveText(/^02:[01]\d$/u);
});

test('a save survives a reload the service worker serves from cache', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page, 'medium');
  await playAndSave(page);
  const before = await readBoard(page);

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

test('a save from before seeding never becomes a measured board', async ({ page, context }) => {
  await boot(page);
  await startGame(page);
  const save = await readSave(page);
  delete save.seed;
  delete save.grade;

  await context.addInitScript(
    ([key, raw]) => localStorage.setItem(key, raw),
    [SAVE_KEY, JSON.stringify(save)],
  );
  await page.goto('./');
  await expect(page.locator('#board .cell')).toHaveCount(81);
  expect(await page.evaluate(() => puzzleMeasured), 'a pre-seed save is not measured').toBe(false);

  await page.evaluate(() => {
    const i = values.findIndex((v, k) => !v && !fixed[k]);
    sel = i;
    inputDigit(solution[i]);
  });
  const rewritten = await readSave(page);
  expect(rewritten.seed, 'a placeholder seed was written back out').toBeUndefined();
  expect(rewritten.grade, 'a guessed grade was written back out').toBeUndefined();
});
