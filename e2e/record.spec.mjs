import { expect, test } from '@playwright/test';

const WALLET_KEY = 'sudoku:wallet';
const SAVE_KEY = 'sudoku:save';
const STATS_KEY = 'sudoku:stats';
const WALLET_VERSION = 2;

const NORMAL = { fries: 10, choco: 2 };

async function boot(page) {
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
  await page.goto('./');
  await expect(page.locator('#board .cell')).toHaveCount(81);
  return problems;
}

async function startGame(page, diff = 'medium') {
  await page.locator(`#startOverlay button.diff[data-d="${diff}"]`).click();
  await expect(page.locator('#startOverlay')).toBeHidden();
}

const solve = (page) =>
  page.evaluate(() => {
    for (let i = 0; i < 81; i++) {
      if (values[i] !== solution[i]) {
        sel = i;
        inputDigit(solution[i]);
      }
    }
  });

const spoil = (page) =>
  page.evaluate(() => {
    const i = values.findIndex((_v, k) => !fixed[k]);
    sel = i;
    inputDigit((solution[i] % 9) + 1);
  });

const readRaw = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

async function openRecord(page) {
  await page.locator('#recordBtn').click();
  await expect(page.getByRole('dialog', { name: 'TU REGISTRO' })).toBeVisible();
}

const recordRow = (page, key) =>
  page.locator(`#recordRows tr`).nth(key).locator('td').allTextContents();

test('the record opens over the start dialog and hands focus back on the way out', async ({
  page,
}) => {
  const problems = await boot(page);

  await openRecord(page);
  await expect(page.locator('#startOverlay')).toBeVisible();
  await expect(page.locator('#closeRecord')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.locator('#recordOverlay')).toBeHidden();
  await expect(page.locator('#startOverlay')).toBeVisible();
  await expect(page.locator('#recordBtn')).toBeFocused();
  expect(problems).toEqual([]);
});

test('the difficulty buttons cannot be reached from behind the record', async ({ page }) => {
  const problems = await boot(page);
  await openRecord(page);
  await expect(page.locator('#closeRecord')).toBeFocused();

  for (let press = 0; press < 4; press++) {
    await page.keyboard.press('Tab');
    const escaped = await page.evaluate(
      () =>
        document.activeElement !== null && document.activeElement.closest('#startOverlay') !== null,
    );
    expect(escaped, 'Tab reached the dialog behind the record').toBe(false);
  }

  await page.keyboard.press('Escape');
  await expect(page.locator('#recordOverlay')).toBeHidden();
  await startGame(page);
  await expect(page.locator('#recordOverlay')).toBeHidden();
  await expect(page.locator('.app')).not.toHaveJSProperty('inert', true);
  expect(problems).toEqual([]);
});

test('a fresh player has a record that says so', async ({ page }) => {
  const problems = await boot(page);
  await openRecord(page);

  await expect(page.locator('#streakText')).toHaveText('Sin partidas todavía.');
  await expect(page.locator('#streakCounts'), 'no counts before the first game').toBeHidden();
  await expect(page.locator('#recordRows tr')).toHaveCount(4);
  expect(await recordRow(page, 0)).toEqual(['Piola', '0', '0', '']);
  await expect(page.locator('#ledgerList li')).toHaveCount(0);
  await expect(page.locator('#redeemFries')).toBeDisabled();
  await expect(page.locator('#redeemChoco')).toBeDisabled();
  expect(problems).toEqual([]);
});

test('a flawless win is written into the record, the streak and the ledger', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page, 'medium');
  await solve(page);
  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries * 2));

  await page.locator('#againBtn').click();
  await openRecord(page);

  const [label, played, won, best] = await recordRow(page, 1);
  expect(label).toBe('Normal');
  expect(played).toBe('1');
  expect(won).toBe('1');
  expect(best).toMatch(/^\d+:\d\d$/u);

  await expect(page.locator('#streakText')).toHaveText('Racha de secas: 1. La mejor: 1.');
  await expect(page.locator('#streakCounts')).toHaveText('🔥 1 seguida 🥇 mejor 1');

  await expect(page.locator('#ledgerList li')).toHaveCount(1);
  await expect(page.locator('#ledgerList li').first()).toContainText(
    `+${NORMAL.fries * 2} papas, +${NORMAL.choco} chocolates en Normal`,
  );
  expect(problems).toEqual([]);
});

