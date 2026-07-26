/* Boots the published page in Chrome and asserts it comes up clean.

   Ported from tests/boot.test.mjs, which booted the same page in a DOM
   simulator and has been deleted now that this file stands in for it. The
   regression that suite was written for still stands: `notes` was declared as
   an empty array while render() read notes[i].has(d) for all 81 cells, so the
   boot-time render() threw on the first cell, the statements after it never
   ran, and the page loaded to a dead grid with no difficulty picker. Every
   assertion below fails on that bug.

   What changed by moving to a browser:

   1. The accessibility assertions are made against the tree Chrome actually
      exposes, read over CDP, instead of against the attributes the page set.
      The simulator had no accessibility tree, so it could only check that
      .app.inert was assigned; it could not check that assigning it takes the
      81 cells behind the start dialog out of what a screen reader can reach,
      which is the whole point of the attribute.
   2. The board is checked as a laid out nine by nine grid. The simulator had
      no layout engine, so "the grid rendered" meant "the elements exist".
   3. The focus ring is checked as something painted, under the same
      :focus-visible rules a player is subject to.
   4. The service worker is registered, its scope asserted, and the path that
      produced it proved to be relative by serving the same bytes under a
      second prefix. The simulator had no service worker at all, so the one
      line of boot code that decides whether the app works offline was never
      covered.

   Pausing is not covered here. That suite asserted it through the inert
   property, and that test is already ported, in its much stronger form, in
   e2e/pause.spec.mjs. */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/* Kept in sync with the DIFF map in index.html. The clue count each difficulty
   used to advertise is deliberately not here: difficulty is the technique a
   board needs now, and the generator moves the clue count to reach one, so
   there is no fixed number left to assert. tests/generator.test.mjs owns what
   the grades mean; what is left for a browser is that the word on the button is
   the word the game deals. */
const PRESETS = [
  { key: 'easy', label: 'Piola', word: 'directas' },
  { key: 'medium', label: 'Normal', word: 'bloques' },
  { key: 'hard', label: 'Peludo', word: 'pares' },
  { key: 'expert', label: 'Brígido', word: 'avanzado' },
];

/* The name render() gives every cell: "Fila 3, columna 7, 4, dada". */
const CELL_NAME = /^Fila \d, columna \d/;
const GIVEN_NAME = /^Fila \d, columna \d, [1-9], dada$/;

/* Everything Chrome would hand to assistive tech: ignored nodes are dropped,
   and an inert subtree is ignored wholesale. */
async function accessibleNodes(cdp) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  return nodes
    .filter((node) => !node.ignored)
    .map((node) => ({
      role: node.role?.value ?? '',
      name: node.name?.value ?? '',
      properties: Object.fromEntries(
        (node.properties ?? []).map((property) => [property.name, property.value?.value]),
      ),
    }));
}

const countCells = (nodes, pattern) =>
  nodes.filter((node) => node.role === 'button' && pattern.test(node.name)).length;

/* Polled rather than read once: the accessibility tree is rebuilt off the back
   of the DOM change, and CI hardware is slower than a laptop. */
function expectExposedCells(cdp, pattern, count, what) {
  return expect
    .poll(async () => countCells(await accessibleNodes(cdp), pattern), {
      message: `expected ${count} ${what} in the accessibility tree Chrome exposes`,
      /* Longer than the default expect timeout: generating an expert puzzle
         blocks the main thread and the tree is only rebuilt afterwards, which
         is the one pair in this suite that came close to the 10 second budget
         under load. */
      timeout: 15_000,
    })
    .toBe(count);
}

/* Every test in the deleted suite ended by asserting nothing had gone wrong on
   the console. Kept, but reading the real one: an exception thrown by a
   platform feature a simulator stubs out can only surface here. */
const problems = [];

test.beforeEach(async ({ page }) => {
  problems.length = 0;
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));

  /* Relative, so the request goes through the /sudoku/ prefix in baseURL.
     Each test gets its own browser context, so localStorage starts empty and
     the boot path under test is always the no-saved-game one. */
  await page.goto('./');
});

test.afterEach(() => {
  expect(problems).toEqual([]);
});

