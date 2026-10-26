/* The live regions. They must exist in the DOM from first paint (a region
   injected together with its text is not announced) and must stay quiet
   while the player is only moving the selection around. */

import { expect, test } from '@playwright/test';

/* Everything Chrome would hand to assistive tech. Text is collected from the
   subtree because a live region is not named by its contents: role="status"
   carries an empty name and holds the announcement in child text nodes. */
async function accessibleNodes(cdp) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const text = (node) =>
    node.name?.value ||
    (node.childIds ?? [])
      .map((id) => (byId.get(id) ? text(byId.get(id)) : ''))
      .join(' ')
      .trim();
  const property = (node, name) =>
    node.properties?.find((entry) => entry.name === name)?.value?.value;

  return nodes
    .filter((node) => !node.ignored)
    .map((node) => ({
      role: node.role?.value ?? '',
      name: node.name?.value ?? '',
      text: text(node),
      description: node.description?.value ?? '',
      live: property(node, 'live'),
      atomic: property(node, 'atomic'),
    }));
}

const liveRegion = (nodes, role) => nodes.find((node) => node.role === role);

const spriteReport = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('use')].map((use) => {
      const href = use.getAttribute('href');
      const target = href?.startsWith('#') ? document.getElementById(href.slice(1)) : null;
      const box = use.getBoundingClientRect();
      const owner = use.closest('button');
      const ownerBox = owner?.getBoundingClientRect();
      return {
        href,
        owner: owner?.id ?? null,
        tag: target ? target.tagName.toLowerCase() : null,
        draws: !!target?.querySelector('path'),
        painted: box.width > 0 && box.height > 0,
        onScreen: !!ownerBox && ownerBox.width > 0 && ownerBox.height > 0,
      };
    }),
  );

async function startGame(page) {
  await page.locator('#startOverlay button.diff[data-d="medium"]').click();
  await expect(page.locator('#startOverlay')).toBeHidden();
}

const selectedCell = (page) => page.locator('#board .cell.sel').getAttribute('data-i');

/* Playwright runs one test at a time per worker, so a single list refilled per
   test is safe. */
const problems = [];

test.beforeEach(async ({ page }) => {
  problems.length = 0;
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));

  /* Relative, so the request goes through the /sudoku/ prefix in baseURL. */
  await page.goto('./');
  await expect(page.locator('#board .cell')).toHaveCount(81);
});

test.afterEach(() => {
  expect(problems).toEqual([]);
});

