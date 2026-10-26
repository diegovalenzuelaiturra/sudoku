import { expect, test } from '@playwright/test';

const SAVE_KEY = 'sudoku:save';
const WALLET_KEY = 'sudoku:wallet';
const WALLET_VERSION = 2;

const NORMAL = { fries: 10, choco: 2 };
const HARD = { fries: 15, choco: 3 };

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

const readRaw = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

async function readWallet(page) {
  const raw = await readRaw(page, WALLET_KEY);
  expect(raw, 'no wallet was written').not.toBeNull();
  return JSON.parse(raw);
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
    return i;
  });

const spoilMany = (page, n) =>
  page.evaluate((wanted) => {
    let made = 0;
    for (let i = 0; i < 81 && made < wanted; i++) {
      if (fixed[i] || values[i] !== 0) continue;
      sel = i;
      inputDigit((solution[i] % 9) + 1);
      made++;
    }
    return made;
  }, n);

test('a flawless win pays papas fritas doubled, and chocolates', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page);

  await expect(page.locator('#fries')).toHaveText('0');
  await expect(page.locator('#chocos')).toHaveText('0');

  await solve(page);
  expect(await page.evaluate(() => solved), 'the board did not register as solved').toBe(true);

  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries * 2));
  await expect(page.locator('#chocos')).toHaveText(String(NORMAL.choco));
  expect(await readWallet(page)).toMatchObject({
    v: WALLET_VERSION,
    fries: NORMAL.fries * 2,
    choco: NORMAL.choco,
  });

  expect(await page.locator('#srAlert').textContent()).toMatch(
    new RegExp(`${NORMAL.fries * 2} papas fritas y ${NORMAL.choco} chocolates`, 'u'),
  );

  await expect(page.locator('#winOverlay')).toBeVisible();
  const amounts = await page.locator('#fryBanner b').allTextContents();
  expect(amounts, 'the banner does not show both prizes').toEqual([
    `🍟 +${NORMAL.fries * 2}`,
    `🍫 +${NORMAL.choco}`,
  ]);
  await expect(page.locator('#fryBanner i'), 'the banner grew a badge again').toHaveCount(0);

  expect(await page.locator('#fryBanner .visually-hidden').textContent()).toBe(
    `Ganaste ${NORMAL.fries * 2} papas fritas y ${NORMAL.choco} chocolates.`,
  );
  await expect(page.locator('#fryBanner b').first()).toHaveAttribute('aria-hidden', 'true');
  expect(problems).toEqual([]);
});

test('a win with a mistake pays papas fritas at face value and no chocolate', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page);

  await spoil(page);
  await expect(page.locator('#mistakes')).toHaveText('1');
  await solve(page);
  expect(await page.evaluate(() => solved), 'the board did not register as solved').toBe(true);

  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries));
  await expect(page.locator('#chocos')).toHaveText('0');
  expect(await readWallet(page)).toMatchObject({ fries: NORMAL.fries, choco: 0 });
  expect(problems).toEqual([]);
});

test('a mistake undone still costs the flawless bonus', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page);

  const target = await spoil(page);
  expect(target, 'the board had no empty cell to spoil').toBeGreaterThanOrEqual(0);
  const cell = page.locator('#board .cell').nth(target);
  await expect(cell.locator('.v'), 'the wrong digit never reached the board').not.toBeEmpty();
  await expect(page.locator('#mistakes')).toHaveText('1');

  await page.locator('#undoBtn').click();
  await expect(cell.locator('.v'), 'undo left the wrong digit on the board').toBeEmpty();
  await expect(page.locator('#mistakes')).toHaveText('1');

  await spoil(page);
  await expect(page.locator('#mistakes')).toHaveText('2');
  await page.keyboard.press('z');
  await expect(cell.locator('.v')).toBeEmpty();
  await expect(page.locator('#mistakes')).toHaveText('2');

  const saved = await readRaw(page, SAVE_KEY);
  expect(saved, 'the undo wrote no save').not.toBeNull();
  expect(JSON.parse(saved).mistakes).toBe(2);

  await solve(page);
  expect(await page.evaluate(() => solved), 'the board did not register as solved').toBe(true);

  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries));
  await expect(page.locator('#chocos')).toHaveText('0');
  expect(await readWallet(page)).toMatchObject({ fries: NORMAL.fries, choco: 0 });
  expect(problems).toEqual([]);
});