test('boots to a live page rather than a dead grid', async ({ page }) => {
  await expect(page.locator('#board .cell')).toHaveCount(81);
  await expect(page.getByRole('group', { name: 'Tablero de sudoku' })).toBeAttached();
  /* The half of the bug that a count alone would miss: render() threw before
     the picker was ever filled in, so the page offered no way to start. */
  await expect(page.locator('#startOverlay button.diff')).toHaveCount(4);
  await expect(page.locator('#startOverlay')).toBeVisible();
});

test('the start dialog is a named modal and the page behind it is unreachable', async ({
  page,
  context,
}) => {
  test.skip(
    test.info().project.name !== 'chromium',
    'reads the accessibility tree, which only Chromium exposes over CDP',
  );
  const cdp = await context.newCDPSession(page);
  await expect(page.locator('#startOverlay')).toBeVisible();

  /* Asked of Chrome, not of the markup: this is the dialog as announced, with
     the name resolved through aria-labelledby and the modal flag as the
     browser understood it. */
  const dialogs = (await accessibleNodes(cdp)).filter((node) => node.role === 'dialog');
  expect(dialogs.map((node) => node.name)).toContain('SUDOKU');
  expect(dialogs.find((node) => node.name === 'SUDOKU').properties.modal).toBe(true);

  /* The deleted suite could only assert that the page had set .app.inert,
     never what inert does. This is what it does: the whole board goes out of
     the tree while the dialog is up. */
  await expectExposedCells(cdp, CELL_NAME, 0, 'board cells');

  await expect(page.locator(`#startOverlay button.diff[data-d="${PRESETS[0].key}"]`)).toBeFocused();

  /* The other half of a trapped dialog is the tab order, which a simulated
     DOM does not model either. Walking forward and back from the focused
     button must never land on the board or the controls behind the dialog. */
  const visited = [];
  for (const key of ['Tab', 'Shift+Tab']) {
    await page.locator(`#startOverlay button.diff[data-d="${PRESETS[0].key}"]`).focus();
    for (let step = 0; step < 10; step++) {
      await page.keyboard.press(key);
      visited.push(
        await page.evaluate(() => {
          const active = document.activeElement;
          if (!active) return 'outside';
          if (active.closest('#startOverlay')) return 'dialog';
          return active.closest('.app') ? 'background' : 'outside';
        }),
      );
    }
  }
  expect(visited.filter((region) => region === 'background')).toEqual([]);
  /* Guards the walk itself: focus has to be moving for the line above to mean
     anything. */
  expect(visited.filter((region) => region === 'dialog').length).toBeGreaterThan(0);
});

test('the board is 81 named cells laid out as a nine by nine grid', async ({ page }) => {
  /* Matched on the name Chrome computes, not on the aria-label attribute:
     render() aborting mid-loop leaves cells unnamed, and a cell a screen
     reader cannot name is the failure worth catching. */
  await expect(page.getByRole('button', { name: /^Fila \d, columna \d, vacía$/ })).toHaveCount(81);

  /* A simulated DOM has no layout, so the old suite could not tell a rendered
     board from 81 elements stacked at 0 by 0. */
  const grid = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('#board .cell')].map((cell) =>
      cell.getBoundingClientRect(),
    );
    return {
      columns: new Set(boxes.map((box) => Math.round(box.x))).size,
      rows: new Set(boxes.map((box) => Math.round(box.y))).size,
      collapsed: boxes.filter((box) => box.width < 1 || box.height < 1).length,
    };
  });
  expect(grid).toEqual({ columns: 9, rows: 9, collapsed: 0 });

  const board = await page.locator('#board').boundingBox();
  expect(Math.abs(board.width - board.height)).toBeLessThan(1);

  await expect(page.locator('#remaining')).toHaveText('81 por llenar');
  await expect(page.locator('#mistakes')).toHaveText('0');
  await expect(page.locator('#hints')).toHaveText('0');
});

test('every difficulty button announces its label and the technique it deals', async ({ page }) => {
  for (const preset of PRESETS) {
    const button = page.locator(`#startOverlay button.diff[data-d="${preset.key}"]`);
    /* The whole name, tied to the key that deals the puzzle: the sentence a
       screen reader reads out, rather than a substring of innerHTML that
       happens to contain the label somewhere. */
    await expect(button).toHaveAccessibleName(`${preset.label} ${preset.word}`);
    await expect(button).toBeVisible();
  }
});