test('every icon reference resolves to a symbol the browser can paint', async ({ page }) => {
  const uses = await spriteReport(page);
  expect(uses.length, `only ${uses.length} icons are wired up`).toBeGreaterThanOrEqual(7);

  for (const use of uses) {
    expect(use.href, `icon reference is not a sprite id: ${use.href}`).toMatch(/^#/u);
    expect(use.tag, `icon ${use.href} has no matching <symbol> in the sprite`).toBe('symbol');
    expect(use.draws, `symbol ${use.href} draws nothing`).toBe(true);
    if (use.onScreen) {
      expect(use.painted, `icon ${use.href} on ${use.owner} resolved to an empty box`).toBe(true);
    }
  }

  const play = page.locator('symbol#i-play_arrow');
  await expect(play, 'the play icon is missing from the sprite').toHaveCount(1);
  await expect(play.locator('path'), 'the play icon draws nothing').not.toHaveCount(0);
  const source = await (await page.request.get('./')).text();
  expect(source, 'the play icon is never used').toMatch(
    /<use href="#i-play_arrow"|'#i-play_arrow'/u,
  );
});

const LABELLED = [
  ['undoBtn', 'Deshacer Z'],
  ['eraseBtn', 'Borrar ⌫'],
];

const ICON_ONLY = [
  ['pauseBtn', 'Pausar'],
  ['newBtn', 'Nueva partida'],
  ['hintBtn', 'Pista'],
];

test('icons decorate the buttons without touching their accessible names', async ({
  page,
  context,
}) => {
  test.skip(
    test.info().project.name !== 'chromium',
    'reads the accessibility tree, which only Chromium exposes over CDP',
  );
  const cdp = await context.newCDPSession(page);
  await startGame(page);

  for (const [id, name] of LABELLED) {
    await expect(page.locator(`#${id} use`), `${id} lost its icon`).toHaveCount(1);
    await expect(page.locator(`#${id}`)).toHaveAccessibleName(name, { ignoreCase: true });
  }

  for (const [id, name] of ICON_ONLY) {
    await expect(page.locator(`#${id} use`), `${id} lost its icon`).toHaveCount(1);
    await expect(page.locator(`#${id}`), `${id} grew a visible label`).toHaveText('');
    await expect(page.locator(`#${id}`)).toHaveAccessibleName(name);
  }

  for (const [id, name] of [
    ['penBtn', 'Lápiz'],
    ['notesBtn', 'Notas'],
  ]) {
    await expect(page.locator(`#${id}`)).toHaveAccessibleName(name, { ignoreCase: true });
    await expect(page.locator(`#${id}`)).toHaveAttribute('role', 'radio');
  }

  const nodes = await accessibleNodes(cdp);
  const names = nodes.filter((node) => node.role === 'button').map((node) => node.name.trim());
  for (const [, name] of [...LABELLED, ...ICON_ONLY]) {
    expect(names.map((entry) => entry.toLocaleLowerCase())).toContain(name.toLocaleLowerCase());
  }

  const graphics = nodes.filter((node) => /image|graphic|svg/iu.test(node.role));
  expect(graphics, 'an icon reached the accessibility tree').toEqual([]);

  /* The sixth labelled button lives in the win modal, which is display:none
     until the game is won, and a hidden element has no accessible name to
     compute: measured, toHaveAccessibleName reports "" for it here. */
  await expect(page.locator('#againBtn use'), 'againBtn lost its icon').toHaveCount(1);
  await expect(page.locator('#againBtn')).toContainText('Otra al tiro');
  await expect(page.locator('#againBtn svg')).toHaveAttribute('aria-hidden', 'true');
});

test('pausing swaps the pause icon instead of wiping it out', async ({ page, context }) => {
  test.skip(
    test.info().project.name !== 'chromium',
    'reads the accessibility tree, which only Chromium exposes over CDP',
  );
  const cdp = await context.newCDPSession(page);
  await startGame(page);

  const icon = page.locator('#pauseBtn use');
  await expect(icon).toHaveAttribute('href', '#i-pause');

  await page.locator('#pauseBtn').click();
  await expect(page.locator('#veil')).toBeVisible();
  await expect(icon, 'the pause icon was destroyed on pause').toHaveCount(1);
  await expect(icon).toHaveAttribute('href', '#i-play_arrow');
  const paused = await spriteReport(page);
  expect(paused.find((use) => use.owner === 'pauseBtn')).toMatchObject({
    href: '#i-play_arrow',
    tag: 'symbol',
    painted: true,
  });
  await expect(page.locator('#pauseBtn')).toHaveAccessibleName('Seguir');
  expect(
    (await accessibleNodes(cdp)).some((node) => node.role === 'button' && node.name === 'Seguir'),
  ).toBe(true);

  const resume = paused.find((use) => use.owner === 'resumeBtn');
  expect(resume, 'the resume button lost its icon').toMatchObject({
    href: '#i-play_arrow',
    tag: 'symbol',
    painted: true,
  });
  await expect(page.locator('#resumeBtn svg')).toHaveAttribute('aria-hidden', 'true');
  /* Case insensitively, because .newgame uppercases its label in CSS and
     Chrome computes the name from the transformed text. */
  await expect(page.locator('#resumeBtn')).toHaveAccessibleName('Seguir', { ignoreCase: true });

  await page.locator('#resumeBtn').click();
  await expect(page.locator('#veil')).toBeHidden();
  await expect(icon).toHaveAttribute('href', '#i-pause');
  await expect(page.locator('#pauseBtn')).toHaveAccessibleName('Pausar');
  expect(
    (await spriteReport(page)).find((use) => use.owner === 'pauseBtn')?.painted,
    'the pause icon stopped painting after resuming',
  ).toBe(true);
});

test('both live regions exist and are empty before anything happens', async ({ page, context }) => {
  test.skip(
    test.info().project.name !== 'chromium',
    'reads the accessibility tree, which only Chromium exposes over CDP',
  );
  const cdp = await context.newCDPSession(page);
  const status = page.locator('#srStatus');
  const alert = page.locator('#srAlert');

  await expect(status, 'no polite live region').toHaveCount(1);
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status, 'the start screen announced something').toHaveText('');
  await expect(alert, 'no assertive live region').toHaveCount(1);
  await expect(alert).toHaveAttribute('role', 'alert');
  await expect(alert).toHaveText('');

  for (const region of [status, alert]) {
    const box = await region.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { width: rect.width, height: rect.height, clip: getComputedStyle(el).clipPath };
    });
    expect(box).toEqual({ width: 1, height: 1, clip: 'inset(50%)' });
  }

  await startGame(page);
  const nodes = await accessibleNodes(cdp);

  expect(liveRegion(nodes, 'status')).toMatchObject({ live: 'polite', atomic: true });
  expect(liveRegion(nodes, 'status').text).toMatch(/^\d+ celdas por llenar\.$/u);
  expect(liveRegion(nodes, 'alert')).toMatchObject({ live: 'assertive', atomic: true, text: '' });
});