test('a hint undone still costs the flawless bonus', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page);

  await page.keyboard.press('h');
  await expect(page.locator('#hints')).toHaveText('1');
  const cell = page.locator('#board .cell').nth(await page.evaluate(() => sel));
  await expect(cell).toHaveClass(/given/u);

  await page.keyboard.press('z');
  await expect(cell).not.toHaveClass(/given/u);
  await expect(cell.locator('.v')).toBeEmpty();
  await expect(page.locator('#hints')).toHaveText('1');

  await solve(page);
  expect(await page.evaluate(() => solved), 'the board did not register as solved').toBe(true);

  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries));
  await expect(page.locator('#chocos')).toHaveText('0');
  expect(await readWallet(page)).toMatchObject({ fries: NORMAL.fries, choco: 0 });
  expect(problems).toEqual([]);
});

test('a save that starts the mistake counter below zero cannot buy the bonus', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page);

  await page.evaluate(() => {
    const i = values.findIndex((_v, k) => !fixed[k]);
    sel = i;
    inputDigit(solution[i]);
  });
  const save = JSON.parse(await readRaw(page, SAVE_KEY));
  save.mistakes = -3;
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [SAVE_KEY, JSON.stringify(save)],
  );
  await page.reload();
  await expect(page.locator('#board .cell')).toHaveCount(81);

  await expect(page.locator('#mistakes')).toHaveText('0');

  expect(await spoilMany(page, 3), 'the board ran out of empty cells to spoil').toBe(3);
  await expect(page.locator('#mistakes')).toHaveText('3');

  await solve(page);
  expect(await page.evaluate(() => solved), 'the board did not register as solved').toBe(true);

  await expect(page.locator('#chocos')).toHaveText('0');
  expect(await readWallet(page)).toMatchObject({ fries: NORMAL.fries, choco: 0 });
  expect(problems).toEqual([]);
});

test('a second tab cannot reset the counters the bonus is gated on', async ({ page, context }) => {
  const problems = await boot(page);
  await startGame(page);

  const other = await context.newPage();
  await other.goto('./');
  await expect(other.locator('#board .cell')).toHaveCount(81);
  await expect(other.locator('#mistakes')).toHaveText('0');

  await spoil(page);
  await expect(page.locator('#mistakes')).toHaveText('1');
  expect(JSON.parse(await readRaw(page, SAVE_KEY)).mistakes).toBe(1);

  await other.evaluate(() => {
    const i = values.findIndex((_v, k) => !fixed[k] && values[k] === 0);
    sel = i;
    inputDigit(solution[i]);
  });
  expect(
    JSON.parse(await readRaw(other, SAVE_KEY)).mistakes,
    'the second tab overwrote the first tab count',
  ).toBe(1);

  await solve(other);
  expect(await other.evaluate(() => solved), 'the board did not register as solved').toBe(true);
  await expect(other.locator('#chocos')).toHaveText('0');
  expect(await readWallet(other)).toMatchObject({ fries: NORMAL.fries, choco: 0 });
  expect(problems).toEqual([]);
});