for (const preset of PRESETS) {
  test(`starting ${preset.label} deals a board and dismisses the dialog`, async ({
    page,
    context,
  }) => {
    test.skip(
      test.info().project.name !== 'chromium',
      'reads the accessibility tree, which only Chromium exposes over CDP',
    );
    const cdp = await context.newCDPSession(page);
    await page.locator(`#startOverlay button.diff[data-d="${preset.key}"]`).click();

    /* Really gone from the page, not merely missing a class name. Generation
       runs in a worker now, so this is also the wait: the dialog stays up, with
       its buttons disabled, until a board comes back. */
    await expect(page.locator('#startOverlay')).toBeHidden();

    /* .app.inert going back to false, asserted by its effect: the board is
       handed back to assistive tech. */
    await expectExposedCells(cdp, CELL_NAME, 81, 'board cells');

    /* The clue count is no longer a fixed number per difficulty, so what is
       worth pinning is that everything on the page agrees about it: the cells
       painted as givens, the cells that announce themselves as "dada", and the
       count of what is left to fill. A board that disagreed with itself is the
       failure this used to catch by asserting the number directly. */
    const givens = await page.locator('#board .cell.given').count();
    expect(givens).toBeGreaterThanOrEqual(17);
    expect(givens).toBeLessThan(81);
    await expectExposedCells(cdp, GIVEN_NAME, givens, 'given cells');
    await expect(page.locator('#remaining')).toHaveText(`${81 - givens} por llenar`);
    await expect(page.locator('#diffLabel')).toHaveText(preset.label);
  });
}

test('undo restores hint, mistake and given state', async ({ page }) => {
  await page.locator('#startOverlay button.diff[data-d="medium"]').click();
  await expect(page.locator('#startOverlay')).toBeHidden();

  const index = await page.evaluate(() =>
    [...document.querySelectorAll('#board .cell')].findIndex((cell) =>
      cell.classList.contains('sel'),
    ),
  );
  expect(index, 'no cell is selected after starting').toBeGreaterThanOrEqual(0);
  const cell = page.locator('#board .cell').nth(index);

  /* Hint fills the cell and marks it given; undo must roll both back, or the
     cell stays locked holding a value the player can no longer edit. Typed on
     a real keyboard, so this also covers the document-level handler seeing the
     key at all. */
  await page.keyboard.press('h');
  await expect(page.locator('#hints')).toHaveText('1');
  await expect(cell).toHaveClass(/given/);
  await expect(cell).toHaveAccessibleName(/^Fila \d, columna \d, [1-9], dada$/);
  const hinted = (await cell.locator('.v').innerText()).trim();
  expect(hinted).toMatch(/^[1-9]$/);

  await page.keyboard.press('z');
  await expect(page.locator('#hints')).toHaveText('0');
  await expect(cell).not.toHaveClass(/given/);
  /* The undone cell announces itself as empty and editable again, which is the
     player-visible meaning of the class check above. */
  await expect(cell).toHaveAccessibleName(/^Fila \d, columna \d, vacía$/);
  await expect(cell.locator('.v')).toBeEmpty();

  /* A wrong entry must not strand the mistake counter, which gates the bonus. */
  await page.keyboard.press(String((Number(hinted) % 9) + 1));
  await expect(page.locator('#mistakes')).toHaveText('1');
  await page.keyboard.press('z');
  await expect(page.locator('#mistakes')).toHaveText('0');
});