test('mistakes and hints are announced politely, selection moves are not', async ({
  page,
  context,
}) => {
  test.skip(
    test.info().project.name !== 'chromium',
    'reads the accessibility tree, which only Chromium exposes over CDP',
  );
  const cdp = await context.newCDPSession(page);
  await startGame(page);
  const status = page.locator('#srStatus');

  await expect(status).toHaveText(/^\d+ celdas por llenar\.$/u);
  const opening = await status.textContent();

  const before = await selectedCell(page);
  for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft']) await page.keyboard.press(key);
  expect(await selectedCell(page), 'the arrow keys never reached the board').not.toBe(before);
  expect(await status.textContent(), 'moving the selection announced something').toBe(opening);

  const { index, wrong } = await page.evaluate(() => {
    const i = values.findIndex((_v, k) => !fixed[k]);
    return { index: i, wrong: (solution[i] % 9) + 1 };
  });
  await page.locator('#board .cell').nth(index).click();
  await page.keyboard.press(String(wrong));
  await expect(status).toHaveText(/1 error/u);

  const nodes = await accessibleNodes(cdp);
  expect(liveRegion(nodes, 'status'), 'the polite region is not live').toMatchObject({
    live: 'polite',
    atomic: true,
  });
  expect(liveRegion(nodes, 'status').text).toMatch(/1 error/u);
  expect(liveRegion(nodes, 'alert'), 'a mistake interrupted the player').toMatchObject({
    live: 'assertive',
    text: '',
  });

  await page.keyboard.press('h');
  await expect(status).toHaveText(/1 pista usada/u);
  expect((await accessibleNodes(cdp)).find((node) => node.role === 'status').text).toMatch(
    /1 pista usada/u,
  );
});

test('winning is announced assertively, with the final tally', async ({ page, context }) => {
  test.skip(
    test.info().project.name !== 'chromium',
    'reads the accessibility tree, which only Chromium exposes over CDP',
  );
  const cdp = await context.newCDPSession(page);
  await startGame(page);

  await page.evaluate(() => {
    seconds = 65;
    for (let i = 0; i < 81; i++) {
      if (values[i] !== solution[i]) {
        sel = i;
        inputDigit(solution[i]);
      }
    }
  });

  const announced = await page.locator('#srAlert').textContent();
  expect(announced).toMatch(/^Ganaste\./u);
  expect(announced, `win time not announced: ${announced}`).toMatch(/1:0[5-9]/u);
  expect(announced).toMatch(/0 errores/u);
  expect(announced).toMatch(/0 pistas/u);

  const winNodes = await accessibleNodes(cdp);
  expect(liveRegion(winNodes, 'alert'), 'the win is not announced assertively').toMatchObject({
    live: 'assertive',
    atomic: true,
  });
  expect(liveRegion(winNodes, 'alert').text).toMatch(/^Ganaste\./u);

  await expect(page.locator('#winOverlay')).toBeVisible();
  const again = (await spriteReport(page)).find((use) => use.owner === 'againBtn');
  expect(again).toMatchObject({ href: '#i-refresh', tag: 'symbol', painted: true });

  const nodes = await accessibleNodes(cdp);
  const names = nodes.filter((node) => node.role === 'button').map((node) => node.name.trim());
  expect(names.map((name) => name.toLocaleLowerCase())).toContain('otra al tiro');
});

test('the board only claims a role its own children can satisfy', async ({ page, context }) => {
  test.skip(
    test.info().project.name !== 'chromium',
    'reads the accessibility tree, which only Chromium exposes over CDP',
  );
  const cdp = await context.newCDPSession(page);
  const board = page.locator('#board');

  await expect(page.locator('#board > *'), 'the board is not built from 81 flat cells').toHaveCount(
    81,
  );
  const label = await board.getAttribute('aria-label');
  expect(label, 'the board has no accessible name').toBeTruthy();

  const role = await board.getAttribute('role');
  expect(role, 'a bare div drops its aria-label, so the board needs a role').toBeTruthy();
  if (['grid', 'table', 'treegrid'].includes(role)) {
    await expect(
      board.locator(':scope > [role="row"]'),
      `role="${role}" requires role="row" children, and the cells are appended flat`,
    ).not.toHaveCount(0);
  }

  /* What a browser still cannot answer here is the audit rule itself
     (aria-required-children): Chrome reports the tree it built, not the
     violations in it, so the flat children check above stays a DOM check. */
  await startGame(page);
  const nodes = await accessibleNodes(cdp);
  expect(nodes.some((node) => node.role === role && node.name === label)).toBe(true);
});

