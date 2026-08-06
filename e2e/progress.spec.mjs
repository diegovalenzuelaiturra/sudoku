/* How the player is going, the personal best that says so, and the lock that
   keeps the screen awake while a board is in play.

   The arithmetic behind the progress block is stats.js, which tests/stats.test.mjs
   pins to the decimal without opening a page. What only a browser can answer is
   whether those numbers arrive: the ids in the built page, the sentences the
   dialog puts them in, and the accessibility tree that carries them to somebody
   who cannot see the dialog at all.

   Two more things live here for the same reason. sudoku:history follows the
   wallet's rule and leaves bytes it cannot read exactly where they are, which
   takes real localStorage and a real game to show. And navigator.wakeLock does
   not exist on the Safari 15.4 floor this project supports, so the present and
   the absent case both need a stub standing in front of the page before it
   loads. */

import { expect, test } from '@playwright/test';

const HISTORY_KEY = 'sudoku:history';
const HISTORY_VERSION = 1;
const STATS_KEY = 'sudoku:stats';

/* The tier above Normal, written out rather than read from the page, so a table
   edited by accident fails instead of agreeing with itself. */
const PELUDO = { label: 'Peludo' };

/* A day between rows, pinned to a fixed instant. Nothing in a stored row is
   read against the wall clock, and a layoff is fourteen days, which a run of
   daily games cannot reach by accident. */
const DAY = 864e5;
const EPOCH = Date.UTC(2025, 0, 1);

const gameRow = ({ day, s, m = 0, h = 0, g = 2, d = 'medium' }) => ({
  t: EPOCH + day * DAY,
  s,
  m,
  h,
  g,
  d,
});

/* Twelve games at grade 2 walking down from ten minutes to a bit over five, one
   flawless in four. Every number the assertions below quote was taken by running
   stats.js over exactly these rows: median 8:03, quartiles 6:31 and 9:09, p90
   9:43, a 48 percent modelled fall, and a flawless rate of 25 percent whose
   Wilson interval is 9 to 53. */
const IMPROVING = [600, 585, 560, 545, 520, 495, 470, 440, 400, 365, 335, 310].map((s, day) =>
  gameRow({ day, s, m: day % 4 === 0 ? 0 : 1 }),
);

/* Three games at grade 1, which is under the five a median needs. */
const TOO_FEW = [220, 240, 260].map((s, day) => gameRow({ day, s, g: 1, d: 'easy' }));

/* Sixteen flat flawless games at grade 2. Sixteen is what it takes for the
   Wilson lower bound to clear 0.8, which is the saturation the offer waits for;
   twelve gives 0.76 and fires nothing. */
const SATURATED = Array.from({ length: 16 }, (_unused, day) =>
  gameRow({ day, s: 400 + (day % 3) * 5 }),
);

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

const solve = (page) =>
  page.evaluate(() => {
    for (let i = 0; i < 81; i++) {
      if (values[i] !== solution[i]) {
        sel = i;
        inputDigit(solution[i]);
      }
    }
  });

/* The clock and the board in one evaluate. The tick moves every second, and the
   time win() reads has to be the one the test asked for. */
const winAt = (page, time) =>
  page.evaluate((wanted) => {
    seconds = wanted;
    for (let i = 0; i < 81; i++) {
      if (values[i] !== solution[i]) {
        sel = i;
        inputDigit(solution[i]);
      }
    }
  }, time);

const readRaw = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

/* Planted through addInitScript so it lands before the page's own scripts. A
   live write loses to the 250ms coalesced selection save, which e2e/record.spec.mjs
   records. */
const plantHistory = (page, raw) =>
  page.addInitScript(([key, value]) => localStorage.setItem(key, value), [HISTORY_KEY, raw]);

const seedHistory = (page, rows) =>
  plantHistory(page, JSON.stringify({ v: HISTORY_VERSION, games: rows }));

/* Back to the start dialog and into the record, which is the only way in. */
async function openRecord(page) {
  await page.locator('#recordBtn').click();
  await expect(page.getByRole('dialog', { name: 'TU REGISTRO' })).toBeVisible();
}

