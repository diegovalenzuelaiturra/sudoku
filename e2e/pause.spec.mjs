import { expect, test } from '@playwright/test';

const CELL_NAME = /^Fila \d, columna \d/u;

/* Everything Chrome would hand to assistive tech: ignored nodes are dropped,
   and an inert subtree is ignored. */
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

const countCells = (nodes) =>
  nodes.filter((node) => node.role === 'button' && CELL_NAME.test(node.name)).length;

const CONTROL_NAMES = [/deshacer/iu, /borrar/iu, /notas/iu, /pista/iu];

const countControls = (nodes) =>
  CONTROL_NAMES.filter((label) =>
    nodes.some((node) => /^(button|radio)$/u.test(node.role) && label.test(node.name)),
  ).length;

function expectExposedCells(cdp, count) {
  return expect
    .poll(async () => countCells(await accessibleNodes(cdp)), {
      message: `expected ${count} board cells in the accessibility tree Chrome exposes`,
      timeout: 15_000,
    })
    .toBe(count);
}

function expectExposedControls(cdp, count) {
  return expect
    .poll(async () => countControls(await accessibleNodes(cdp)), {
      message: `expected ${count} control buttons in the tree Chrome exposes`,
      timeout: 15_000,
    })
    .toBe(count);
}

async function startGame(page) {
  await page.locator('#startOverlay button.diff[data-d="medium"]').click();
  await expect(page.locator('#startOverlay')).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  /* Relative, so the request goes through the /sudoku/ prefix in baseURL. */
  await page.goto('./');
});

test('pausing takes all 81 cells out of the accessibility tree', async ({ page, context }) => {
  test.skip(
    test.info().project.name !== 'chromium',
    'reads the accessibility tree, which only Chromium exposes over CDP',
  );
  const cdp = await context.newCDPSession(page);
  await startGame(page);

  await expectExposedCells(cdp, 81);

  await page.locator('#pauseBtn').click();
  await expect(page.locator('#veil')).toBeVisible();

  await expect(page.locator('#board .cell').first()).toBeVisible();
  await expectExposedCells(cdp, 0);
  await expectExposedControls(cdp, 0);

  const paused = await accessibleNodes(cdp);
  const veil = paused.find((node) => node.role === 'dialog' && node.name === 'EN PAUSA');
  expect(veil, 'the pause dialog is not exposed as a named dialog').toBeTruthy();
  expect(veil.properties.modal, 'the pause dialog is not modal').toBe(true);

  await page.locator('#resumeBtn').click();
  await expectExposedCells(cdp, 81);
  await expectExposedControls(cdp, CONTROL_NAMES.length);
});

const focusedRegion = () => {
  const region = document.activeElement?.closest('#board, .controls');
  if (!region) return 'outside';
  return region.id === 'board' ? 'board' : 'controls';
};

test('a paused board and its controls cannot be reached with the keyboard', async ({ page }) => {
  await startGame(page);
  await page.locator('#pauseBtn').click();
  await expect(page.locator('#resumeBtn')).toBeFocused();

  const visited = [];
  for (const key of ['Tab', 'Shift+Tab']) {
    await page.locator('#resumeBtn').focus();
    for (let step = 0; step < 10; step++) {
      await page.keyboard.press(key);
      visited.push(await page.evaluate(focusedRegion));
    }
  }

  expect(visited.filter((region) => region !== 'outside')).toEqual([]);
});

test('focus moves into the pause dialog and returns to the pause button', async ({ page }) => {
  await startGame(page);

  await page.locator('#pauseBtn').click();
  await expect(page.locator('#veil #resumeBtn')).toBeFocused();

  await page.locator('#resumeBtn').click();
  await expect(page.locator('#veil')).toBeHidden();
  await expect(page.locator('#pauseBtn')).toBeFocused();
});

test('Escape resumes', async ({ page, context }) => {
  test.skip(
    test.info().project.name !== 'chromium',
    'reads the accessibility tree, which only Chromium exposes over CDP',
  );
  const cdp = await context.newCDPSession(page);
  await startGame(page);

  await page.locator('#pauseBtn').click();
  await expect(page.locator('#veil')).toBeVisible();
  await expectExposedCells(cdp, 0);
  await expectExposedControls(cdp, 0);

  await page.keyboard.press('Escape');

  await expect(page.locator('#veil')).toBeHidden();
  await expectExposedCells(cdp, 81);
  await expectExposedControls(cdp, CONTROL_NAMES.length);
  await expect(page.locator('#pauseBtn')).toBeFocused();
});

test('the record can be read from the pause, and the clock does not run', async ({ page }) => {
  await startGame(page);
  await page.locator('#pauseBtn').click();

  await page.locator('#veilRecordBtn').click();
  await expect(page.locator('#recordOverlay')).toBeVisible();

  const clock = await page.locator('#time').textContent();
  await page.waitForTimeout(1400);
  expect(await page.locator('#time').textContent(), 'reading the record cost the player time').toBe(
    clock,
  );

  await page.locator('#closeRecord').click();
  await expect(page.locator('#recordOverlay')).toBeHidden();
  await expect(page.locator('#veil')).toBeVisible();
  await expect(page.locator('#veilRecordBtn')).toBeFocused();
});

test('a paused game can be left without being resumed first', async ({ page }) => {
  await startGame(page);
  await page.locator('#pauseBtn').click();
  await expect(page.locator('#veil')).toBeVisible();

  await page.locator('#newBtn').click();
  await expect(page.locator('#startOverlay')).toBeVisible();
  await expect(page.locator('#cancelNew')).toBeVisible();

  await page.locator('#cancelNew').click();
  await expect(page.locator('#veil')).toBeVisible();
  await expect(page.locator('#resumeBtn')).toBeFocused();
});

test('tapping the veiled board resumes', async ({ page }) => {
  await startGame(page);
  await page.locator('#pauseBtn').click();
  await expect(page.locator('#veil')).toBeVisible();

  const title = await page.locator('#veilTitle').boundingBox();
  const veil = await page.locator('#veil').boundingBox();
  await page.locator('#veil').click({
    position: {
      x: title.x + title.width / 2 - veil.x,
      y: title.y + title.height / 2 - veil.y,
    },
  });

  await expect(page.locator('#veil')).toBeHidden();
  await expect(page.locator('#board .cell').first()).toBeVisible();
});