test('changing mode moves nothing, and still explains itself to a reader', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await startGame(page);

  const hint = page.locator('#notesHint');
  const notes = page.locator('#notesBtn');
  const text = await hint.textContent();
  expect(text, 'the hint says nothing').toMatch(/candidat/iu);

  const keypad = () => page.locator('#pad').boundingBox();
  const before = await keypad();

  await notes.click();
  await expect(notes).toHaveAttribute('aria-checked', 'true');
  expect(await keypad(), 'turning notes on moved the keypad').toEqual(before);
  expect((await hint.boundingBox()).width, 'the description took layout space').toBeLessThan(5);

  await notes.click();
  await expect(notes, 'the group toggled instead of choosing').toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.locator('#penBtn').click();
  await expect(notes).toHaveAttribute('aria-checked', 'false');
  expect(await keypad(), 'turning notes off moved the keypad').toEqual(before);

  test.skip(
    test.info().project.name !== 'chromium',
    'reads the accessibility tree, which only Chromium exposes over CDP',
  );
  const cdp = await context.newCDPSession(page);
  const described = () =>
    accessibleNodes(cdp).then(
      (nodes) =>
        nodes.find((node) => node.role === 'radio' && /Notas/u.test(node.name))?.description,
    );

  expect(await described(), 'the button carries no description while notes are off').toBe(text);
  await notes.click();
  expect(await described(), 'the description was lost when the mode came on').toBe(text);
});

/* Double tap to zoom on iOS: a second tap within about 300ms was read as a
   zoom gesture, so entering two digits quickly zoomed the page instead of
   playing.

   What this can check in Chromium is the declaration, not the iOS gesture. It
   is asserted on body because the permitted behaviours are the intersection of
   an element's value with its ancestors': the pad keys keep computing "auto"
   and still cannot zoom, and body losing this is the only way that breaks. */
test('a double tap cannot zoom the page, while pinch to zoom still can', async ({ page }) => {
  await startGame(page);

  const touchAction = (selector) =>
    page.locator(selector).evaluate((node) => getComputedStyle(node).touchAction);

  expect(await touchAction('body'), 'double tap can zoom the page again').toBe('manipulation');
  /* The walk up the ancestors runs only "up to the one that implements the
     gesture (in other words, the first containing scrolling element)", and
     .board is overflow:hidden, which makes it exactly that. */
  expect(
    await touchAction('#board'),
    'the board is back to inheriting a gesture the scroll container can truncate',
  ).toBe('manipulation');
  for (const selector of ['body', '#board', '#pad', '.tools']) {
    expect(await touchAction(selector), `${selector} forbids pinch to zoom`).not.toBe('none');
  }
});

test('every target a thumb aims at clears 44px on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await startGame(page);

  const box = async (selector) => {
    const rect = await page.locator(selector).first().boundingBox();
    return { w: Math.round(rect.width * 10) / 10, h: Math.round(rect.height * 10) / 10 };
  };

  for (const selector of ['.key', '#undoBtn', '#eraseBtn', '#pauseBtn', '#newBtn', '#hintBtn']) {
    const { w, h } = await box(selector);
    expect(w, `${selector} is ${w}px wide, under the 44px minimum`).toBeGreaterThanOrEqual(44);
    expect(h, `${selector} is ${h}px tall, under the 44px minimum`).toBeGreaterThanOrEqual(44);
  }

  const keys = await page.locator('.key').all();
  const tops = new Set();
  for (const key of keys) tops.add(Math.round((await key.boundingBox()).y));
  expect(tops.size, 'the keypad is not three rows').toBe(3);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow, 'something is wider than the page').toBe(false);
});

test('tapping the same digit again leaves the cell alone', async ({ page }) => {
  await page.goto('./');
  await startGame(page);

  const target = await page.evaluate(() => values.findIndex((v, i) => v === 0 && !fixed[i]));
  const cell = page.locator('#board .cell').nth(target);
  await cell.click();

  const digit = page.locator('.key').nth(4);
  await digit.click();
  await expect(cell.locator('.v'), 'the first tap did not land').toHaveText('5');
  await digit.click();
  await expect(cell.locator('.v'), 'the second tap erased the first').toHaveText('5');
  await digit.click();
  await expect(cell.locator('.v'), 'a third tap erased it').toHaveText('5');

  await page.locator('#eraseBtn').click();
  await expect(cell.locator('.v')).toHaveText('');
});

