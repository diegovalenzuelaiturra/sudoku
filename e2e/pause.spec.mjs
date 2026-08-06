/* Pausing has to hide the board from assistive tech, not only from sight.

   The regression this guards: .board.veiled only sets color:transparent. The
   board looked hidden while a screen reader still read every solved value and
   Tab still walked all 81 cells. The fix marks the board and the controls
   inert while paused.

   The suite that used to cover this booted the page in a DOM simulator rather
   than a browser, and could not see any of it. The simulator had no
   accessibility tree, so it could only assert that the page set the inert
   property; it could not assert what inert does, which is the entire
   behaviour. That is why the bug had to be caught by hand in Chrome, it is why
   those tests were rewritten here, and it is why the simulator has been
   deleted from this repository.

   Playwright's own role engine is not enough either: measured on Playwright
   1.62, getByRole() and ariaSnapshot() both still report all 81 cells while
   the board is inert, because they compute roles from the DOM rather than
   reading the browser's tree. So these tests ask Chrome over CDP for the tree
   it actually exposes, where an inert subtree is ignored wholesale. That is
   the tree a screen reader walks, and it is the only place this bug shows. */

import { expect, test } from '@playwright/test';

/* The name render() gives every cell: "Fila 3, columna 7, 4, dada". */
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

/* The named buttons pausing takes away. The board is only half of it: .controls
   holds undo, erase and the two writing modes, Pista sits in the header, and
   #pauseBtn is in neither place, so nothing else in the suite notices if any of
   them is taken away and never handed back.

   Nueva partida is not on this list and is covered on its own below, because it
   is the one action a paused game keeps. */
const CONTROL_NAMES = [/deshacer/iu, /borrar/iu, /notas/iu, /pista/iu];

/* radio as well as button: the notes control is one half of a radio group now,
   which is what puts both modes on screen at once instead of asking the player
   to remember which way a toggle was left. */
const countControls = (nodes) =>
  CONTROL_NAMES.filter((label) =>
    nodes.some((node) => /^(button|radio)$/u.test(node.role) && label.test(node.name)),
  ).length;

/* Polled rather than read once: the accessibility tree is rebuilt off the back
   of the DOM change, and CI hardware is slower than a laptop. */
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

  /* The cells are still painted, only transparent: this is exactly the state
     in which the old code kept reading the solution out to a screen reader. */
  await expect(page.locator('#board .cell').first()).toBeVisible();
  await expectExposedCells(cdp, 0);
  /* The controls act on the values the board holds, so they go with it. */
  await expectExposedControls(cdp, 0);

  /* Hiding the board must not hide the way out of the pause, or a screen
     reader user is left with a page that went silent. */
  const paused = await accessibleNodes(cdp);
  const veil = paused.find((node) => node.role === 'dialog' && node.name === 'EN PAUSA');
  expect(veil, 'the pause dialog is not exposed as a named dialog').toBeTruthy();
  /* aria-modal as Chrome understood it, not as the markup claims it. Without
     it a screen reader wanders out of the dialog into the header, the stats
     and the live regions, which are all pausing leaves reachable. */
  expect(veil.properties.modal, 'the pause dialog is not modal').toBe(true);

  await page.locator('#resumeBtn').click();
  await expectExposedCells(cdp, 81);
  /* Resuming has to hand both regions back. Marking the controls inert on the
     way in and never clearing it leaves the digit pad, undo, erase, notes,
     hint and new game unclickable, untabbable and absent from the tree while
     the board looks perfectly normal. */
  await expectExposedControls(cdp, CONTROL_NAMES.length);
});

/* Which paused region holds the focused element, if any. Reported by region
   rather than by element so a button added elsewhere on the page later does
   not turn into a failure here. */
const focusedRegion = () => {
  const region = document.activeElement?.closest('#board, .controls');
  if (!region) return 'outside';
  return region.id === 'board' ? 'board' : 'controls';
};

test('a paused board and its controls cannot be reached with the keyboard', async ({ page }) => {
  await startGame(page);
  await page.locator('#pauseBtn').click();
  await expect(page.locator('#resumeBtn')).toBeFocused();

  /* Tab order is the other half of inert. The board sits before the veil in
     the document, so walking forward from the resume button reaches the
     controls and walking back reaches the cells; while paused both are inert,
     so neither walk should ever land inside them. */
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
  /* Scoped to #veil, so this asserts focus landed inside the dialog rather
     than on some button that merely carries the same id. */
  await expect(page.locator('#veil #resumeBtn')).toBeFocused();

  await page.locator('#resumeBtn').click();
  await expect(page.locator('#veil')).toBeHidden();
  /* Back where the player left it, not dumped on the body. */
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

/* The record used to be reachable only through the difficulty picker, which is
   the dialog for leaving a board. Pausing is where a player stops to look at
   something, and it is the one moment in the game when looking is free. */
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
  /* Back to the pause that opened it, rather than onto the board: the player
     asked for the record, not to start playing again. */
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
  /* Still paused. This dialog is not what stopped the clock, so closing it puts
     nothing back: the pause is left exactly where it was found. */
  await expect(page.locator('#veil')).toBeVisible();
  await expect(page.locator('#resumeBtn')).toBeFocused();
});

/* The veil covers the board, so a tap on it is a tap on the sudoku, which is
   what a player reaches for to carry on. The button stays for the keyboard and
   for anyone who looks for one. */
test('tapping the veiled board resumes', async ({ page }) => {
  await startGame(page);
  await page.locator('#pauseBtn').click();
  await expect(page.locator('#veil')).toBeVisible();

  /* On the words EN PAUSA, in the middle of the board, which is where a thumb
     lands. The paragraph takes no pointer events for this reason: without that
     the one spot the eye is drawn to is the one spot the tap does nothing. */
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
