/* The record: what the player has played, what they have won, and where the
   prizes went.

   Two things here that no unit test can reach. The generator runs in a worker,
   so whether the board is actually built off the main thread is a fact about a
   real browser and not about the source. And redeeming is the first action in
   this game that destroys something the player earned, so what it takes to fire
   it, and what it leaves behind, is worth holding down in the browser that runs
   it rather than in a regex over index.html. */

import { expect, test } from '@playwright/test';

const WALLET_KEY = 'sudoku:wallet';
const STATS_KEY = 'sudoku:stats';
const WALLET_VERSION = 2;

/* Normal pays ten papas fritas, doubled when flawless, and two chocolates for
   the flawless win only. Written out rather than read from the page, so a table
   edited by accident fails instead of agreeing with itself. */
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
    const i = values.findIndex((v, k) => !fixed[k]);
    sel = i;
    inputDigit((solution[i] % 9) + 1);
  });

const readRaw = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

/* Back to the start dialog and into the record, which is the only way in. */
async function openRecord(page) {
  await page.locator('#recordBtn').click();
  await expect(page.getByRole('dialog', { name: 'TU REGISTRO' })).toBeVisible();
}

/* One row of the table as plain strings: label, played, won, best. */
const recordRow = (page, key) =>
  page.locator(`#recordRows tr`).nth(key).locator('td').allTextContents();

test('the record opens over the start dialog and hands focus back on the way out', async ({
  page,
}) => {
  const problems = await boot(page);

  await openRecord(page);
  /* The dialog behind it is still up: closing this one has to put the player
     back at the difficulty picker rather than at a board they never started. */
  await expect(page.locator('#startOverlay')).toBeVisible();
  await expect(page.locator('#closeRecord')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.locator('#recordOverlay')).toBeHidden();
  await expect(page.locator('#startOverlay')).toBeVisible();
  /* Focus returns to what opened it. Without this it lands on the body and the
     next Tab starts again from the top of the page. */
  await expect(page.locator('#recordBtn')).toBeFocused();
  expect(problems).toEqual([]);
});

test('the difficulty buttons cannot be reached from behind the record', async ({ page }) => {
  /* The overlays are siblings of .app, so inerting .app leaves the dialog
     underneath fully live. Tab used to walk out of the record and into the
     picker it is covering, where Enter started a game: hideOverlay then kept
     .app inert because the record was still up, and the clock ran on a board
     the player could not touch or see. */
  const problems = await boot(page);
  await openRecord(page);
  await expect(page.locator('#closeRecord')).toBeFocused();

  for (let press = 0; press < 4; press++) {
    await page.keyboard.press('Tab');
    const escaped = await page.evaluate(
      () => document.activeElement !== null && document.activeElement.closest('#startOverlay') !== null,
    );
    expect(escaped, 'Tab reached the dialog behind the record').toBe(false);
  }

  /* And the record cannot be opened over a picker that is mid generation, which
     is the same ending reached with the pointer instead of the keyboard. */
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

  await expect(page.locator('#streakLine')).toHaveText('Sin partidas todavía.');
  await expect(page.locator('#recordRows tr')).toHaveCount(4);
  /* The best time column is left empty rather than filled with a placeholder,
     because the zero beside it already explains why there is nothing there. */
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
  /* Whatever the clock said, as long as it is a time and not an empty cell. */
  expect(best).toMatch(/^\d+:\d\d$/);

  await expect(page.locator('#streakLine')).toHaveText('Racha de secas: 1. La mejor: 1.');

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
  /* Back to zero, and the best is kept: the streak is the run of flawless wins,
     which is the only streak that says anything in a game with no way to lose. */
  await expect(page.locator('#streakLine')).toHaveText('Racha de secas: 0. La mejor: 1.');
  expect(await recordRow(page, 1)).toMatchObject(['Normal', '2', '2', expect.anything()]);
  expect(problems).toEqual([]);
});

