import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const source = readFileSync(join(root, 'app.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

const ORDER = ['easy', 'medium', 'hard', 'expert'];

function prizeTable() {
  const literal = source.match(/const DIFF\s*=\s*\{([\s\S]*?)\n\};/u);
  assert.ok(literal, 'the DIFF table is not where this test expects to find it');

  const rows = new Map();
  for (const [, key, row] of literal[1].matchAll(/(\w+):\s*\{([^}]*)\}/gu)) {
    const fries = row.match(/fries:\s*(\d+)/u);
    const choco = row.match(/choco:\s*(\d+)/u);
    rows.set(key, {
      fries: fries === null ? null : Number(fries[1]),
      choco: choco === null ? null : Number(choco[1]),
    });
  }
  return rows;
}

// MUST KILL: body() finds the function end with a regex and a brace count, so flush-left functions are load bearing; use a real parser
function body(name) {
  const found = source.match(new RegExp(`function ${name}\\([^{]*\\)\\s*\\{[\\s\\S]*?\\n\\}`, 'u'));
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
  const chips = [
    { chip: 'frychip', count: 'fries', name: 'papas fritas' },
    { chip: 'chocochip', count: 'chocos', name: 'chocolates' },
  ];

  for (const { chip, count, name } of chips) {
    const line = html.split('\n').find((text) => text.includes(`id="${chip}"`));
    assert.ok(line, `the status bar has no ${chip}`);
    assert.match(line, new RegExp(`<b id="${count}">`, 'u'), `${chip} has no counter to paint`);
    assert.match(
      line,
      new RegExp(`class="visually-hidden">[^<]*${name}`, 'u'),
      `${chip} is an emoji with no accessible name`,
    );
  }
});

test('the prize totals are kept out of the game save', () => {
  assert.doesNotMatch(
    body('saveGame'),
    /friesTotal|chocoTotal/u,
    'saveGame() writes a prize total again, and a win deletes that save moments after paying it',
  );
});

test('the prize is banked before the animation timers, never on one', () => {
  const win = body('win');
  const scheduled = win.indexOf('setTimeout');
  assert.ok(scheduled > 0, 'win() schedules nothing, so this test no longer means anything');
  assert.match(
    win.slice(0, scheduled),
    /bankPrize\(/u,
    'the prize is banked on a timer, so closing the tab during the animation loses it',
  );
});

test('banking a prize consults the stored wallet, not just this tab', () => {
  assert.match(
    body('bankPrize'),
    /readWallet\(/u,
    "bankPrize() writes this tab's totals blind, which erases a prize banked by another tab",
  );
});

test('banking refuses to overwrite a wallet this build cannot read', () => {
  const bank = body('bankPrize');
  assert.match(
    bank,
    /walletRaw\(\)/u,
    'bankPrize() cannot tell an absent wallet from an unreadable one',
  );
  assert.match(
    bank,
    /if\s*\([^)]*\)\s*\{?\s*saveWallet\(\)/u,
    'bankPrize() saves unconditionally, so the first win destroys a newer wallet',
  );
});

test('finishing a game clears the save without touching the wallet', () => {
  assert.doesNotMatch(
    body('clearSavedGame'),
    /WALLET_KEY/u,
    'clearSavedGame() removes the wallet too, so every win would wipe the totals it just paid',
  );
  assert.match(body('saveWallet'), /WALLET_KEY/u, 'saveWallet() does not write the wallet key');
});
