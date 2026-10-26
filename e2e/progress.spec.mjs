import { expect, test } from '@playwright/test';

const HISTORY_KEY = 'sudoku:history';
const HISTORY_VERSION = 1;
const STATS_KEY = 'sudoku:stats';

const PELUDO = { label: 'Peludo' };

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

// MUST KILL: expected figures are pinned by hand, derive them from stats.js instead
const IMPROVING = [600, 585, 560, 545, 520, 495, 470, 440, 400, 365, 335, 310].map((s, day) =>
  gameRow({ day, s, m: day % 4 === 0 ? 0 : 1 }),
);

const TOO_FEW = [220, 240, 260].map((s, day) => gameRow({ day, s, g: 1, d: 'easy' }));

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

const plantHistory = (page, raw) =>
  page.addInitScript(([key, value]) => localStorage.setItem(key, value), [HISTORY_KEY, raw]);

const seedHistory = (page, rows) =>
  plantHistory(page, JSON.stringify({ v: HISTORY_VERSION, games: rows }));

async function openRecord(page) {
  await page.locator('#recordBtn').click();
  await expect(page.getByRole('dialog', { name: 'TU REGISTRO' })).toBeVisible();
}

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
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      for (const sentinel of Array.from(live)) sentinel.release();
    });
  });

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

  await expect(page.locator('#progressLevel')).toHaveText('Normal');
  await expect(page.locator('#progressLede')).toHaveText('Vas 48% más rápido.');

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

  await expect(page.locator('#progressClean')).toBeHidden();

  expect(
    await page.locator('#progressBox [aria-hidden="true"]').count(),
    'part of the progress block is hidden from assistive tech',
  ).toBe(0);
  expect(await page.locator('#progressBox').innerText()).not.toMatch(/NaN|null|undefined/u);

  await expect(page.locator('#progressOffer')).toBeHidden();
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

  const spoken = await spokenText(cdp);
  expect(spoken).toContain('CÓMO VAS EN NORMAL');
  expect(spoken).toContain('Vas 48% más rápido.');
  expect(spoken).toContain('Típico 8:03.');
  expect(spoken).toContain('La mayoría entre 6:31 y 9:09.');
  expect(spoken).toContain('Casi siempre bajo 9:43.');
  expect(problems).toEqual([]);
});

test('too few games shows nothing at all, heading included', async ({ page }) => {
  const problems = await boot(page);
  await openRecord(page);

  await expect(page.locator('#progressBox')).toBeHidden();
  expect(await readRaw(page, HISTORY_KEY), 'reading an empty history wrote one').toBeNull();

  await page.locator('#closeRecord').click();
  await seedHistory(page, TOO_FEW);
  await page.reload();
  await expect(page.locator('#board .cell')).toHaveCount(81);
  await openRecord(page);

  await expect(page.locator('#progressBox')).toBeHidden();
  expect(problems).toEqual([]);
});

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

  await expect(page.locator('#recordRows tr').nth(1).locator('td').nth(2)).toHaveText('16');
  await expect(page.locator('#recordRows tr').nth(1).locator('td').nth(3)).toHaveText('5:10');
  await expect(page.locator('#progressBox')).toBeHidden();
  expect(problems).toEqual([]);
});

test('a level that has stopped moving is offered the next one', async ({ page }) => {
  await seedHistory(page, SATURATED);
  const problems = await boot(page);
  await openRecord(page);

  await expect(page.locator('#progressLevel')).toHaveText('Normal');
  await expect(page.locator('#progressLede')).toHaveText('Vas parejo.');
  await expect(page.locator('#progressClean')).toHaveText(
    'Llevas 16 partidas seguidas sin errores ni pistas.',
  );
  await expect(page.locator('#progressOffer')).toBeVisible();
  await expect(page.locator('#progressOffer')).toHaveText(
    `Ya te queda chico. Prueba con ${PELUDO.label}.`,
  );
  expect(problems).toEqual([]);
});

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

  await startGame(page, 'medium');
  await winAt(page, 300);
  await expect(page.locator('#winOverlay')).toBeVisible();
  await expect(page.locator('#wBestLine'), 'a first win was called a personal best').toBeHidden();
  expect(await page.locator('#srAlert').textContent()).not.toContain('récord');

  await page.locator('#againBtn').click();
  await startGame(page, 'medium');
  await winAt(page, 100);
  await expect(page.locator('#winOverlay')).toBeVisible();
  await expect(page.locator('#wBestLine')).toHaveText('🏆 ¡Nuevo récord de tiempo!');
  await expect(page.locator('#wTimeStat')).toHaveClass(/record/u);
  await expect(page.locator('#wMist').locator('..')).not.toHaveClass(/record/u);
  await expect(page.locator('#winLede')).toHaveText('La más seca: cero errores, cero pistas.');

  const announced = await page.locator('#srAlert').textContent();
  expect(announced).toMatch(/^Ganaste\./u);
  expect(announced).toContain(' ¡Nuevo récord de tiempo!');

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

test('every clean win says where the run is, and a milestone calls it a record', async ({
  page,
}) => {
  const problems = await boot(page);
  const streakLine = page.locator('#wStreakLine');
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

  await again(700);
  await expect(streakLine, 'the fourth in a row claimed a record').toHaveText(
    '🔥 Van 4 secas seguidas.',
  );

  await again(800);
  await expect(streakLine).toHaveText('🥇 ¡Tu mejor racha: 5 secas seguidas!');

  await page.locator('#againBtn').click();
  await openRecord(page);
  await expect(page.locator('#streakCounts')).toHaveText('🔥 5 seguidas 🥇 mejor 5');
  expect(problems).toEqual([]);
});

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
  await expect(page.locator('#veil')).toBeVisible();
  expect(await lockCount(page, 'requests'), 'a hidden tab asked for the lock').toBe(0);
  expect(problems).toEqual([]);
});

test('a lock the platform refuses is not a console error', async ({ page }) => {
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
  await expect(page.locator('#winOverlay')).toBeVisible();
  expect(problems).toEqual([]);
});

test('a browser with no wake lock at all plays exactly the same game', async ({ page }) => {
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
