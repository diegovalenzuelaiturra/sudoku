import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const source = readFileSync(join(root, 'app.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

const require = createRequire(import.meta.url);
require(join(root, 'stats.js'));
const S = globalThis.SudokuStats;
delete globalThis.SudokuStats;

const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[ \t]*\/\/.*$/gmu, '');
const code = strip(source);

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

test('the finished games have their own key, and their own version on it', () => {
  assert.match(
    code,
    /const HISTORY_KEY = 'sudoku:history',\s*HISTORY_VERSION = 1;/u,
    'the history key or its version moved, and every game a player has finished is now under a name nothing reads',
  );
  const declared = code.match(/const \w+_KEY = 'sudoku:[a-z]+'/gu) || [];
  const keys = [...new Set(code.match(/'sudoku:[a-z]+'/gu))];
  assert.equal(
    keys.length,
    declared.length,
    `two storage keys are now the same string, so one writer erases the other: ${keys.join(', ')}`,
  );
  assert.ok(keys.includes("'sudoku:history'"), 'the games are stored under one of the other keys');
});

test('the ring is bounded, and wide enough for a trend at every level', () => {
  assert.match(
    body('logGame'),
    /slice\(-SudokuStats\.HISTORY_MAX\)/u,
    'the ring grows without end, so the key swells until the write throws and the newest game is the one lost',
  );
  assert.ok(
    Number.isSafeInteger(S.HISTORY_MAX) && S.HISTORY_MAX > 0,
    `HISTORY_MAX is ${S.HISTORY_MAX}, which bounds nothing`,
  );
  assert.ok(
    S.HISTORY_MAX >= S.MIN_TREND_N * S.MAX_GRADE,
    `a ring of ${S.HISTORY_MAX} cannot hold ${S.MIN_TREND_N} games at each of ${S.MAX_GRADE} grades, so a player who spreads their games across the ladder is told nothing about any level`,
  );
});

test('the reader refuses a version it has never heard of', () => {
  const read = body('readHistory');
  assert.match(
    read,
    /h\.v !== HISTORY_VERSION\) return null;/u,
    'readHistory() accepts any version, so rows written in a shape this build does not know are read as if it did',
  );
  assert.match(
    read,
    /!h \|\| typeof h !== 'object'/u,
    'readHistory() reads fields off whatever JSON.parse returned, and a stored string or number answers undefined to all of them',
  );
  assert.match(
    read,
    /try \{\s*h = JSON\.parse\(raw\);\s*\} catch \{\s*return null;\s*\}/u,
    'a hand edited key now throws out of readHistory(), which runs at boot before loadGame() and would cost the player their saved game',
  );
});