/* Everything Chrome would hand to assistive tech, in reading order. Only
   StaticText carries the words: a paragraph broken up by <b> has no name of its
   own, and the InlineTextBox children under each StaticText repeat it.

   The array arrives in depth order, which lands every <b> hole in a sentence
   after the whole sentence: read flat, "Típico 8:03. La mayoría entre 6:31"
   comes back as "Típico . La mayoría entre " with the numbers in a heap at the
   end, and this test passes on markup no screen reader could make a sentence
   of. Walking childIds from the root is what restores reading order. */
async function spokenText(cdp) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const said = [];
  const walk = (id) => {
    const node = byId.get(id);
    if (!node) return;
    if (!node.ignored && node.role?.value === 'StaticText') {
      said.push(node.name?.value ?? '');
      return;
    }
    /* Descended into even when ignored: a generic wrapper is dropped from the
       tree with everything it holds still exposed underneath it. */
    for (const child of node.childIds ?? []) walk(child);
  };
  walk(nodes.find((node) => node.parentId === undefined)?.nodeId);
  return said.join('');
}

/* A counter in front of navigator.wakeLock. A real sentinel has no observable
   effect in either engine here: CI's WebKit is a Linux build whose backend is
   not Safari's, and a headless browser has no display to keep awake. When the
   game asks and when it lets go is the part worth holding down, and only a stub
   can see it. */
const stubWakeLock = (page) =>
  page.addInitScript(() => {
    window.wakeLockLog = { requests: 0, releases: 0, held: 0, types: [] };
    const live = new Set();
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request(type) {
          window.wakeLockLog.requests++;
          window.wakeLockLog.types.push(type);
          /* What a real platform does: refused while the document is hidden,
             under the one name the spec gives it. */
          if (document.visibilityState === 'hidden')
            return Promise.reject(new DOMException('hidden', 'NotAllowedError'));
          const listeners = new Set();
          const sentinel = {
            type,
            released: false,
            addEventListener(name, fn) {
              if (name === 'release') listeners.add(fn);
            },
            removeEventListener(name, fn) {
              if (name === 'release') listeners.delete(fn);
            },
            release() {
              if (!sentinel.released) {
                sentinel.released = true;
                live.delete(sentinel);
                window.wakeLockLog.releases++;
                window.wakeLockLog.held = live.size;
                for (const fn of listeners) fn(new Event('release'));
              }
              return Promise.resolve();
            },
          };
          live.add(sentinel);
          window.wakeLockLog.held = live.size;
          return Promise.resolve(sentinel);
        },
      },
    });
    /* The platform takes the lock back on its own whenever the page is hidden,
       and a released sentinel cannot be reused. Registered here, before the
       page's own scripts, so the game hears the release event first, which is
       the order a browser delivers it in. */
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      /* Copied first: release() takes the sentinel out of the set it is being
         walked over. */
      for (const sentinel of Array.from(live)) sentinel.release();
    });
  });

/* Own properties in front of the Document prototype getters. A page driven by
   Playwright is never really backgrounded, which e2e/update.spec.mjs records, so
   the hidden path is only reachable by saying so. */
const stubVisibility = (page) =>
  page.addInitScript(() => {
    let pageHidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => pageHidden });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (pageHidden ? 'hidden' : 'visible'),
    });
    window.setPageHidden = (value) => {
      pageHidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });

const lockCount = (page, field) => page.evaluate((k) => window.wakeLockLog[k], field);

/* Polled, because the request crosses a task boundary: the game only takes hold
   of a sentinel when the promise resolves, and the release it owes can only
   happen after that. */
async function expectLock(page, want) {
  for (const field of Object.keys(want)) {
    await expect
      .poll(() => lockCount(page, field), { message: `wake lock ${field}` })
      .toBe(want[field]);
  }
}