test('a win that is not flawless breaks the streak', async ({ page }) => {
  const problems = await boot(page);

  await startGame(page, 'medium');
  await solve(page);
  await page.locator('#againBtn').click();

  await startGame(page, 'medium');
  await spoil(page);
  await solve(page);
  await page.locator('#againBtn').click();

  await openRecord(page);
  await expect(page.locator('#streakText')).toHaveText('Racha de secas: 0. La mejor: 1.');
  await expect(page.locator('#streakCounts')).toHaveText('🔥 0 seguidas 🥇 mejor 1');
  expect(await recordRow(page, 1)).toMatchObject(['Normal', '2', '2', expect.anything()]);
  expect(problems).toEqual([]);
});

test('the run survives the app being closed between games', async ({ page }) => {
  const problems = await boot(page);

  await startGame(page, 'medium');
  await solve(page);
  await expect(page.locator('#winOverlay')).toBeVisible();

  await page.reload();
  await expect(page.locator('#board .cell')).toHaveCount(81);

  await startGame(page, 'medium');
  await solve(page);
  await expect(page.locator('#wStreakLine')).toHaveText('🔥 Van 2 secas seguidas.');

  await page.locator('#againBtn').click();
  await openRecord(page);
  await expect(page.locator('#streakCounts')).toHaveText('🔥 2 seguidas 🥇 mejor 2');
  expect(problems).toEqual([]);
});

test('a save with a negative clock cannot poison the best time', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page, 'medium');

  await page.evaluate(() => {
    const i = values.findIndex((_v, k) => !fixed[k]);
    sel = i;
    inputDigit(solution[i]);
  });
  const save = JSON.parse(await readRaw(page, SAVE_KEY));
  save.seconds = -900;
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [SAVE_KEY, JSON.stringify(save)],
  );
  await page.reload();
  await expect(page.locator('#board .cell')).toHaveCount(81);

  await expect(page.locator('#time')).toHaveText(/^\d+:\d\d$/u);

  await solve(page);
  await page.locator('#againBtn').click();
  await openRecord(page);

  const [, , , best] = await recordRow(page, 1);
  expect(best).toMatch(/^\d+:\d\d$/u);
  const stored = JSON.parse(await readRaw(page, STATS_KEY)).d.medium.best;
  expect(stored, 'a negative time reached the record').toBeGreaterThanOrEqual(0);

  await page.locator('#closeRecord').click();
  await startGame(page, 'medium');
  await solve(page);
  await page.locator('#againBtn').click();
  await openRecord(page);
  const after = JSON.parse(await readRaw(page, STATS_KEY)).d.medium;
  expect(after).toMatchObject({ played: 2, won: 2 });
  expect(after.best, 'the best time is frozen').toBeGreaterThanOrEqual(0);
  expect(problems).toEqual([]);
});

test('a mistake undone still breaks the streak', async ({ page }) => {
  const problems = await boot(page);

  await startGame(page, 'medium');
  await solve(page);
  await page.locator('#againBtn').click();

  await startGame(page, 'medium');
  await spoil(page);
  await page.locator('#undoBtn').click();
  await expect(page.locator('#mistakes')).toHaveText('1');
  await solve(page);
  await page.locator('#againBtn').click();

  await openRecord(page);
  await expect(page.locator('#streakText')).toHaveText('Racha de secas: 0. La mejor: 1.');
  await expect(page.locator('#streakCounts')).toHaveText('🔥 0 seguidas 🥇 mejor 1');
  expect(problems).toEqual([]);
});

test('redeeming takes two presses, and the second one empties the balance', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page, 'medium');
  await solve(page);
  await page.locator('#againBtn').click();
  await openRecord(page);

  await expect(page.locator('#purseFries')).toHaveText(String(NORMAL.fries * 2));

  await page.locator('#redeemFries').click();
  await expect(page.locator('#redeemFries')).toHaveText('¿Seguro?');
  await expect(page.locator('#purseFries')).toHaveText(String(NORMAL.fries * 2));
  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries * 2));

  await page.locator('#redeemFries').click();
  await expect(page.locator('#purseFries')).toHaveText('0');
  await expect(page.locator('#redeemFries')).toHaveText('Canjear');
  await expect(page.locator('#redeemFries')).toBeDisabled();
  await expect(page.locator('#fries')).toHaveText('0');
  await expect(page.locator('#chocos')).toHaveText(String(NORMAL.choco));

  const stored = JSON.parse(await readRaw(page, WALLET_KEY));
  expect(stored).toMatchObject({ v: WALLET_VERSION, fries: 0, choco: NORMAL.choco });
  expect(stored.ledger).toHaveLength(2);
  expect(stored.ledger[1]).toMatchObject({ k: 'redeem', f: -(NORMAL.fries * 2), c: 0 });
  await expect(page.locator('#ledgerList li').first()).toContainText(
    `-${NORMAL.fries * 2} papas canjeadas`,
  );
  expect(problems).toEqual([]);
});