test('notes mode is visible on the keypad without taking it out of flow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await startGame(page);

  const shape = () =>
    page.evaluate(() => {
      const pad = document.getElementById('pad');
      const rect = pad.getBoundingClientRect();
      const key = document.querySelector('.key');
      return {
        position: getComputedStyle(pad).position,
        height: Math.round(rect.height),
        keyBg: getComputedStyle(key).backgroundColor,
        keyHeight: Math.round(key.getBoundingClientRect().height),
        digitSize: getComputedStyle(key.querySelector('.d')).fontSize,
      };
    });

  const off = await shape();
  expect(off.position, 'the keypad is not in flow with notes off').toBe('static');

  await page.locator('#notesBtn').click();
  await expect(page.locator('#notesBtn')).toHaveAttribute('aria-checked', 'true');
  await page.waitForTimeout(250);
  const on = await shape();

  expect(on.position, 'notes mode took the keypad out of flow').toBe('static');
  expect(on.height, 'notes mode changed the size of the keypad').toBe(off.height);
  expect(on.digitSize, 'the digits are a different size in notes mode').toBe(off.digitSize);
  expect(on.keyHeight, 'the keys are a different height in notes mode').toBe(off.keyHeight);
  expect(on.keyBg, 'the keypad says nothing about the mode it is in').not.toBe(off.keyBg);
  await expect(page.locator('#pad')).toHaveClass(/noting/u);
});

test('the controls are narrower than the board and centred under it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await startGame(page);

  for (const size of [
    { width: 390, height: 844 },
    { width: 375, height: 667 },
  ]) {
    await page.setViewportSize(size);

    const laid = await page.evaluate(() => {
      const rect = (sel) => document.querySelector(sel).getBoundingClientRect();
      const board = rect('.board');
      const controls = rect('.controls');
      return {
        board: { left: Math.round(board.left), right: Math.round(board.right) },
        controls: { left: Math.round(controls.left), right: Math.round(controls.right) },
        boardWidth: Math.round(board.width),
        controlsWidth: Math.round(controls.width),
        key: {
          w: Math.round(rect('.key').width),
          h: Math.round(rect('.key').height),
        },
      };
    });

    const where = `${size.width} wide`;
    expect(laid.controlsWidth, `the controls overhang the board at ${where}`).toBeLessThanOrEqual(
      laid.boardWidth,
    );
    expect(
      laid.controls.left,
      `the controls start left of the board at ${where}`,
    ).toBeGreaterThanOrEqual(laid.board.left);
    expect(
      laid.controls.right,
      `the controls end right of the board at ${where}`,
    ).toBeLessThanOrEqual(laid.board.right);
    const leftGap = laid.controls.left - laid.board.left;
    const rightGap = laid.board.right - laid.controls.right;
    expect(
      Math.abs(leftGap - rightGap),
      `the controls are not centred at ${where}`,
    ).toBeLessThanOrEqual(1);
    expect(laid.key.w, `a key is under 44px wide at ${where}`).toBeGreaterThanOrEqual(44);
    expect(laid.key.h, `a key is under 44px tall at ${where}`).toBeGreaterThanOrEqual(44);
  }
});

test('the costly button is out of the tool row and goes quiet while paused', async ({ page }) => {
  await page.goto('./');
  await startGame(page);

  await expect(page.locator('.tools #hintBtn'), 'Pista is back in the tool row').toHaveCount(0);
  await expect(page.locator('header #hintBtn')).toHaveCount(1);

  await page.locator('#pauseBtn').click();
  await expect(page.locator('#veil')).toBeVisible();
  await expect(
    page.locator('#hintBtn'),
    'Pista still takes a click with the board covered',
  ).toHaveJSProperty('inert', true);
  await expect(page.locator('#newBtn')).toHaveJSProperty('inert', false);
  await page.locator('#resumeBtn').click();
  await expect(page.locator('#hintBtn')).toHaveJSProperty('inert', false);
});