test('a seeded history tells the player which way the times are going', async ({ page }) => {
  await seedHistory(page, IMPROVING);
  const problems = await boot(page);
  await openRecord(page);

  /* The level the last measured board was graded at names the block once, in
     the heading. Times are never pooled across difficulty, so it is one level
     rather than four averaged, and the sentence under it is about the player. */
  await expect(page.locator('#progressLevel')).toHaveText('Normal');
  await expect(page.locator('#progressLede')).toHaveText('Vas 48% más rápido.');

  /* Three claims, three lines: run together they were one paragraph that wrapped
     mid sentence, and a reader had to take all of it apart to find the number
     they came for. */
  await expect(page.locator('#progressSpread')).toBeVisible();
  await expect(page.locator('#progressMedian'), 'the headline is not the median').toHaveText(
    '8:03',
  );
  await expect(page.locator('#progressP25')).toHaveText('6:31');
  await expect(page.locator('#progressP75')).toHaveText('9:09');
  await expect(page.locator('#progressP90')).toHaveText('9:43');
  await expect(page.locator('#progressSpread')).toHaveText('Típico 8:03.');
  await expect(page.locator('#progressBand')).toHaveText('La mayoría entre 6:31 y 9:09.');
  await expect(page.locator('#progressCap')).toHaveText('Casi siempre bajo 9:43.');

  /* The last of these twelve games cost an error, so the run of clean games is
     zero and the line is absent. A run of none is not a sentence worth writing
     to somebody who just made a mistake. */
  await expect(page.locator('#progressClean')).toBeHidden();

  /* Nothing in the block is an emoji standing in for a word, so nothing in it
     is aria-hidden: one here would take the whole sentence away from the only
     reader with nothing else to go on. */
  expect(
    await page.locator('#progressBox [aria-hidden="true"]').count(),
    'part of the progress block is hidden from assistive tech',
  ).toBe(0);
  expect(await page.locator('#progressBox').innerText()).not.toMatch(/NaN|null|undefined/u);

  /* Twelve games at one level, improving: flat is what the offer waits for. */
  await expect(page.locator('#progressOffer')).toBeHidden();
  /* And the seeded rows are still the seeded rows: reading writes nothing. */
  expect(JSON.parse(await readRaw(page, HISTORY_KEY)).games).toHaveLength(IMPROVING.length);
  expect(problems).toEqual([]);
});

test('the progress sentences are what a screen reader is handed', async ({ page, context }) => {
  test.skip(
    test.info().project.name !== 'chromium',
    'reads the accessibility tree, which only Chromium exposes over CDP',
  );
  await seedHistory(page, IMPROVING);
  const cdp = await context.newCDPSession(page);
  const problems = await boot(page);
  await openRecord(page);

  /* Read from Chrome's own tree rather than from the markup. The numbers sit in
     <b> holes inside each sentence, so this is also what proves the sentence
     survives being broken up: a screen reader gets one line, not four fragments
     and a percentage. */
  const spoken = await spokenText(cdp);
  /* Uppercased, because .micro transforms it the way the table headings above it
     are transformed. The level is in the heading and in no sentence under it. */
  expect(spoken).toContain('CÓMO VAS EN NORMAL');
  expect(spoken).toContain('Vas 48% más rápido.');
  /* Each claim reaches the tree whole, with the number inside it rather than in
     a heap at the end, which is what the walk down childIds is for. */
  expect(spoken).toContain('Típico 8:03.');
  expect(spoken).toContain('La mayoría entre 6:31 y 9:09.');
  expect(spoken).toContain('Casi siempre bajo 9:43.');
  expect(problems).toEqual([]);
});

test('too few games shows nothing at all, heading included', async ({ page }) => {
  const problems = await boot(page);
  await openRecord(page);

  /* Nothing stored at all. The block is not an empty box with a heading over it
     and not a line counting up to the games it needs: a player is told nothing
     by the dialog describing its own thresholds. */
  await expect(page.locator('#progressBox')).toBeHidden();
  /* And nothing was written: a reader that finds nothing leaves the key alone. */
  expect(await readRaw(page, HISTORY_KEY), 'reading an empty history wrote one').toBeNull();

  await page.locator('#closeRecord').click();
  await seedHistory(page, TOO_FEW);
  await page.reload();
  await expect(page.locator('#board .cell')).toHaveCount(81);
  await openRecord(page);

  /* Under five games the quantiles are null, because four points put p25 and
     p75 on the two middle observations and every new game moves both. There is
     nothing true to say, so nothing is said. */
  await expect(page.locator('#progressBox')).toBeHidden();
  expect(problems).toEqual([]);
});