test('arming one prize and pressing the other redeems nothing by accident', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page, 'medium');
  await solve(page);
  await page.locator('#againBtn').click();
  await openRecord(page);

  await page.locator('#redeemFries').click();
  await expect(page.locator('#redeemFries')).toHaveText('¿Seguro?');

  await page.locator('#redeemChoco').click();
  await expect(page.locator('#redeemChoco')).toHaveText('¿Seguro?');
  await expect(page.locator('#redeemFries')).toHaveText('Canjear');
  await expect(page.locator('#purseFries')).toHaveText(String(NORMAL.fries * 2));
  await expect(page.locator('#purseChoco')).toHaveText(String(NORMAL.choco));
  expect(problems).toEqual([]);
});

test('a wallet from the build before the ledger keeps its totals', async ({ page }) => {
  await page.addInitScript(
    (key) => localStorage.setItem(key, '{"v":1,"fries":37,"choco":4}'),
    WALLET_KEY,
  );

  const problems = await boot(page);
  await expect(page.locator('#fries')).toHaveText('37');
  await expect(page.locator('#chocos')).toHaveText('4');

  await openRecord(page);
  await expect(page.locator('#ledgerList li')).toHaveCount(0);
  await expect(page.locator('#redeemFries')).toBeEnabled();

  await page.locator('#closeRecord').click();
  await startGame(page, 'medium');
  await solve(page);
  const stored = JSON.parse(await readRaw(page, WALLET_KEY));
  expect(stored).toMatchObject({
    v: WALLET_VERSION,
    fries: 37 + NORMAL.fries * 2,
    choco: 4 + NORMAL.choco,
  });
  expect(problems).toEqual([]);
});

test('a record this build cannot read is started over rather than half read', async ({ page }) => {
  await page.addInitScript(
    (key) => localStorage.setItem(key, '{"v":9,"d":{"easy":{"played":"lots"}},"streak":"many"}'),
    STATS_KEY,
  );

  const problems = await boot(page);
  await openRecord(page);
  await expect(page.locator('#streakText')).toHaveText('Sin partidas todavía.');
  await expect(page.locator('#streakCounts'), 'no counts before the first game').toBeHidden();
  expect(await recordRow(page, 0)).toEqual(['Piola', '0', '0', '']);
  expect(problems).toEqual([]);
});

test('the board is built in a worker, off the main thread', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page, 'medium');

  const requested = await page.evaluate(() =>
    performance.getEntriesByType('resource').some((e) => e.name.endsWith('/generator.js')),
  );
  expect(requested, 'generator.js was never fetched').toBe(true);
  expect(
    await page.evaluate(() => document.querySelector('script[src="./generator.js"]') !== null),
    'the page fell back to generating on the main thread',
  ).toBe(false);
  expect(problems).toEqual([]);
});

test('a browser that refuses to make a worker still deals a board', async ({ page }) => {
  await page.addInitScript(() => {
    window.Worker = function BlockedWorker() {
      throw new Error('workers are blocked here');
    };
  });

  const problems = await boot(page);
  await startGame(page, 'medium');

  await expect(page.locator('#board .cell.given')).not.toHaveCount(0);
  await expect(page.locator('#diffLabel')).toHaveText('Normal');
  expect(
    await page.evaluate(() => document.querySelector('script[src="./generator.js"]') !== null),
    'the fallback script was never loaded',
  ).toBe(true);
  expect(problems).toEqual([]);
});

test('a board that cannot be built at all says so instead of hanging', async ({ page }) => {
  await page.addInitScript(() => {
    delete Navigator.prototype.serviceWorker;
    window.Worker = function BlockedWorker() {
      throw new Error('workers are blocked here');
    };
  });
  await page.route('**/generator.js', (route) => route.abort());

  const problems = await boot(page);
  await page.locator('#startOverlay button.diff[data-d="medium"]').click();

  await expect(page.locator('#genStatus')).toHaveText(
    'No se pudo armar el tablero. Prueba de nuevo.',
  );
  await expect(page.locator('#startOverlay')).toBeVisible();
  await expect(page.locator('#startOverlay button.diff[data-d="medium"]')).toBeEnabled();
  expect(problems.filter((p) => !p.includes('Failed to load resource'))).toEqual([]);
});

test('the win dialog reports the technique the board needed and its code', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page, 'medium');

  const expected = await page.evaluate(() => ({
    word: GRADE_WORDS[puzzleGrade],
    code: puzzleSeed.toString(36),
  }));

  await solve(page);
  await expect(page.getByRole('dialog', { name: '¡SECA!' })).toBeVisible();
  await expect(page.locator('#wGrade')).toHaveText(expected.word);
  await expect(page.locator('#wCode')).toHaveText(expected.code);
  expect(problems).toEqual([]);
});
