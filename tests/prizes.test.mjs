/* The prize table, and the two rules that make a second prize worth having.

   What a win actually pays is behaviour, and e2e/rewards.spec.mjs owns it in a
   real browser. What is worth pinning here is the shape a reader would
   otherwise have to take on trust: that every difficulty pays both prizes,
   that a harder puzzle never pays less than an easier one, and that the totals
   stay out of the game save. That last one is not a style preference. win() is
   both what pays a prize and what calls clearSavedGame(), so a total kept in
   the save is a total deleted moments after it is earned. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'index.html'), 'utf8');

/* The difficulties in the order the start dialog offers them, which is also
   the order the payouts have to be non-decreasing in. */
const ORDER = ['easy', 'medium', 'hard', 'expert'];

/* Read per entry rather than by position, so reordering the fields inside a
   row is not a failure. Losing one is. */
function prizeTable() {
  const literal = source.match(/const DIFF=\{(.+)\};/);
  assert.ok(literal, 'the DIFF table is not where this test expects to find it');

  const rows = new Map();
  for (const [, key, body] of literal[1].matchAll(/(\w+):\{([^}]*)\}/g)) {
    const fries = body.match(/fries:(\d+)/);
    const choco = body.match(/choco:(\d+)/);
    rows.set(key, {
      fries: fries === null ? null : Number(fries[1]),
      choco: choco === null ? null : Number(choco[1]),
    });
  }
  return rows;
}

/* The body of a top level function declaration, closing brace included. Every
   function this file inspects is written flush against the left margin, so the
   first unindented brace ends it. */
function body(name) {
  const found = source.match(new RegExp(`function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`));
  assert.ok(found, `${name}() is not where this test expects to find it`);
  return found[0];
}

/* What each difficulty pays, pinned. The monotonic rule below says a harder
   puzzle may not pay less; it does not notice three of the four rows being
   wrong together, which a mutation campaign confirmed. */
const PAYOUTS = {
  easy: { fries: 5, choco: 1 },
  medium: { fries: 10, choco: 2 },
  hard: { fries: 15, choco: 3 },
  expert: { fries: 25, choco: 5 },
};

test('every difficulty pays both prizes, in the published amounts', () => {
  const rows = prizeTable();
  assert.deepEqual([...rows.keys()], ORDER, 'the difficulties are not the four the game offers');

  for (const [key, { fries, choco }] of rows) {
    assert.ok(fries !== null && fries > 0, `${key} pays no papas fritas`);
    assert.ok(choco !== null && choco > 0, `${key} pays no chocolates`);
  }
  assert.deepEqual(Object.fromEntries(rows), PAYOUTS, 'the prize table changed');
});

test('a harder puzzle never pays less than an easier one', () => {
  const rows = prizeTable();
  for (let i = 1; i < ORDER.length; i++) {
    const easier = rows.get(ORDER[i - 1]);
    const harder = rows.get(ORDER[i]);
    assert.ok(
      harder.fries >= easier.fries,
      `${ORDER[i]} pays ${harder.fries} papas fritas, less than ${ORDER[i - 1]} at ${easier.fries}`,
    );
    assert.ok(
      harder.choco >= easier.choco,
      `${ORDER[i]} pays ${harder.choco} chocolates, less than ${ORDER[i - 1]} at ${easier.choco}`,
    );
  }
});

test('each prize has a chip, and the chip has an accessible name', () => {
  /* The emoji carries the meaning on screen and nothing at all to a screen
     reader, so the visually hidden name beside it is the whole label. */
  const chips = [
    { chip: 'frychip', count: 'fries', name: 'papas fritas' },
    { chip: 'chocochip', count: 'chocos', name: 'chocolates' },
  ];

  for (const { chip, count, name } of chips) {
    const line = source.split('\n').find((text) => text.includes(`id="${chip}"`));
    assert.ok(line, `the status bar has no ${chip}`);
    assert.match(line, new RegExp(`<b id="${count}">`), `${chip} has no counter to paint`);
    assert.match(
      line,
      new RegExp(`class="visually-hidden">[^<]*${name}`),
      `${chip} is an emoji with no accessible name`,
    );
  }
});

test('the prize totals are kept out of the game save', () => {
  assert.doesNotMatch(
    body('saveGame'),
    /friesTotal|chocoTotal/,
    'saveGame() writes a prize total again, and a win deletes that save moments after paying it',
  );
});

test('the prize is banked before the animation timers, never on one', () => {
  const win = body('win');
  const scheduled = win.indexOf('setTimeout');
  assert.ok(scheduled > 0, 'win() schedules nothing, so this test no longer means anything');
  assert.match(
    win.slice(0, scheduled),
    /bankPrize\(/,
    'the prize is banked on a timer, so closing the tab during the animation loses it',
  );
});

test('banking a prize consults the stored wallet, not just this tab', () => {
  assert.match(
    body('bankPrize'),
    /readWallet\(\)/,
    'bankPrize() writes this tab\'s totals blind, which erases a prize banked by another tab',
  );
});

test('finishing a game clears the save without touching the wallet', () => {
  assert.doesNotMatch(
    body('clearSavedGame'),
    /WALLET_KEY/,
    'clearSavedGame() removes the wallet too, so every win would wipe the totals it just paid',
  );
  assert.match(body('saveWallet'), /WALLET_KEY/, 'saveWallet() does not write the wallet key');
});