/* The first dialog every existing player sees after this update. sudoku:stats
   is deliberately left alone by this build, so their wins are in the table while
   the ring under it starts empty. Any sentence there would be talking about a
   ring the player has no idea exists, beside a table of their own wins, so the
   block is simply absent until it has something of theirs to report. */
test('the empty ring says nothing beside the wins in the table above it', async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [
      STATS_KEY,
      JSON.stringify({
        v: 1,
        d: {
          easy: { played: 3, won: 3, best: 220 },
          medium: { played: 16, won: 16, best: 310 },
          hard: { played: 0, won: 0, best: 0 },
          expert: { played: 0, won: 0, best: 0 },
        },
        streak: 2,
        bestStreak: 5,
      }),
    ],
  );

  const problems = await boot(page);
  await openRecord(page);

  /* The table is showing nineteen wins and two real best times. */
  await expect(page.locator('#recordRows tr').nth(1).locator('td').nth(2)).toHaveText('16');
  await expect(page.locator('#recordRows tr').nth(1).locator('td').nth(3)).toHaveText('5:10');
  /* Nothing is claimed about a player whose games this build never saw. */
  await expect(page.locator('#progressBox')).toBeHidden();
  expect(problems).toEqual([]);
});

test('a level that has stopped moving is offered the next one', async ({ page }) => {
  await seedHistory(page, SATURATED);
  const problems = await boot(page);
  await openRecord(page);

  await expect(page.locator('#progressLevel')).toHaveText('Normal');
  await expect(page.locator('#progressLede')).toHaveText('Vas parejo.');
  /* All sixteen were clean and they are the sixteen most recent, so the run is
     the whole fixture. A count, because a run of games is something a player can
     picture; the rate and its interval still decide the offer below, where a
     lucky three in a row must not be enough. */
  await expect(page.locator('#progressClean')).toHaveText(
    'Llevas 16 partidas seguidas sin errores ni pistas.',
  );
  /* Flat, at one level, with a flawless rate whose lower bound has saturated:
     that is the cue to invite the player up the ladder. The level it leaves is
     the one already in the heading, so only the one being offered is named. */
  await expect(page.locator('#progressOffer')).toBeVisible();
  await expect(page.locator('#progressOffer')).toHaveText(
    `Ya te queda chico. Prueba con ${PELUDO.label}.`,
  );
  expect(problems).toEqual([]);
});

/* The rule that protects a real player's games. A version this build has never
   heard of belongs to a newer build the player still has cached, and history
   accumulates: a game that was played cannot be played again. */
test('a history from an unknown version survives a whole game, byte for byte', async ({ page }) => {
  const planted =
    '{"v":99,"games":[{"t":1754380800000,"s":423,"m":2,"h":0,"g":2,"d":"medium"}],"note":"from a build that does not exist yet"}';
  await plantHistory(page, planted);

  const problems = await boot(page);
  await startGame(page, 'medium');
  await solve(page);
  expect(await page.evaluate(() => solved), 'the board did not register as solved').toBe(true);

  expect(
    await readRaw(page, HISTORY_KEY),
    'winning overwrote a history this build cannot read',
  ).toBe(planted);

  await page.locator('#againBtn').click();
  await openRecord(page);
  /* A tab that cannot write is still allowed to keep score, the way the wallet
     is: the game just finished counts in memory, against an empty ring. One game
     is not five, so the block has nothing to say and does not appear. */
  await expect(page.locator('#progressBox')).toBeHidden();
  expect(
    await readRaw(page, HISTORY_KEY),
    'painting the record overwrote a history this build cannot read',
  ).toBe(planted);
  expect(problems).toEqual([]);
});