test('the win dialog cannot arrive on top of the difficulty picker', async ({ page }) => {
  await startGame(page);

  await page.evaluate(() => {
    for (let i = 0; i < 81; i++) {
      if (values[i] !== solution[i]) {
        sel = i;
        inputDigit(solution[i]);
      }
    }
  });
  expect(await page.evaluate(() => solved), 'the board did not register as solved').toBe(true);

  await page.locator('#newBtn').click();
  await expect(page.locator('#startOverlay')).toBeVisible();
  await page.waitForTimeout(2600);

  await expect(page.locator('#winOverlay'), 'the win dialog opened over the picker').toBeHidden();
  await expect(page.locator('#startOverlay')).toBeVisible();
  await expect(page.locator('#cancelNew')).toBeHidden();
});

test('a finished game is never offered back', async ({ page }) => {
  await startGame(page);
  await page.evaluate(() => {
    for (let i = 0; i < 81; i++) {
      if (values[i] !== solution[i]) {
        sel = i;
        inputDigit(solution[i]);
      }
    }
  });
  await expect(page.locator('#winOverlay')).toBeVisible();

  await page.locator('#againBtn').click();
  await expect(page.locator('#startOverlay')).toBeVisible();
  await expect(
    page.locator('#cancelNew'),
    'the finished game is offered back through Seguir jugando',
  ).toBeHidden();
  expect(
    await page.evaluate(() => getComputedStyle(document.getElementById('cancelNew')).display),
    'the attribute is set and the stylesheet is drawing it anyway',
  ).toBe('none');
});

test('the buttons that close a dialog are the full width of it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');

  const spans = async (id, holder) => {
    const button = await page.locator(`#${id}`).boundingBox();
    const around = await page.locator(holder).boundingBox();
    return { button, ratio: button.width / around.width };
  };

  await startGame(page);
  await page.locator('#pauseBtn').click();
  const resume = await spans('resumeBtn', '#veil');
  expect(resume.button.height, 'Seguir is not a button, it is browser default').toBeGreaterThan(32);
  await page.locator('#resumeBtn').click();

  await page.locator('#newBtn').click();
  await page.locator('#recordBtn').click();
  const close = await spans('closeRecord', '#recordOverlay .modal');
  expect(close.button.height, 'Listo lost the shape that makes it a button').toBeGreaterThan(32);
  expect(close.ratio, 'Listo no longer spans the dialog').toBeGreaterThan(0.8);
});

/* Stubbed, because no engine Playwright drives has a vibration motor and because
   what is worth holding down is when the game asks and when it does not. */
const stubVibrate = (page) =>
  page.addInitScript(() => {
    window.buzzLog = [];
    navigator.vibrate = (pattern) => {
      window.buzzLog.push(pattern);
      return true;
    };
  });

const buzzes = (page) => page.evaluate(() => window.buzzLog.length);

async function openRecord(page) {
  await page.locator('#newBtn').click();
  await page.locator('#recordBtn').click();
  await expect(page.getByRole('dialog', { name: 'TU REGISTRO' })).toBeVisible();
}

async function playInto(page, wrong) {
  const target = await page.evaluate(() => values.findIndex((v, i) => v === 0 && !fixed[i]));
  await page.locator('#board .cell').nth(target).click();
  const digit = await page.evaluate(({ i, bad }) => (bad ? (solution[i] % 9) + 1 : solution[i]), {
    i: target,
    bad: wrong,
  });
  await page
    .locator('.key')
    .nth(digit - 1)
    .click();
  return target;
}

test('a mistake buzzes and a correct digit does not', async ({ page }) => {
  await stubVibrate(page);
  await page.goto('./');
  await startGame(page);

  await playInto(page, false);
  expect(await buzzes(page), 'a correct digit buzzed').toBe(0);

  await playInto(page, true);
  expect(await buzzes(page), 'a mistake did not buzz').toBe(1);
  expect(await page.evaluate(() => window.buzzLog[0]), 'the knock is not the one chosen').toEqual([
    40, 30, 40,
  ]);

  await openRecord(page);
  await expect(page.locator('#buzzRow')).toBeHidden();
});

test('a stored preference silences the buzz with no switch on screen', async ({ page }) => {
  await stubVibrate(page);
  await page.addInitScript(() =>
    localStorage.setItem('sudoku:prefs', JSON.stringify({ v: 1, buzz: false })),
  );
  await page.goto('./');
  await startGame(page);

  await playInto(page, true);
  expect(await page.evaluate(() => mistakes), 'the move did not land').toBe(1);
  expect(await buzzes(page), 'it buzzed with the preference set to no').toBe(0);
  expect(
    await page.evaluate(() => document.getElementById('buzzToggle').checked),
    'the switch does not carry the stored answer, so putting it back would show the wrong one',
  ).toBe(false);
});