test('redeeming takes two presses, and the second one empties the balance', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page, 'medium');
  await solve(page);
  await page.locator('#againBtn').click();
  await openRecord(page);

  await expect(page.locator('#purseFries')).toHaveText(String(NORMAL.fries * 2));

  /* One press arms it and changes nothing. Redeeming is the first thing in this
     game that destroys something the player earned, so it does not happen on a
     press that could have been a mis-tap. */
  await page.locator('#redeemFries').click();
  await expect(page.locator('#redeemFries')).toHaveText('¿Seguro?');
  await expect(page.locator('#purseFries')).toHaveText(String(NORMAL.fries * 2));
  await expect(page.locator('#fries')).toHaveText(String(NORMAL.fries * 2));

  await page.locator('#redeemFries').click();
  await expect(page.locator('#purseFries')).toHaveText('0');
  await expect(page.locator('#redeemFries')).toHaveText('Canjear');
  await expect(page.locator('#redeemFries')).toBeDisabled();
  /* The chip in the status bar is the same wallet seen from the game. */
  await expect(page.locator('#fries')).toHaveText('0');
  /* The chocolates are a separate balance and are not touched. */
  await expect(page.locator('#chocos')).toHaveText(String(NORMAL.choco));

  const stored = JSON.parse(await readRaw(page, WALLET_KEY));
  expect(stored).toMatchObject({ v: WALLET_VERSION, fries: 0, choco: NORMAL.choco });
  /* The win and the payout, in that order, both still on the record. */
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

  /* The armed state belongs to the prize it was armed for. A press on the other
     button arms that one instead of firing the first. */
  await page.locator('#redeemChoco').click();
  await expect(page.locator('#redeemChoco')).toHaveText('¿Seguro?');
  await expect(page.locator('#redeemFries')).toHaveText('Canjear');
  await expect(page.locator('#purseFries')).toHaveText(String(NORMAL.fries * 2));
  await expect(page.locator('#purseChoco')).toHaveText(String(NORMAL.choco));
  expect(problems).toEqual([]);
});

test('a wallet from the build before the ledger keeps its totals', async ({ page }) => {
  /* Version 1 is the same two totals with no history. Refusing it the way an
     unknown version is refused would have zeroed the wallet of every player who
     had one, on the first load of this build. */
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

  /* And the migration is written back on the first thing that touches it,
     carrying the old totals rather than starting them over. */
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
  /* Unlike the wallet, there is nothing here worth refusing to overwrite: a
     lost streak is not a lost prize. What matters is that a stats blob from
     somewhere else cannot put NaN on screen or be written back. */
  await page.addInitScript(
    (key) => localStorage.setItem(key, '{"v":9,"d":{"easy":{"played":"lots"}},"streak":"many"}'),
    STATS_KEY,
  );

  const problems = await boot(page);
  await openRecord(page);
  await expect(page.locator('#streakLine')).toHaveText('Sin partidas todavía.');
  expect(await recordRow(page, 0)).toEqual(['Piola', '0', '0', '']);
  expect(problems).toEqual([]);
});

test('the board is built in a worker, off the main thread', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page, 'medium');

  /* generator.js was fetched, and not by the fallback: index.html only injects
     a script tag for it when constructing the worker throws. */
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
  /* The fallback, which is not decoration: some engines refuse to construct a
     worker for a file:// document, and a hardened configuration or an extension
     can block it outright. Without this path those players get no game at all. */
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
  /* The thrown Worker constructor is caught, so nothing reaches the console. */
  expect(problems).toEqual([]);
});

test('a board that cannot be built at all says so instead of hanging', async ({ page }) => {
  /* Both paths gone: no worker, and the file the fallback would inject never
     arrives. The dialog has to come back and say why, rather than sit there
     with its buttons disabled forever.

     The service worker is turned off as well, and that is worth spelling out
     because it is a third way to the file rather than a detail of the harness:
     sw.js precaches generator.js and answers from that cache, so with it running
     this test passed by serving the very file the route below is refusing. */
  await page.addInitScript(() => {
    delete Navigator.prototype.serviceWorker;
    window.Worker = function BlockedWorker() {
      throw new Error('workers are blocked here');
    };
  });
  await page.route('**/generator.js', (route) => route.abort());

  const problems = await boot(page);
  await page.locator('#startOverlay button.diff[data-d="medium"]').click();

  await expect(page.locator('#genStatus')).toHaveText('No se pudo armar el tablero. Probá de nuevo.');
  await expect(page.locator('#startOverlay')).toBeVisible();
  /* And the buttons are handed back, so "probá de nuevo" is something the
     player can actually do. */
  await expect(page.locator('#startOverlay button.diff[data-d="medium"]')).toBeEnabled();
  /* The failure is reported to the player, not thrown: nothing from this page's
     own code reaches the console. The browser's own note about the request this
     test blocked is not that, and is the one thing allowed through here. */
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
  /* The grade the board was measured at, not the one the difficulty asked for:
     the pares tier is narrow and the search lands beside it often enough that
     showing the request would be a lie about one board in seven. */
  await expect(page.locator('#wGrade')).toHaveText(expected.word);
  await expect(page.locator('#wCode')).toHaveText(expected.code);
  expect(problems).toEqual([]);
});