test('a personal best is announced and shown, and only when there was one to beat', async ({
  page,
}) => {
  const problems = await boot(page);

  /* The first win. There was no time to beat, so it is not a best, and saying it
     was would steal the line from every first flawless win, which is rarer. */
  await startGame(page, 'medium');
  await winAt(page, 300);
  await expect(page.locator('#winOverlay')).toBeVisible();
  await expect(page.locator('#wBestLine'), 'a first win was called a personal best').toBeHidden();
  expect(await page.locator('#srAlert').textContent()).not.toContain('récord');

  /* Faster than the first, which is the only thing that counts as one. */
  await page.locator('#againBtn').click();
  await startGame(page, 'medium');
  await winAt(page, 100);
  await expect(page.locator('#winOverlay')).toBeVisible();
  await expect(page.locator('#wBestLine')).toHaveText('🏆 ¡Nuevo récord de tiempo!');
  /* Which of the three numbers moved, marked on the number itself. The words
     name the clock and the tile agrees with them. */
  await expect(page.locator('#wTimeStat')).toHaveClass(/record/u);
  await expect(page.locator('#wMist').locator('..')).not.toHaveClass(/record/u);
  /* The flawless message keeps the lede: a first flawless win is rarer than a
     fast one, so the best time gets its own line rather than displacing it. */
  await expect(page.locator('#winLede')).toHaveText('La más seca: cero errores, cero pistas.');

  /* And in the assertive region, which is the announcement that reaches a
     screen reader: showOverlay focuses the dialog's button, not the banner. */
  const announced = await page.locator('#srAlert').textContent();
  expect(announced).toMatch(/^Ganaste\./u);
  expect(announced).toContain(' ¡Nuevo récord de tiempo!');

  /* And nowhere in the record. A trophy against the best time said the record
     was set in this session, which is a fact about the tab rather than about the
     player, and it read as though the time itself were a trophy. */
  await page.locator('#againBtn').click();
  await openRecord(page);
  await expect(page.locator('#recordRows tr')).toHaveCount(4);
  const normal = page.locator('#recordRows tr').nth(1).locator('td');
  await expect(normal, 'the table lost or gained a column').toHaveCount(4);
  await expect(normal.nth(3)).toHaveText(/^\d+:\d\d$/u);
  expect(
    await page.locator('#recordRows [aria-hidden="true"]').count(),
    'the record table marks the best time again',
  ).toBe(0);

  /* Slower than the best. Nothing is claimed. */
  await page.locator('#closeRecord').click();
  await startGame(page, 'medium');
  await winAt(page, 500);
  await expect(page.locator('#winOverlay')).toBeVisible();
  await expect(page.locator('#wBestLine'), 'a slower win was called a personal best').toBeHidden();
  await expect(
    page.locator('#wTimeStat'),
    'the tile kept the mark of the win before',
  ).not.toHaveClass(/record/u);
  expect(await page.locator('#srAlert').textContent()).not.toContain('récord');
  expect(problems).toEqual([]);
});

/* The second record, which is the streak and not the clock. Every win here is
   flawless, so the run only ever grows: each one says where it stands, and the
   third and then every fifth calls it a record. The counter itself sits in the
   record dialog, which the player has to go and open, so a win that moved it
   silently was reported as the game refusing to count the game at all. */
