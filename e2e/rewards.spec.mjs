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

  /* And on screen. The banner is icons and numbers, so what is asserted is the
     pair of amounts and the bonus badge, not a sentence. */
  await expect(page.locator('#winOverlay')).toBeVisible();
  const amounts = await page.locator('#fryBanner b').allTextContents();
  expect(amounts, 'the banner does not show both prizes').toEqual([
    `🍟 +${NORMAL.fries * 2}`,
    `🍫 +${NORMAL.choco}`,
  ]);
  /* The amounts are the finals, doubling included, with nothing beside them to
     apply to the wrong number. */
  await expect(page.locator('#fryBanner i'), 'the banner grew a badge again').toHaveCount(0);

  /* The words are gone from the screen, not from the page: everything visible
     in there is aria-hidden, so a screen reader gets the sentence instead. */
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

/* The other half of the flawless rule. A mutation that made the chocolate
   depend on mistakes alone, ignoring hints, kept both suites green: no spec
   took a hint and then won. The rule is what gives the prize its meaning, so
   both halves need holding down. */
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

/* Two tabs, which is how the wallet used to lose prizes. Each tab read its
   totals once at boot, and a win wrote those totals back wholesale, so the
   second tab to win erased whatever the first had banked. */
test('a win in one tab does not overwrite what another tab banked', async ({ page, context }) => {
  const problems = await boot(page);
  await startGame(page);

  /* Opened before the first win, so its in-memory totals are zero: exactly the
     stale state that used to be written over the top of a real total. */
  const other = await context.newPage();
  const otherProblems = [];
  other.on('pageerror', (error) => otherProblems.push(`uncaught: ${error.message}`));
  await other.goto('./');
  await expect(other.locator('#board .cell')).toHaveCount(81);
  /* One origin, one save, so this tab resumes the game the first one is
     playing rather than opening the picker. What matters is when it read the
     wallet: now, while both totals are still zero. */
  expect(await other.evaluate(() => playing), 'the second tab did not resume').toBe(true);
  expect(await other.evaluate(() => friesTotal), 'the second tab booted with a total').toBe(0);

  await solve(page);
  const first = { fries: NORMAL.fries * 2, choco: NORMAL.choco };
  expect(await readWallet(page)).toMatchObject(first);

  await other.locator('#newBtn').click();
  await other.locator('#startOverlay button.diff[data-d="hard"]').click();
  await expect(other.locator('#startOverlay')).toBeHidden();
  await solve(other);

  /* Both wins, added, not the second one alone. */
  const both = { fries: first.fries + HARD.fries * 2, choco: first.choco + HARD.choco };
  expect(await readWallet(other), 'the second win erased the first').toMatchObject(both);

  /* And the tab that did not win notices, so its chips do not sit on a number
     the wallet no longer holds and write it back at the next win. */
  await expect(page.locator('#fries')).toHaveText(String(both.fries));
  await expect(page.locator('#chocos')).toHaveText(String(both.choco));
  expect(problems).toEqual([]);
  expect(otherProblems).toEqual([]);
});

/* The test above passes on the storage listener alone: the second tab hears
   about the first tab's win and adopts its totals before winning itself. The
   other half of the fix is for the tab that never hears anything, because it
   was frozen, discarded, or restored from the back forward cache. Banking has
   to re-read the key rather than trust what this tab last saw. */
test('a tab that never hears about the other one still cannot erase it', async ({
  page,
  context,
}) => {
  const problems = await boot(page);
  await startGame(page);

  const deaf = await context.newPage();
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

  /* Still on zero: it heard nothing, which is the whole point of this tab. */
  expect(await deaf.evaluate(() => friesTotal), 'the deaf tab heard the win').toBe(0);

  await deaf.locator('#newBtn').click();
  await deaf.locator('#startOverlay button.diff[data-d="hard"]').click();
  await solve(deaf);

  /* It goes straight from zero to the combined total rather than to its own
     winnings: banking re-reads the key, so the tab corrects itself as it pays. */
  await expect(deaf.locator('#fries')).toHaveText(String(first.fries + HARD.fries * 2));
  expect(await readWallet(deaf), 'a deaf tab overwrote the other one').toMatchObject({
    fries: first.fries + HARD.fries * 2,
    choco: first.choco + HARD.choco,
  });
  expect(problems).toEqual([]);
});

/* A wallet this build cannot read belongs to some other build, very likely a
   newer one the player still has cached. Zeroing it would be worse than
   showing nothing, so it is read as absent and left where it is. */
test('a wallet from an unknown version is ignored, not overwritten', async ({ page }) => {
  const planted = { v: 2, fries: 99, choco: 9 };
  await page.addInitScript(
    ({ key, wallet }) => localStorage.setItem(key, JSON.stringify(wallet)),
    { key: WALLET_KEY, wallet: planted },
  );

  const problems = await boot(page);
  await expect(page.locator('#fries')).toHaveText('0');
  await expect(page.locator('#chocos')).toHaveText('0');
  expect(JSON.parse(await readRaw(page, WALLET_KEY)), 'the unknown wallet was clobbered').toEqual(
    planted,
  );
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
