import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

// MUST KILL: labels and technique words are copied from the DIFF map in app.js, read them from the page
const PRESETS = [
  { key: 'easy', label: 'Piola', word: 'directas' },
  { key: 'medium', label: 'Normal', word: 'bloques' },
  { key: 'hard', label: 'Peludo', word: 'pares' },
  { key: 'expert', label: 'Brígido', word: 'avanzado' },
];

const CELL_NAME = /^Fila \d, columna \d/u;
const GIVEN_NAME = /^Fila \d, columna \d, [1-9], dada$/u;

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

function expectExposedCells(cdp, pattern, count, what) {
  return expect
    .poll(async () => countCells(await accessibleNodes(cdp), pattern), {
      message: `expected ${count} ${what} in the accessibility tree Chrome exposes`,
      timeout: 15_000,
    })
    .toBe(count);
}

const problems = [];

test.beforeEach(async ({ page }) => {
  problems.length = 0;
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));

  await page.goto('./');
});

test.afterEach(() => {
  expect(problems).toEqual([]);
});

test('boots to a live page rather than a dead grid', async ({ page }) => {
  await expect(page.locator('#board .cell')).toHaveCount(81);
  await expect(page.getByRole('group', { name: 'Tablero de sudoku' })).toBeAttached();
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

  const dialogs = (await accessibleNodes(cdp)).filter((node) => node.role === 'dialog');
  expect(dialogs.map((node) => node.name)).toContain('SUDOKU');
  expect(dialogs.find((node) => node.name === 'SUDOKU').properties.modal).toBe(true);

  await expectExposedCells(cdp, CELL_NAME, 0, 'board cells');

  await expect(page.locator(`#startOverlay button.diff[data-d="${PRESETS[0].key}"]`)).toBeFocused();

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
  expect(visited.filter((region) => region === 'dialog').length).toBeGreaterThan(0);
});

test('the board is 81 named cells laid out as a nine by nine grid', async ({ page }) => {
  await expect(page.getByRole('button', { name: /^Fila \d, columna \d, vacía$/u })).toHaveCount(81);

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

    await expect(page.locator('#startOverlay')).toBeHidden();

    await expectExposedCells(cdp, CELL_NAME, 81, 'board cells');

    const givens = await page.locator('#board .cell.given').count();
    expect(givens).toBeGreaterThanOrEqual(17);
    expect(givens).toBeLessThan(81);
    await expectExposedCells(cdp, GIVEN_NAME, givens, 'given cells');
    await expect(page.locator('#remaining')).toHaveText(`${81 - givens} por llenar`);
    await expect(page.locator('#diffLabel')).toHaveText(preset.label);
  });
}

test('undo restores the board but never the counters', async ({ page }) => {
  await page.locator('#startOverlay button.diff[data-d="medium"]').click();
  await expect(page.locator('#startOverlay')).toBeHidden();

  const index = await page.evaluate(() =>
    [...document.querySelectorAll('#board .cell')].findIndex((cell) =>
      cell.classList.contains('sel'),
    ),
  );
  expect(index, 'no cell is selected after starting').toBeGreaterThanOrEqual(0);
  const cell = page.locator('#board .cell').nth(index);

  await page.keyboard.press('h');
  await expect(page.locator('#hints')).toHaveText('1');
  await expect(cell).toHaveClass(/given/u);
  await expect(cell).toHaveAccessibleName(/^Fila \d, columna \d, [1-9], dada$/u);
  const hinted = (await cell.locator('.v').innerText()).trim();
  expect(hinted).toMatch(/^[1-9]$/u);

  await page.keyboard.press('z');
  await expect(cell).not.toHaveClass(/given/u);
  await expect(cell).toHaveAccessibleName(/^Fila \d, columna \d, vacía$/u);
  await expect(cell.locator('.v')).toBeEmpty();
  await expect(page.locator('#hints')).toHaveText('1');

  await page.keyboard.press(String((Number(hinted) % 9) + 1));
  await expect(page.locator('#mistakes')).toHaveText('1');
  await page.keyboard.press('z');
  await expect(cell.locator('.v')).toBeEmpty();
  await expect(page.locator('#mistakes')).toHaveText('1');
});

test('a hint still works on the cell left selected by a correct entry', async ({ page }) => {
  await page.locator('#startOverlay button.diff[data-d="medium"]').click();
  await expect(page.locator('#startOverlay')).toBeHidden();

  await page.evaluate(() => {
    const i = values.findIndex((_v, k) => !fixed[k]);
    sel = i;
    inputDigit(solution[i]);
  });
  const before = await page.locator('#remaining').textContent();

  await page.keyboard.press('h');
  await expect(page.locator('#hints')).toHaveText('1');
  await expect(page.locator('#remaining'), 'the hint revealed nothing').not.toHaveText(before);
});