/* WebKit has never shipped the Vibration API and Chrome on iOS is WebKit, so
   this is the common case. */
test('a platform with no vibration is offered no switch and plays the same', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: undefined });
  });
  const noise = [];
  page.on('console', (m) => {
    if (m.type() === 'error') noise.push(m.text());
  });
  page.on('pageerror', (e) => noise.push(e.message));

  await page.goto('./');
  await startGame(page);
  await playInto(page, true);

  expect(await page.evaluate(() => mistakes), 'the move did not land').toBe(1);
  await openRecord(page);
  await expect(
    page.locator('#buzzRow'),
    'a switch was offered for hardware that is absent',
  ).toBeHidden();
  expect(noise).toEqual([]);
});

test('a cell reads out the pencil marks it is carrying', async ({ page }) => {
  await startGame(page);

  const label = (i) => page.locator('#board .cell').nth(i).getAttribute('aria-label');
  const target = await page.evaluate(() => values.findIndex((v, i) => v === 0 && !fixed[i]));
  const mark = (marks) =>
    page.evaluate(
      ({ i, set }) => {
        notes[i] = new Set(set);
        render();
      },
      { i: target, set: marks },
    );

  await mark([]);
  expect(await label(target)).toMatch(/vacía$/u);
  await mark([3]);
  expect(await label(target), 'one mark is read as a list').toMatch(/vacía, nota 3$/u);
  await mark([6, 3]);
  expect(await label(target), 'the marks are not read in order').toMatch(/vacía, notas 3 y 6$/u);
  await mark([9, 3, 6]);
  expect(await label(target)).toMatch(/vacía, notas 3, 6 y 9$/u);

  await page.evaluate((i) => {
    values[i] = solution[i];
    render();
  }, target);
  expect(await label(target), 'a filled cell still reads out marks').not.toMatch(/nota/u);
});

const nearTheEnd = (page, { leave, noted }) =>
  page.evaluate(
    ({ keep, mark }) => {
      const openFor = (i) => {
        const taken = new Set();
        for (const p of PEERS[i]) if (values[p]) taken.add(values[p]);
        const out = [];
        for (let d = 1; d <= 9; d++) if (!taken.has(d)) out.push(d);
        return out;
      };
      const empties = [];
      for (let i = 0; i < 81; i++) if (!fixed[i]) empties.push(i);
      for (const i of empties.slice(0, empties.length - keep)) values[i] = solution[i];
      const marked = empties.slice(-keep).slice(0, mark);
      for (const i of marked) notes[i] = new Set(openFor(i));
      undoStack = [];
      render();
      return { marked, settleable: marked.filter((i) => notes[i].size === 1) };
    },
    { keep: leave, mark: noted },
  );

test('the offer to confirm single notes appears only when it has work', async ({ page }) => {
  await startGame(page);

  await expect(page.locator('#settleBtn'), 'offered before a single note exists').toBeHidden();

  const { settleable } = await nearTheEnd(page, { leave: 12, noted: 5 });
  expect(settleable.length, 'the fixture left nothing to confirm').toBeGreaterThan(0);
  await expect(page.locator('#settleBtn')).toBeVisible();
  await expect(page.locator('#settleCount')).toHaveText(String(settleable.length));
  await expect(page.locator('#settleBtn')).toHaveAccessibleName(
    `Confirmar ${settleable.length} casillas que ya tienen una sola nota`,
  );
});

test('confirming fills the cells, costs nothing, and one undo takes the batch back', async ({
  page,
}) => {
  await startGame(page);
  const { settleable } = await nearTheEnd(page, { leave: 12, noted: 5 });
  expect(settleable.length, 'the fixture left nothing to confirm').toBeGreaterThan(0);

  await page.locator('#settleBtn').click();

  const after = await page.evaluate(
    (cells) => ({
      filled: cells.every((i) => values[i] === solution[i]),
      notesGone: cells.every((i) => notes[i].size === 0),
      mistakes,
      hints,
    }),
    settleable,
  );
  expect(after.filled, 'a cell was left unfilled or filled wrong').toBe(true);
  expect(after.notesGone, 'the marks it acted on are still there').toBe(true);
  expect(after.mistakes, 'confirming counted an error').toBe(0);
  expect(after.hints, 'confirming was charged as a hint').toBe(0);

  const said =
    settleable.length === 1 ? 'Confirmada 1 casilla' : `Confirmadas ${settleable.length} casillas`;
  await expect(page.locator('#srStatus')).toContainText(said);

  await page.locator('#undoBtn').click();
  const undone = await page.evaluate(
    (cells) => ({
      empty: cells.every((i) => values[i] === 0),
      notesBack: cells.every((i) => notes[i].size === 1),
    }),
    settleable,
  );
  expect(undone.empty, 'undo took back only part of the press').toBe(true);
  expect(undone.notesBack, 'undo lost the marks the press consumed').toBe(true);
});