test('reading the games never writes them back', () => {
  for (const name of ['historyRaw', 'readHistory', 'loadHistory']) {
    assert.doesNotMatch(
      body(name),
      /setItem|saveHistory\(/u,
      `${name}() writes, so a boot under a build that cannot read the stored games destroys them`,
    );
  }
  assert.match(
    body('loadHistory'),
    /const stored = readHistory\(\);\s*if \(stored\) games = stored;/u,
    'loadHistory() adopts what readHistory() refused, or replaces it with something of its own',
  );
});

test('every stored field comes back through the clamp', () => {
  const read = body('readHistory');
  assert.match(
    read,
    /return SudokuStats\.readRows\(h\.games, Object\.keys\(DIFF\)\)/u,
    'the stored rows reach the report unchecked, and every one of them is a number a player can type into the console',
  );
  assert.doesNotMatch(
    read,
    /return h\.games/u,
    'readHistory() hands back the parsed array itself, so a row of strings is counted as a game and a planted length is a report of nothing',
  );
  assert.ok(
    S.readRow({ t: 1, s: -5, m: 0, h: 0, g: 1, d: 'easy' }) === null &&
      S.readRow({ t: 1, s: 10, m: 0, h: 0, g: 99, d: 'nope' }).g === 0,
    'the clamp readHistory() leans on no longer rejects an impossible time or an unknown grade',
  );
});

test('a finished game is appended to what storage holds, not to this tab alone', () => {
  const record = body('recordGame');
  const readBack = record.indexOf('historyRaw()');
  const written = record.indexOf('games = logGame(');
  assert.ok(readBack > 0, 'recordGame() no longer reads the stored bytes at all');
  assert.ok(
    readBack < written,
    'recordGame() builds the new ring before it reads the stored one, so two open tabs erase each other',
  );
  assert.match(
    record,
    /const base = stored \|\| games;/u,
    'recordGame() appends to the copy this tab holds, which is stale the moment another tab finishes a board',
  );
});

test('a game is written down only over bytes this build could read', () => {
  const record = body('recordGame');
  assert.match(
    record,
    /const raw = historyRaw\(\);/u,
    'recordGame() cannot tell an empty key from one holding bytes it refused, and those two need opposite answers',
  );
  assert.match(
    record,
    /if \(stored \|\| raw === null\) saveHistory\(\);/u,
    'the write is no longer conditional on the read having worked',
  );
  assert.doesNotMatch(
    record,
    /\n\s*saveHistory\(\);/u,
    'recordGame() saves unguarded somewhere, so one win replaces the games of a newer build the player still has cached with this one row',
  );
});

test('the game is written down beside the prize, never on a timer', () => {
  const win = body('win');
  const scheduled = win.indexOf('setTimeout');
  const logged = win.indexOf('recordGame(');
  assert.ok(logged > 0, 'win() no longer writes the finished board down');
  assert.ok(
    scheduled > logged,
    'the game is recorded on an animation timer, so a player who closes the tab during the rain has won a board nothing counted',
  );
});

test('the lifetime record keeps its version and its shape', () => {
  assert.match(
    code,
    /const STATS_KEY = 'sudoku:stats',\s*STATS_VERSION = 1;/u,
    'STATS_VERSION moved, which deletes the played, won, best and streak of every player who already has a record',
  );
  const blank = body('blankStats');
  assert.match(
    blank,
    /rows\[key\] = \{ played: 0, won: 0, best: 0 \};/u,
    'a difficulty row lost or gained a field, and readStats() copies the stored numbers into this shape',
  );
  assert.match(
    blank,
    /return \{ v: STATS_VERSION, d: rows, streak: 0, bestStreak: 0 \};/u,
    'the record shape changed without the version moving, so an old key is read into a shape it does not fill',
  );
});

test('the wake lock is asked for only where the platform has one', () => {
  const wake = body('syncWakeLock');
  assert.match(
    wake,
    /^function syncWakeLock\(\) \{\s*if \(!navigator\.wakeLock\?\.request\) return;/u,
    'the feature detection is no longer the first thing syncWakeLock() does, and the floor here is Safari 15.4, which has no wakeLock at all',
  );
  const everywhere = code.match(/navigator\.wakeLock/gu) || [];
  const inside = strip(wake).match(/navigator\.wakeLock/gu) || [];
  assert.equal(
    everywhere.length,
    inside.length,
    'something outside syncWakeLock() reaches for navigator.wakeLock, where the detection that guards it is not',
  );
  assert.match(
    wake,
    /\.request\('screen'\)/u,
    "the lock type is not the literal 'screen': leaving it out leans on a spec default newer than the browsers that have the API, and any other string throws a TypeError on the spot",
  );
});

test('every wake lock promise ends in a rejection handler', () => {
  const wake = strip(body('syncWakeLock'));
  assert.match(
    wake,
    /\.request\('screen'\)[\s\S]*\.catch\(\(\) => \{\s*wakeLockPending = false;\s*\}\);\s*\}$/u,
    'the request chain no longer ends in a rejection handler that clears the pending flag',
  );
  assert.doesNotMatch(
    code,
    /\.release\(\)(?!\s*\.catch\()/u,
    'a sentinel is released with nothing catching, and releasing one the platform already revoked rejects',
  );
  assert.doesNotMatch(
    wake,
    /console\./u,
    'the wake lock logs, and a missing lock is not something a player can act on',
  );
});

test('the screen is held awake only while the clock runs', () => {
  assert.match(
    body('syncWakeLock'),
    /wakeLockWanted = playing && !paused && !solved && !document\.hidden;/u,
    'the lock outlives the game it belongs to: held over a pause, a win overlay, a dialog or the difficulty picker it burns battery on a board nobody is reading',
  );
  assert.match(
    body('setPaused'),
    /syncWakeLock\(\);/u,
    'pausing and resuming no longer move the lock, which is the one place the game funnels both through',
  );
  assert.match(
    body('win'),
    /syncWakeLock\(\);/u,
    'winning no longer releases the lock, and setPaused() returns early once solved is set, so nothing else will',
  );
  assert.match(
    code,
    /addEventListener\('visibilitychange',[\s\S]{0,200}?syncWakeLock\(\);/u,
    'a tab hidden after the board is won keeps its lock: setPaused() returns early there, so this listener is the only release path left',
  );
  assert.match(
    body('saveGame'),
    /syncWakeLock\(\);/u,
    'a lock the platform revoked mid board is never asked for again, and the player finishes the board with the screen dimming',
  );
});

test('the personal best is the answer recordWin gave, and a first win is not one', () => {
  const record = body('recordWin');
  assert.match(
    record,
    /const first = row\.won === 0;/u,
    'the first win is decided some other way. A best time of zero is a real if unlikely value, so a count of wins is the only thing that can say whether there was a time to beat',
  );
  assert.match(
    record,
    /const beat = !first && time < row\.best;/u,
    'a first win counts as a personal best, which steals the message from every first flawless win, the rarer thing and the one worth saying',
  );
  assert.match(
    record,
    /streak: held > 0 && stats\.bestStreak > held && streakMilestone\(stats\.streak\),/u,
    'recordWin() no longer answers both records, and neither comparison can be made anywhere else: both have to be read before the counts move',
  );
  assert.match(
    source,
    /const streakMilestone = \(run\) => run === 3 \|\| \(run >= 5 && run % 5 === 0\);/u,
    'every extension of a best streak is announced again, which is a shower on nearly every flawless win',
  );
  assert.match(
    record,
    /const held = stats\.bestStreak;/u,
    'the best streak is read after it moves, so every first flawless win reports a record',
  );
  assert.match(
    body('win'),
    /const broke = recordWin\(/u,
    'win() decides the records beside the call instead of asking for them, which is two copies of one test that agree only while the lines stay in this order',
  );
});

test('a personal best pays nothing', () => {
  const win = strip(body('win'));
  const paid = win.indexOf('bankPrize(');
  const decided = win.indexOf('const broke');
  assert.ok(paid > 0 && decided > paid, 'the prize is banked after the records are known');
  for (const line of win.split('\n').filter((text) => /beatBest|beatStreak/u.test(text))) {
    assert.doesNotMatch(
      line,
      /bankPrize|earned|fries|choco|papas|Total/u,
      `a record now pays: ${line.trim()}`,
    );
  }
  assert.doesNotMatch(
    body('bankPrize'),
    /beatBest|beatStreak/u,
    'the wallet knows about a record, which is a second paying axis with none of the clamps the first one has',
  );
});

test('both records reach the dialog and the announcement', () => {
  const win = body('win');
  assert.match(
    win,
    /\$\('wBestLine'\)\.hidden = !beatBest;/u,
    'the personal best line is shown on every win, or on none',
  );
  assert.match(
    win,
    /\$\('wStreakLine'\)\.hidden = !flawless;/u,
    'the run is back to being shown only when it breaks a record, which leaves every other clean win saying nothing about a counter it moved',
  );
  assert.match(
    win,
    /\$\('wTimeStat'\)\.classList\.toggle\('record', beatBest\);/u,
    'the time tile is no longer marked, so the record names no number and the player is left to guess which of the three moved',
  );
  assert.match(
    win,
    /\$\('srAlert'\)\.textContent =\s*`Ganaste\./u,
    'the win announcement no longer opens with Ganaste., which e2e/interface.spec.mjs reads as the first word of it',
  );
  assert.match(
    win,
    /\(beatBest \? ' ¡Nuevo récord de tiempo!' : ''\)/u,
    'the assertive announcement drops the time record, and it is the only announcement that reliably carries anything: showOverlay() focuses the button, not the banner',
  );
  assert.match(
    win,
    /\(flawless \? ` \$\{streakSaid\(streakNow, beatStreak\)\}` : ''\)/u,
    'the assertive announcement drops the run, so a player who cannot see the line is told about the streak only when it breaks a record',
  );
  assert.match(
    source,
    /run === 1\s*\?\s*'Va 1 seca\.'\s*:\s*`Van \$\{run\} secas seguidas\.`/u,
    'the run reads as a plural whatever it is worth, or the singular lost its own wording',
  );
  assert.doesNotMatch(
    body('paintRecord'),
    /🏆|bestMark|freshBest/u,
    'the record table marks the best time again, where the trophy sat against the number and said nothing a reader could place',
  );
});

test('the two records are told apart by glyph, and both rain', () => {
  const win = body('win');
  assert.match(
    win,
    /if \(beatBest\) winTimers\.push\(setTimeout\(\(\) => rain\(6, '🏆'\)/u,
    'a new best time no longer rains trophies',
  );
  assert.match(
    win,
    /if \(beatStreak\) winTimers\.push\(setTimeout\(\(\) => rain\(6, '🥇'\)/u,
    'a new best streak no longer rains medals',
  );
  const moving = win.match(/if \(!reduceMotion\.matches\) \{[\s\S]*?\n {2}\}/u);
  assert.ok(moving, 'the reduced motion branch is not where this test expects it');
  assert.match(moving[0], /'🏆'/u, 'the trophy shower runs for a player who asked for no motion');
  assert.match(moving[0], /'🥇'/u, 'the medal shower runs for a player who asked for no motion');
});

test('both record lines are in the markup, hidden until they are true', () => {
  assert.match(
    html,
    /id="wBestLine"\s+hidden\s*>/u,
    'the personal best line is not hidden by default, so it shows on the first win before app.js touches it',
  );
  assert.match(
    html,
    /id="wStreakLine"\s+hidden\s*>/u,
    'the best streak line is not hidden by default, so it shows on the first win before app.js touches it',
  );
  assert.match(
    html,
    /hidden\s*><span aria-hidden="true">🏆<\/span> <b>¡Nuevo récord de tiempo!<\/b><\/p>/u,
    'the personal best line lost its aria-hidden trophy or the word that says which number it is about',
  );
  assert.match(
    html,
    /hidden\s*><span\s+id="wStreakGlyph"\s+aria-hidden="true"\s*>🔥<\/span> <b id="wStreakText">/u,
    'the streak line lost one of the two holes app.js writes into: the glyph that separates a record from a count, and the sentence itself',
  );
  assert.match(
    html,
    /🔥 <b id="streakNow">0<\/b> <span id="streakNowWord">seguidas<\/span> 🥇 mejor <b id="streakBest">0<\/b>/u,
    'the best streak is a trophy again, which is the glyph the best time already uses',
  );
  assert.match(
    html,
    /<div class="stat" id="wTimeStat"><b id="wTime">/u,
    'the time tile lost the hook the record marker is put on',
  );
  assert.match(
    html,
    /\.modal \.stat\.record\{/u,
    'the marked tile has no style, so a record marks nothing the player can see',
  );
});

test('the games another tab finished are adopted, and only when readable', () => {
  const found = source.match(/addEventListener\('storage',[\s\S]*?\n\}\);/u);
  assert.ok(found, 'the storage listener is not where this test expects to find it');
  const listener = found[0];
  const adopts = listener.indexOf('e.key === HISTORY_KEY');
  const walletGate = listener.indexOf('e.key !== WALLET_KEY');
  assert.ok(
    adopts > 0,
    'a game finished in another tab never reaches this one, which paints a record short of it until the next reload',
  );
  assert.ok(
    adopts < walletGate,
    'the history branch sits below the early return that ends the listener for anything but the wallet, so it never runs',
  );
  assert.match(
    listener,
    /const h = readHistory\(\);\s*if \(h\) \{/u,
    'the listener adopts whatever the other tab wrote without reading it back, so an unreadable key empties this ring too',
  );
});

test('the ring is read before the record is first painted', () => {
  const boot = code.slice(code.indexOf('\nloadWallet();'));
  const loaded = boot.indexOf('loadHistory();');
  const painted = boot.indexOf('paintRecord();');
  assert.ok(
    loaded > 0,
    'boot never loads the stored games, so the first win of a session is the only one the report sees',
  );
  assert.ok(
    painted > loaded,
    'the record is painted before the games are loaded, so it opens empty until something repaints it',
  );
});
