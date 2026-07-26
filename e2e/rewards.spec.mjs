/* Two prizes, and the ledger that has to outlive them.

   Papas fritas are paid for every win and doubled by the flawless bonus.
   Chocolates are paid only for a flawless win, which is what makes the count
   mean something the papas total cannot say.

   The reload is why these tests are in a browser rather than in the unit
   suite. Both totals used to live inside the game save, and win() calls
   clearSavedGame(), so the prize was paid into a record that was deleted in
   the same function: the counter looked right until the next load, then read
   zero. Only a real reload against real localStorage shows that, and a save
   written by the previous build has to keep its papas on the way across. */

import { expect, test } from '@playwright/test';

const SAVE_KEY = 'sudoku:save';
const WALLET_KEY = 'sudoku:wallet';

/* What the table pays on Normal: ten papas fritas, doubled when flawless, and
   two chocolates for the flawless win only. Written out here rather than read
   from the page, so a table edited by accident fails instead of agreeing with
   itself. */
const NORMAL = { fries: 10, choco: 2 };

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

/* Driven through the game's own entry point rather than 81 clicks: these tests
   are about what winning pays, and the click path is covered elsewhere. */
const solve = (page) =>
  page.evaluate(() => {
    for (let i = 0; i < 81; i++) {
      if (values[i] !== solution[i]) {
        sel = i;
        inputDigit(solution[i]);
      }
    }
  });

/* One wrong digit into the first empty cell, which is all it takes to lose the
   flawless bonus. Solving afterwards overwrites it. */
const spoil = (page) =>
  page.evaluate(() => {
    const i = values.findIndex((v, k) => !fixed[k]);
    sel = i;
    inputDigit((solution[i] % 9) + 1);
  });

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
    v: 1,
    fries: NORMAL.fries * 2,
    choco: NORMAL.choco,
  });

  /* The prize is in the assertive region too. The win modal focuses its own
     button rather than the banner, so this is the announcement that carries
     it to a screen reader. */
  expect(await page.locator('#srAlert').textContent()).toMatch(
    new RegExp(`${NORMAL.fries * 2} papas fritas y ${NORMAL.choco} chocolates`),
  );

  /* And on screen, where the banner is the only place the player is told what
     the flawless bonus was worth. */
  await expect(page.locator('#winOverlay')).toBeVisible();
  const banner = await page.locator('#fryBanner').textContent();
  expect(banner).toContain(`+${NORMAL.fries * 2} papas fritas`);
  expect(banner, 'the flawless bonus is not named').toContain('bono impecable');
  expect(banner).toContain(`${NORMAL.choco} chocolates por partida impecable`);
  expect(banner, 'the running totals are not shown').toContain(
    `llevas ${NORMAL.fries * 2} papas fritas y ${NORMAL.choco} chocolates`,
  );
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
  /* The chip has to stay at zero, not merely fail to reach two: a chocolate
     paid for a spoiled game is the one thing that would make the count
     meaningless. */
  await expect(page.locator('#chocos')).toHaveText('0');
  expect(await readWallet(page)).toMatchObject({ fries: NORMAL.fries, choco: 0 });
  expect(problems).toEqual([]);
});

test('the totals survive the reload that used to reset them', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page);
  await solve(page);

  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries * 2));
  /* Winning deletes the save, which is exactly the deletion that used to take
     the totals with it. */
  expect(await readRaw(page, SAVE_KEY), 'a finished game stayed resumable').toBeNull();

  await page.reload();
  await expect(page.locator('#board .cell')).toHaveCount(81);
  /* Back at the difficulty picker, with the prizes still counted. */
  await expect(page.getByRole('dialog', { name: 'SUDOKU' })).toBeVisible();
  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries * 2));
  await expect(page.locator('#chocos')).toHaveText(String(NORMAL.choco));

  /* And they accumulate: a second flawless win adds to the first. */
  await startGame(page);
  await solve(page);
  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries * 4));
  await expect(page.locator('#chocos')).toHaveText(String(NORMAL.choco * 2));
  expect(problems).toEqual([]);
});

/* The win path rewrites the wallet immediately after clearing the save, so it
   would survive a clearSavedGame() that took the wallet with it. Starting the
   next puzzle clears the save too, and nothing rewrites the wallet afterwards:
   this is the path where that mistake actually costs the player their prizes,
   and it takes a reload before the next win to see it. */
test('starting the next puzzle does not spend the prizes already won', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page);
  await solve(page);
  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries * 2));

  /* "Otra al tiro" reopens the difficulty picker rather than dealing straight
     away, so the new puzzle starts on the pick. */
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
    Object.keys(saved).filter((key) => /fries|choco/i.test(key)),
    'the game save carries a prize total again, and winning deletes that save',
  ).toEqual([]);
  expect(problems).toEqual([]);
});

test('papas fritas saved by the previous build are carried into the wallet', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page);

  /* A save from before the wallet existed, built by playing a real game and
     then putting the old field back: identical in every other respect to what
     the previous build wrote, so restoring it exercises the real path rather
     than a hand written stub.

     Written from an init script rather than straight into storage, because
     leaving the page is itself a save. Reloading hides the document, which
     pauses the game, which writes the live save over the fixture before the
     next document ever boots. An init script runs after that unload and
     before the app, which is the only window where the fixture survives. */
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

  /* The game still resumes, so the carry over costs the player nothing, and
     the papas are now counted where a win can no longer delete them. */
  await expect(page.locator('#startOverlay')).toBeHidden();
  expect(await page.evaluate(() => playing), 'the old save stopped restoring').toBe(true);
  await expect(page.locator('#fries')).toHaveText('37');
  await expect(page.locator('#chocos')).toHaveText('0');
  expect(await readWallet(page)).toMatchObject({ fries: 37, choco: 0 });
  expect(problems).toEqual([]);
});