test('a hint asked of a given lands on another cell, and says so', async ({ page }) => {
  await page.locator('#startOverlay button.diff[data-d="medium"]').click();
  await expect(page.locator('#startOverlay')).toBeHidden();

  const before = await page.locator('#remaining').textContent();
  const given = await page.evaluate(() => {
    const i = fixed.findIndex((f) => f);
    sel = i;
    return i;
  });
  await page.locator('#board .cell.given').first().click();
  await page.keyboard.press('h');

  await expect(page.locator('#hints')).toHaveText('1');
  await expect(page.locator('#remaining'), 'the hint revealed nothing').not.toHaveText(before);
  await expect(page.locator('#srStatus')).toHaveText(/pista en otra/iu);
  expect(await page.evaluate(() => sel), 'the selection stayed on the given').not.toBe(given);
});

test('a hint picks the cell with the fewest candidates, not one at random', async ({ page }) => {
  await page.locator('#startOverlay button.diff[data-d="medium"]').click();
  await expect(page.locator('#startOverlay')).toBeHidden();

  const verdict = await page.evaluate(() => {
    const candidates = (i) => {
      const taken = new Set();
      for (const p of PEERS[i]) if (values[p]) taken.add(values[p]);
      return 9 - taken.size;
    };
    const open = [];
    for (let i = 0; i < 81; i++) if (values[i] !== solution[i]) open.push(candidates(i));
    const fewest = Math.min(...open);
    sel = -1;
    hint();
    return { chosen: candidates(sel), fewest };
  });
  expect(verdict.chosen).toBe(verdict.fewest);
});

test('a hint undone and asked for again is charged once', async ({ page }) => {
  await page.locator('#startOverlay button.diff[data-d="medium"]').click();
  await expect(page.locator('#startOverlay')).toBeHidden();

  await page.keyboard.press('h');
  await expect(page.locator('#hints')).toHaveText('1');
  const cell = page.locator('#board .cell').nth(await page.evaluate(() => sel));
  await expect(cell).toHaveClass(/given/u);

  await page.keyboard.press('z');
  await expect(cell).not.toHaveClass(/given/u);

  await page.keyboard.press('h');
  await expect(cell).toHaveClass(/given/u);
  await expect(page.locator('#hints')).toHaveText('1');
});

test('undo says so without silencing the count it moved', async ({ page }) => {
  await page.locator('#startOverlay button.diff[data-d="medium"]').click();
  await expect(page.locator('#startOverlay')).toBeHidden();

  await page.evaluate(() => {
    const unfilled = () => values.filter((v, i) => !v || v !== solution[i]).length;
    for (let i = 0; i < 81 && unfilled() > 20; i++) {
      if (fixed[i] || values[i] === solution[i]) continue;
      sel = i;
      inputDigit(solution[i]);
    }
  });
  await expect(page.locator('#remaining')).toHaveText('20 por llenar');

  await page.evaluate(() => {
    const i = values.findIndex((_v, k) => !fixed[k] && values[k] !== solution[k]);
    sel = i;
    inputDigit(solution[i]);
  });
  await expect(page.locator('#srStatus')).toHaveText(/19 celdas por llenar/u);

  await page.keyboard.press('z');
  await expect(page.locator('#srStatus')).toHaveText(/Deshecho\./u);
  await expect(page.locator('#srStatus'), 'the undo ate the count it had just moved').toHaveText(
    /20 celdas por llenar/u,
  );
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

  await page.locator('#board .cell').first().click();
  expect(await ring()).toEqual({ visible: false, outline: 'none' });

  test.skip(
    test.info().project.name !== 'chromium',
    'Tab does not visit buttons in Safari without Full Keyboard Access',
  );

  await page.locator('#pauseBtn').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#board .cell').first()).toBeFocused();
  expect(await ring()).toEqual({ visible: true, outline: 'solid 2px rgb(49, 80, 126)' });
});

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
  const scope = await readyScope(page);
  expect(scope, 'no service worker took control of the page').not.toBeNull();
  expect(new URL(scope).pathname).toBe('/sudoku/');
  if (test.info().project.name === 'chromium') {
    expect(page.context().serviceWorkers().length).toBeGreaterThan(0);
  }
});

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
        const address = printed.match(/http:\/\/\S+/u);
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