test('every clean win says where the run is, and a milestone calls it a record', async ({
  page,
}) => {
  const problems = await boot(page);
  const streakLine = page.locator('#wStreakLine');
  /* Each win slower than the one before, so the clock sets nothing after the
     first and the streak is the only record any of them can take. */
  const again = async (time) => {
    await page.locator('#againBtn').click();
    await startGame(page, 'medium');
    await winAt(page, time);
    await expect(page.locator('#winOverlay')).toBeVisible();
  };

  await startGame(page, 'medium');
  await winAt(page, 100);
  await expect(page.locator('#winOverlay')).toBeVisible();
  await expect(streakLine, 'the first clean win of all said nothing about the run').toHaveText(
    '🔥 Va 1 seca.',
  );
  expect(
    await page.locator('#srAlert').textContent(),
    'the run reached the line and not the announcement, which is the half a screen reader gets',
  ).toContain(' Va 1 seca.');

  await again(500);
  await expect(streakLine).toHaveText('🔥 Van 2 secas seguidas.');

  await again(600);
  await expect(page.locator('#wBestLine'), 'a slower win set a time record').toBeHidden();
  await expect(streakLine).toHaveText('🥇 ¡Tu mejor racha: 3 secas seguidas!');
  const announced = await page.locator('#srAlert').textContent();
  expect(announced).toContain(' ¡Tu mejor racha: 3 secas seguidas!');
  expect(announced, 'the clock claimed a record it did not set').not.toContain('récord de tiempo');

  /* The fourth extends the best streak and does not claim one. */
  await again(700);
  await expect(streakLine, 'the fourth in a row claimed a record').toHaveText(
    '🔥 Van 4 secas seguidas.',
  );

  await again(800);
  await expect(streakLine).toHaveText('🥇 ¡Tu mejor racha: 5 secas seguidas!');

  /* And the record counted every one of them, called a record or not. */
  await page.locator('#againBtn').click();
  await openRecord(page);
  await expect(page.locator('#streakCounts')).toHaveText('🔥 5 seguidas 🥇 mejor 5');
  expect(problems).toEqual([]);
});

/* Zero is not a sentence worth writing, and a win that ended a run has already
   said what it cost in the two counters beside the clock. */
test('a win that cost an error says nothing about the run', async ({ page }) => {
  const problems = await boot(page);
  await startGame(page, 'medium');
  await page.evaluate(() => {
    const i = values.findIndex((_v, k) => !fixed[k]);
    sel = i;
    inputDigit((solution[i] % 9) + 1);
  });
  await solve(page);
  await expect(page.locator('#winOverlay')).toBeVisible();
  await expect(page.locator('#wStreakLine')).toBeHidden();
  expect(await page.locator('#srAlert').textContent()).not.toContain('seca');
  expect(problems).toEqual([]);
});

/* Nothing falls for a player who asked for less motion, so a record that only
   rains is a record they are never told about. Both records have a line for
   that reason, and this is the run's. */
test('a clean win says so with no animation at all', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const problems = await boot(page);
  await startGame(page, 'medium');
  await winAt(page, 100);
  await expect(page.locator('#winOverlay')).toBeVisible();
  await expect(
    page.locator('.drop'),
    'a shower ran for a player who asked for no motion',
  ).toHaveCount(0);
  await expect(page.locator('#wStreakLine')).toHaveText('🔥 Va 1 seca.');
  await expect(page.locator('#fryBanner')).toContainText('🍟 +20');
  expect(problems).toEqual([]);
});

test('the screen is kept awake while the clock runs and let go when it stops', async ({ page }) => {
  await stubVisibility(page);
  await stubWakeLock(page);
  const problems = await boot(page);

  /* Nothing is asked for on the difficulty picker. There is no board, no clock,
     and the lock costs battery. Read straight rather than polled: syncWakeLock
     calls request() in the same task the click runs in, so a request made on
     this path would already be counted. */
  expect(await lockCount(page, 'requests'), 'the difficulty picker asked for a lock').toBe(0);

  await startGame(page, 'medium');
  await expectLock(page, { requests: 1, held: 1 });
  /* Always the literal 'screen'. Leaving it out relies on a default that
     postdates Safari 16.4, and any other string is a synchronous TypeError. */
  expect(await page.evaluate(() => window.wakeLockLog.types)).toEqual(['screen']);

  await page.locator('#pauseBtn').click();
  await expect(page.locator('#veil')).toBeVisible();
  await expectLock(page, { held: 0 });

  await page.locator('#resumeBtn').click();
  await expect(page.locator('#veil')).toBeHidden();
  await expectLock(page, { requests: 2, held: 1 });

  await solve(page);
  expect(await page.evaluate(() => solved), 'the board did not register as solved').toBe(true);
  /* setPaused returns early once solved is set, so the release cannot ride on
     it: a lock left held here keeps the screen awake over the win overlay for
     as long as the tab lives. */
  await expectLock(page, { held: 0 });

  await page.locator('#againBtn').click();
  await expect(page.locator('#startOverlay')).toBeVisible();
  expect(await lockCount(page, 'requests'), 'the win overlay asked for a lock').toBe(2);
  await expectLock(page, { held: 0 });
  expect(problems).toEqual([]);
});