test('a note narrower than the board is left alone', async ({ page }) => {
  await startGame(page);

  const open = await page.evaluate(() => {
    const i = values.findIndex((v, k) => {
      if (v !== 0 || fixed[k]) return false;
      const taken = new Set();
      for (const p of PEERS[k]) if (values[p]) taken.add(values[p]);
      return 9 - taken.size >= 2;
    });
    notes[i] = new Set([solution[i]]);
    const taken = new Set();
    for (const p of PEERS[i]) if (values[p]) taken.add(values[p]);
    render();
    return 9 - taken.size;
  });

  expect(open, 'the fixture found no cell with room to spare').toBeGreaterThanOrEqual(2);
  await expect(
    page.locator('#settleBtn'),
    'it acted on a mark the board does not confirm',
  ).toBeHidden();
});

test('a wrong digit on the board withdraws the offer until it is fixed', async ({ page }) => {
  await startGame(page);
  await nearTheEnd(page, { leave: 12, noted: 5 });
  await expect(page.locator('#settleBtn')).toBeVisible();

  const victim = await page.evaluate(() => {
    const i = values.findIndex((v, k) => v === 0 && !fixed[k] && notes[k].size === 0);
    values[i] = (solution[i] % 9) + 1;
    render();
    return i;
  });

  await expect(page.locator('#settleBtn')).toBeHidden();
  await expect(page.locator('#board .cell.wrong'), 'the mistake is not shown').toHaveCount(1);

  await page.evaluate((i) => {
    values[i] = 0;
    render();
  }, victim);
  await expect(page.locator('#settleBtn')).toBeVisible();
});

const asideOf = (page, id) => page.locator(`#${id}`).click({ position: { x: 8, y: 8 } });

test('tapping beside a dialog closes it, one step at a time', async ({ page }) => {
  await startGame(page);
  await page.locator('#newBtn').click();
  await expect(page.locator('#startOverlay')).toBeVisible();
  await page.locator('#recordBtn').click();
  await expect(page.locator('#recordOverlay')).toBeVisible();

  await asideOf(page, 'recordOverlay');
  await expect(page.locator('#recordOverlay')).toBeHidden();
  await expect(page.locator('#startOverlay')).toBeVisible();

  await asideOf(page, 'startOverlay');
  await expect(page.locator('#startOverlay')).toBeHidden();
  await expect(page.locator('#board .cell').first()).toBeVisible();
});

test('the picker with nothing behind it cannot be tapped away', async ({ page }) => {
  await expect(page.locator('#startOverlay')).toBeVisible();
  await expect(page.locator('#cancelNew')).toBeHidden();

  await asideOf(page, 'startOverlay');
  await expect(page.locator('#startOverlay'), 'the player was left with no game').toBeVisible();
});

test('the win dialog cannot be tapped away', async ({ page }) => {
  await startGame(page);
  await page.evaluate(() => {
    for (let i = 0; i < 81; i++) {
      if (values[i] !== solution[i]) {
        sel = i;
        inputDigit(solution[i]);
      }
    }
  });
  await expect(page.locator('#winOverlay')).toBeVisible();

  await asideOf(page, 'winOverlay');
  await expect(page.locator('#winOverlay')).toBeVisible();
});

/* A click is dispatched to the nearest ancestor of where the press began and
   where it ended, so a drag that starts on the dialog and lifts off beside it
   arrives at the backdrop looking exactly like a tap there, and selecting a line
   of the record used to be enough to close it. */
test('a press that starts inside a dialog does not close it where it lifts', async ({ page }) => {
  await startGame(page);
  await page.locator('#newBtn').click();
  await page.locator('#recordBtn').click();
  await expect(page.locator('#recordOverlay')).toBeVisible();

  const modal = await page.locator('#recordOverlay .modal').boundingBox();
  await page.mouse.move(modal.x + modal.width / 2, modal.y + 24);
  await page.mouse.down();
  await page.mouse.move(8, 8, { steps: 6 });
  await page.mouse.up();

  await expect(page.locator('#recordOverlay'), 'a drag out of the dialog closed it').toBeVisible();
});
