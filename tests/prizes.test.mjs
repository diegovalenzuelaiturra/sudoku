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
/* The game is app.js, which the build inlines into the published page. The
   markup it drives is still index.html, and the chip test below reads that. */
const source = readFileSync(join(root, 'app.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

/* The difficulties in the order the start dialog offers them, which is also
   the order the payouts have to be non-decreasing in. */
const ORDER = ['easy', 'medium', 'hard', 'expert'];

/* Read per entry rather than by position, so reordering the fields inside a
   row is not a failure. Losing one is. */
function prizeTable() {
  const literal = source.match(/const DIFF\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(literal, 'the DIFF table is not where this test expects to find it');

  const rows = new Map();
  for (const [, key, body] of literal[1].matchAll(/(\w+):\s*\{([^}]*)\}/g)) {
    const fries = body.match(/fries:\s*(\d+)/);
    const choco = body.match(/choco:\s*(\d+)/);
    rows.set(key, {
      fries: fries === null ? null : Number(fries[1]),
      choco: choco === null ? null : Number(choco[1]),
    });
  }
  return rows;
}

/* The body of a top level function declaration, closing brace included. Every
   function this file inspects is written flush against the left margin, so the
   first unindented brace ends it.

   Two ways that goes wrong quietly, and both are guarded rather than trusted.

   The parameter list is matched up to the opening brace, not up to the first
   `)`. A default argument puts a `)` inside the parentheses, and the narrower
   pattern then matched nothing at all: readWallet(raw=walletRaw()) is already
   such a signature.

   And braces are counted. Two of the assertions below are assert.doesNotMatch,
   which pass on a fragment exactly as readily as on the whole function, so a
   `}` reaching column 0 mid function would not fail this file, it would empty
   it: the guards would keep passing while guarding a few lines. assert.ok on
   the match cannot see that, because a truncated body is still a match. */
function body(name) {
  const found = source.match(new RegExp(`function ${name}\\([^{]*\\)\\s*\\{[\\s\\S]*?\\n\\}`));
  assert.ok(found, `${name}() is not where this test expects to find it`);

  let depth = 0;
  for (const character of found[0]) {
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
  }
  assert.equal(
    depth,
    0,
    `${name}() was read as far as a brace in column 0 and no further, so every ` +
      'assert.doesNotMatch below it is now guarding a fragment',
  );
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
    const line = html.split('\n').find((text) => text.includes(`id="${chip}"`));
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
    /readWallet\(/,
    "bankPrize() writes this tab's totals blind, which erases a prize banked by another tab",
  );
});

/* The other half of that read. loadWallet() deliberately leaves a wallet it
   cannot parse where it is, on the grounds that it belongs to a newer build the
   player still has cached. That promise is only worth having if banking honours
   it too: the version check makes readWallet() return null for a newer wallet
   and for dead storage alike, so a bankPrize() that writes on every null wrote
   this tab's zero plus the prize straight over the newer record. */
test('banking refuses to overwrite a wallet this build cannot read', () => {
  const bank = body('bankPrize');
  assert.match(
    bank,
    /walletRaw\(\)/,
    'bankPrize() cannot tell an absent wallet from an unreadable one',
  );
  assert.match(
    bank,
    /if\s*\([^)]*\)\s*\{?\s*saveWallet\(\)/,
    'bankPrize() saves unconditionally, so the first win destroys a newer wallet',
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