test('backgrounding lets the lock go and coming back does not take it again', async ({ page }) => {
  await stubVisibility(page);
  await stubWakeLock(page);
  const problems = await boot(page);
  await startGame(page, 'medium');
  await expectLock(page, { requests: 1, held: 1 });

  await page.evaluate(() => window.setPageHidden(true));
  await expect(page.locator('#veil')).toBeVisible();
  await expectLock(page, { held: 0 });

  /* Coming back does not resume the game, so asking again here would hold the
     screen awake over a veiled board with a stopped clock. The lock returns
     with the Seguir click and nowhere else. */
  await page.evaluate(() => window.setPageHidden(false));
  expect(await lockCount(page, 'requests'), 'returning to a paused board took a lock').toBe(1);
  await expectLock(page, { held: 0 });

  await page.locator('#resumeBtn').click();
  await expect(page.locator('#veil')).toBeHidden();
  await expectLock(page, { requests: 2, held: 1 });
  expect(problems).toEqual([]);
});

test('a board dealt into a hidden tab never asks for the lock', async ({ page }) => {
  await stubVisibility(page);
  await stubWakeLock(page);
  const problems = await boot(page);

  await page.evaluate(() => window.setPageHidden(true));
  await startGame(page, 'medium');
  /* startGame ends in setPaused(document.hidden), so the board arrives paused
     and the clock never starts. */
  await expect(page.locator('#veil')).toBeVisible();
  expect(await lockCount(page, 'requests'), 'a hidden tab asked for the lock').toBe(0);
  expect(problems).toEqual([]);
});

test('a lock the platform refuses is not a console error', async ({ page }) => {
  /* NotAllowedError is the name this rejects with, and it covers a blocking
     permissions policy and a battery the platform will not spend. An unhandled
     rejection is a console error in both engines, which is what the problems
     array below is watching for. */
  await page.addInitScript(() => {
    window.wakeLockRefusals = 0;
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request() {
          window.wakeLockRefusals++;
          return Promise.reject(new DOMException('denied', 'NotAllowedError'));
        },
      },
    });
  });

  const problems = await boot(page);
  await startGame(page, 'medium');
  await expect
    .poll(() => page.evaluate(() => window.wakeLockRefusals), { message: 'wake lock refusals' })
    .toBeGreaterThan(0);

  await page.locator('#pauseBtn').click();
  await expect(page.locator('#veil')).toBeVisible();
  await page.locator('#resumeBtn').click();
  await expect(page.locator('#veil')).toBeHidden();
  await solve(page);
  /* Waited out rather than asserted straight away: the win overlay is about two
     seconds of animation, which is far longer than a rejection takes to reach
     the console. */
  await expect(page.locator('#winOverlay')).toBeVisible();
  expect(problems).toEqual([]);
});

test('a browser with no wake lock at all plays exactly the same game', async ({ page }) => {
  /* The Safari 15.4 floor. The API arrived in 16.4, so its absence is the
     ordinary case here and has to change nothing. */
  await page.addInitScript(() => {
    delete Navigator.prototype.wakeLock;
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: undefined });
  });

  const problems = await boot(page);
  expect(await page.evaluate(() => navigator.wakeLock)).toBeUndefined();

  await startGame(page, 'medium');
  await page.locator('#pauseBtn').click();
  await expect(page.locator('#veil')).toBeVisible();
  await page.locator('#resumeBtn').click();
  await expect(page.locator('#veil')).toBeHidden();
  await solve(page);
  expect(await page.evaluate(() => solved), 'the board did not register as solved').toBe(true);
  await expect(page.locator('#winOverlay')).toBeVisible();
  expect(problems).toEqual([]);
});