test('the totals survive the reload that used to reset them', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page);
  await solve(page);

  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries * 2));
  expect(await readRaw(page, SAVE_KEY), 'a finished game stayed resumable').toBeNull();

  await page.reload();
  await expect(page.locator('#board .cell')).toHaveCount(81);
  await expect(page.getByRole('dialog', { name: 'SUDOKU' })).toBeVisible();
  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries * 2));
  await expect(page.locator('#chocos')).toHaveText(String(NORMAL.choco));

  await startGame(page);
  await solve(page);
  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries * 4));
  await expect(page.locator('#chocos')).toHaveText(String(NORMAL.choco * 2));
  expect(problems).toEqual([]);
});

test('a win after a hint pays papas fritas only, however clean the grid', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page);

  await page.locator('#hintBtn').click();
  await expect(page.locator('#hints')).toHaveText('1');
  await expect(page.locator('#mistakes'), 'a hint counted as a mistake').toHaveText('0');
  await solve(page);
  expect(await page.evaluate(() => solved), 'the board did not register as solved').toBe(true);

  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries));
  await expect(page.locator('#chocos'), 'a hinted game paid a chocolate').toHaveText('0');
  expect(await readWallet(page)).toMatchObject({ fries: NORMAL.fries, choco: 0 });
  expect(problems).toEqual([]);
});

test('a win in one tab does not overwrite what another tab banked', async ({ page, context }) => {
  const problems = await boot(page);
  await startGame(page);

  const other = await context.newPage();
  const otherProblems = [];
  other.on('pageerror', (error) => otherProblems.push(`uncaught: ${error.message}`));
  await other.goto('./');
  await expect(other.locator('#board .cell')).toHaveCount(81);
  expect(await other.evaluate(() => playing), 'the second tab did not resume').toBe(true);
  expect(await other.evaluate(() => friesTotal), 'the second tab booted with a total').toBe(0);

  await solve(page);
  const first = { fries: NORMAL.fries * 2, choco: NORMAL.choco };
  expect(await readWallet(page)).toMatchObject(first);

  await other.locator('#newBtn').click();
  await other.locator('#startOverlay button.diff[data-d="hard"]').click();
  await expect(other.locator('#startOverlay')).toBeHidden();
  await solve(other);

  const both = { fries: first.fries + HARD.fries * 2, choco: first.choco + HARD.choco };
  expect(await readWallet(other), 'the second win erased the first').toMatchObject(both);

  await expect(page.locator('#fries')).toHaveText(String(both.fries));
  await expect(page.locator('#chocos')).toHaveText(String(both.choco));
  expect(problems).toEqual([]);
  expect(otherProblems).toEqual([]);
});

test('a tab that never hears about the other one still cannot erase it', async ({
  page,
  context,
}) => {
  const problems = await boot(page);
  await startGame(page);

  const deaf = await context.newPage();
  const deafProblems = [];
  deaf.on('pageerror', (error) => deafProblems.push(`uncaught: ${error.message}`));
  await deaf.addInitScript(() => {
    const real = window.addEventListener.bind(window);
    window.addEventListener = (type, ...rest) => {
      if (type !== 'storage') real(type, ...rest);
    };
  });
  await deaf.goto('./');
  await expect(deaf.locator('#board .cell')).toHaveCount(81);

  await solve(page);
  const first = { fries: NORMAL.fries * 2, choco: NORMAL.choco };
  expect(await readWallet(page)).toMatchObject(first);

  expect(await deaf.evaluate(() => friesTotal), 'the deaf tab heard the win').toBe(0);

  await deaf.locator('#newBtn').click();
  await startGame(deaf, 'hard');
  await solve(deaf);

  await expect(deaf.locator('#fries')).toHaveText(String(first.fries + HARD.fries * 2));
  expect(await readWallet(deaf), 'a deaf tab overwrote the other one').toMatchObject({
    fries: first.fries + HARD.fries * 2,
    choco: first.choco + HARD.choco,
  });
  expect(problems).toEqual([]);
  expect(deafProblems).toEqual([]);
});