test('keyboard focus is painted on the board, a pointer click is not', async ({ page }) => {
  await page.locator('#startOverlay button.diff[data-d="medium"]').click();
  await expect(page.locator('#startOverlay')).toBeHidden();

  /* Width and colour are only read when a ring is drawn: Chrome keeps a
     nonzero outline-width around while outline-style is none, so reporting it
     unconditionally would describe an unpainted cell as having a 3px ring. */
  const ring = () =>
    page.evaluate(() => {
      const cell = document.querySelector('#board .cell');
      const style = getComputedStyle(cell);
      return {
        visible: cell.matches(':focus-visible'),
        outline:
          style.outlineStyle === 'none'
            ? 'none'
            : `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
      };
    });

  /* Clicking selects the cell without asking for a focus ring, which is what
     :focus-visible is for. Nothing outside a browser applies the stylesheet,
     so neither state here was observable at all. */
  await page.locator('#board .cell').first().click();
  expect(await ring()).toEqual({ visible: false, outline: 'none' });

  /* The half above runs everywhere. The half below cannot: Safari does not move
     Tab focus to a button unless Full Keyboard Access is switched on in the
     system, so on WebKit this would be asserting a macOS setting rather than
     anything about this page. */
  test.skip(
    test.info().project.name !== 'chromium',
    'Tab does not visit buttons in Safari without Full Keyboard Access',
  );

  /* Reached with the keyboard instead: the ring has to be there, or the player
     cannot tell which of the 81 cells is about to take the digit. */
  await page.locator('#pauseBtn').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#board .cell').first()).toBeFocused();
  expect(await ring()).toEqual({ visible: true, outline: 'solid 2px rgb(49, 80, 126)' });
});

/* The registration is deliberately swallowed by the page, so a worker that
   never registers leaves navigator.serviceWorker.ready pending forever. Bounded
   here, and resolved to null on the way out, so that failure arrives as an
   assertion with a message instead of as a test timeout without one. */
const readyScope = (page) =>
  page.evaluate(
    (limit) =>
      Promise.race([
        navigator.serviceWorker.ready.then((registration) => registration.scope),
        new Promise((resolve) => {
          setTimeout(() => resolve(null), limit);
        }),
      ]),
    10_000,
  );

test('the service worker registers, scoped to the directory the site ships from', async ({
  page,
}) => {
  /* Untestable without a browser, which is how the one line that decides
     whether the app works offline shipped uncovered. The scope has to be the
     directory index.html sits in: a worker registered a level up would control
     everything else published from the same account. */
  const scope = await readyScope(page);
  expect(scope, 'no service worker took control of the page').not.toBeNull();
  expect(new URL(scope).pathname).toBe('/sudoku/');
  /* Everything above is read from the page's own navigator, so it holds every
     engine to the same promise, and WebKit is the one that matters here: it is
     what every installed copy on iOS runs. Only the line below is Chromium
     bound, because Playwright reports worker instances for Chromium alone. */
  if (test.info().project.name === 'chromium') {
    expect(page.context().serviceWorkers().length).toBeGreaterThan(0);
  }
});

/* A second copy of the published site, mounted under a different prefix, the
   way a fork or a differently named repository would serve the same bytes.
   Port 0 leaves the choice of port to the OS, so this cannot collide with the
   server the config already booted or with another run of the suite. */
async function serveAt(prefix) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, [join(root, 'e2e', 'static-server.mjs'), '0', prefix], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('close', resolve);
      child.kill();
    });

  try {
    const url = await new Promise((resolve, reject) => {
      let printed = '';
      const timer = setTimeout(
        () => reject(new Error(`the ${prefix} server printed no address: ${printed}`)),
        10_000,
      );
      const settle = (error, value) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      child.stdout.on('data', (chunk) => {
        printed += chunk;
        const address = printed.match(/http:\/\/\S+/);
        if (address) settle(null, address[0]);
      });
      child.stderr.on('data', (chunk) => {
        printed += chunk;
      });
      child.once('error', (error) => settle(error));
      child.once('exit', () => settle(new Error(`the ${prefix} server exited: ${printed}`)));
    });
    return { url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

test('the worker is registered by a relative path, so any prefix works', async ({ page }) => {
  /* The scope assertion above cannot tell a relative './sw.js' from an
     absolute '/sudoku/sw.js': the suite serves the site at the prefix
     production uses, so both resolve to the same URL and both pass. Measured,
     not assumed: that rewrite left all 35 tests green.

     Serving the same build under a second prefix is what separates them. A
     relative specifier resolves next to index.html wherever it is mounted; an
     absolute one 404s and the registration, which the page swallows on
     purpose, silently never happens. That is the production failure, since the
     site is a project page today and could be a user page or a fork
     tomorrow. */
  const site = await serveAt('otro-sudoku');
  try {
    await page.goto(site.url);
    await expect(page.locator('#board .cell')).toHaveCount(81);

    const scope = await readyScope(page);
    expect(scope, 'no service worker registered under the second prefix').not.toBeNull();
    expect(new URL(scope).pathname).toBe('/otro-sudoku/');
  } finally {
    await site.stop();
  }
});