test('a stored total too large to add to is refused, not carried', async ({ page }) => {
  await page.addInitScript(
    (key) => localStorage.setItem(key, '{"v":1,"fries":1e400,"choco":1e17}'),
    WALLET_KEY,
  );

  const problems = await boot(page);
  await expect(page.locator('#fries')).toHaveText('0');
  await expect(page.locator('#chocos')).toHaveText('0');

  await startGame(page);
  await solve(page);
  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries * 2));
  expect(
    await readWallet(page),
    'the win banked against a total it could not add to',
  ).toMatchObject({ fries: NORMAL.fries * 2, choco: NORMAL.choco });
  expect(problems).toEqual([]);
});

test('a wallet from an unknown version is ignored, not overwritten', async ({ page }) => {
  const planted = { v: WALLET_VERSION + 1, fries: 99, choco: 9 };
  await page.addInitScript(({ key, wallet }) => localStorage.setItem(key, JSON.stringify(wallet)), {
    key: WALLET_KEY,
    wallet: planted,
  });

  const problems = await boot(page);
  await expect(page.locator('#fries')).toHaveText('0');
  await expect(page.locator('#chocos')).toHaveText('0');
  expect(JSON.parse(await readRaw(page, WALLET_KEY)), 'the unknown wallet was clobbered').toEqual(
    planted,
  );

  await startGame(page);
  await solve(page);
  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries * 2));
  expect(
    JSON.parse(await readRaw(page, WALLET_KEY)),
    'winning overwrote a wallet this build cannot read',
  ).toEqual(planted);
  expect(problems).toEqual([]);
});

test('starting the next puzzle mid animation still shows what the win paid', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page);
  await solve(page);

  await page.locator('#newBtn').click();
  await page.locator('#startOverlay button.diff[data-d="easy"]').click();
  await expect(page.locator('#startOverlay')).toBeHidden();

  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries * 2));
  await expect(page.locator('#chocos')).toHaveText(String(NORMAL.choco));
  expect(await readWallet(page)).toMatchObject({
    fries: NORMAL.fries * 2,
    choco: NORMAL.choco,
  });
  expect(problems).toEqual([]);
});

test('starting the next puzzle does not spend the prizes already won', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page);
  await solve(page);
  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries * 2));

  await page.locator('#againBtn').click();
  await expect(page.locator('#winOverlay')).toBeHidden();
  await startGame(page);
  expect(await page.evaluate(() => playing), 'the next puzzle did not start').toBe(true);

  await page.reload();
  await expect(page.locator('#board .cell')).toHaveCount(81);
  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries * 2));
  await expect(page.locator('#chocos')).toHaveText(String(NORMAL.choco));
  expect(problems).toEqual([]);
});

test('a game in progress keeps no prize total of its own', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page);

  const saved = JSON.parse(await readRaw(page, SAVE_KEY));
  expect(
    Object.keys(saved).filter((key) => /fries|choco/iu.test(key)),
    'the game save carries a prize total again, and winning deletes that save',
  ).toEqual([]);
  expect(problems).toEqual([]);
});

test('papas fritas saved by the previous build are carried into the wallet', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page);

  const saved = await readRaw(page, SAVE_KEY);
  await page.addInitScript(
    ({ saveKey, walletKey, save }) => {
      const old = JSON.parse(save);
      old.friesTotal = 37;
      localStorage.setItem(saveKey, JSON.stringify(old));
      localStorage.removeItem(walletKey);
    },
    { saveKey: SAVE_KEY, walletKey: WALLET_KEY, save: saved },
  );

  await page.reload();
  await expect(page.locator('#board .cell')).toHaveCount(81);

  await expect(page.locator('#startOverlay')).toBeHidden();
  expect(await page.evaluate(() => playing), 'the old save stopped restoring').toBe(true);
  await expect(page.locator('#fries')).toHaveText('37');
  await expect(page.locator('#chocos')).toHaveText('0');
  expect(await readWallet(page)).toMatchObject({ fries: 37, choco: 0 });
  expect(problems).toEqual([]);
});
