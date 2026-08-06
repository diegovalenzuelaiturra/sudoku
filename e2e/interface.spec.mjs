/* The two things the enriched UI can silently lose:

   1. The icon sprite. Every button icon is a <use href="#id"> pointing into an
      inline <symbol> sprite. A renamed or dropped symbol renders nothing at all,
      with no error anywhere. The pause button is the sharp edge: it used to be a
      text glyph that setPaused() reassigned through textContent, which would now
      delete the <svg> it contains.
   2. The live regions. They must exist in the DOM from first paint (a region
      injected together with its text is not announced) and must stay quiet
      while the player is only moving the selection around.

   Ported from the node suite that booted the page in a DOM simulator, since
   deleted, where three of these questions could only be answered by proxy. A
   browser answers them directly:

   - A simulator has no layout, so "the icon is there" could only mean "an
     element with the right href is there". Chrome resolves the reference and
     paints it, so a dangling href is now a zero sized box and the test says so.
   - It has no accessibility tree either, so "the icon does not touch the
     accessible name" could only mean "the svg carries aria-hidden". Chrome
     computes the name it hands to assistive tech, and drops the hidden icon
     from the tree entirely, so both halves are now observed rather than
     inferred.
   - Nor can it report aria-live wiring. The live region properties below are
     read from the tree Chrome exposes, which is what a screen reader consults
     when deciding whether to interrupt. */

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

/* Geometry, resolution and ownership of every sprite reference on the page, in
   one round trip. `painted` is the part a simulated DOM could not answer: it is
   the box Chrome drew after resolving the href into the sprite. */
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
        /* A button inside a closed modal is display:none, so nothing under it
           has a box. Those icons are checked where the modal is open. */
        onScreen: !!ownerBox && ownerBox.width > 0 && ownerBox.height > 0,
      };
    }),
  );

async function startGame(page) {
  await page.locator('#startOverlay button.diff[data-d="medium"]').click();
  await expect(page.locator('#startOverlay')).toBeHidden();
}

const selectedCell = (page) => page.locator('#board .cell.sel').getAttribute('data-i');

/* The deleted suite ended every test with `assert.deepEqual(errors, [])`,
   reading errors off a virtual console owned by the boot helper. The browser
   equivalent is the page's own console plus its uncaught exceptions. Playwright
   runs one test at a time per worker, so a single list refilled per test is
   safe. */
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
    /* The old suite stopped at "a <symbol> with a <path> exists somewhere in
       the document". Chrome had to resolve the reference and lay the shape
       out, so a renamed symbol collapses this box to zero and shows up here. */
    if (use.onScreen) {
      expect(use.painted, `icon ${use.href} on ${use.owner} resolved to an empty box`).toBe(true);
    }
  }

  /* The swap target is only referenced from script, so nothing above covers it. */
  const play = page.locator('symbol#i-play_arrow');
  await expect(play, 'the play icon is missing from the sprite').toHaveCount(1);
  await expect(play.locator('path'), 'the play icon draws nothing').not.toHaveCount(0);
  /* Read from the bytes the server published, not from a source file the
     allowlist may never publish. */
  const source = await (await page.request.get('./')).text();
  expect(source, 'the play icon is never used').toMatch(
    /<use href="#i-play_arrow"|'#i-play_arrow'/u,
  );
});

/* The five in play controls plus the pause button. Chrome applies CSS
   text-transform when it computes a name, so "Nueva partida" reaches the tree
   uppercased: compared case insensitively for that reason, but compared whole,
   which is the assertion that matters. An icon that leaked into the name would
   add to it. */
const LABELLED = [
  ['undoBtn', 'Deshacer Z'],
  ['eraseBtn', 'Borrar ⌫'],
];

/* Icon only, and all three in the header. Pista and Nueva partida moved up
   there out of the tool row: Pista spends the flawless bonus and sat one slipped
   thumb from the control a player touches most, and the corner is the hardest
   place on a phone to reach by accident. Their whole name is the aria-label. */
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
  /* The difficulty dialog holds the rest of the page inert, so nothing outside
     it is in the accessibility tree until a game is running. */
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

  /* The mode is two radios in a group, not buttons, and they are the one pair
     here that carries no icon: at this size a glyph beside four letters is what
     pushed the row wide enough to crush the group it sits in. */
  for (const [id, name] of [
    ['penBtn', 'Lápiz'],
    ['notesBtn', 'Notas'],
  ]) {
    await expect(page.locator(`#${id}`)).toHaveAccessibleName(name, { ignoreCase: true });
    await expect(page.locator(`#${id}`)).toHaveAttribute('role', 'radio');
  }

  const nodes = await accessibleNodes(cdp);
  /* The names above come from Playwright's own role engine. This is Chrome's
     tree, which is the one a screen reader reads. */
  const names = nodes.filter((node) => node.role === 'button').map((node) => node.name.trim());
  for (const [, name] of [...LABELLED, ...ICON_ONLY]) {
    expect(names.map((entry) => entry.toLocaleLowerCase())).toContain(name.toLocaleLowerCase());
  }

  /* aria-hidden on the <svg> is only a claim in the markup. This is the effect:
     Chrome exposes no image or graphics node anywhere, so the icons are not
     merely unnamed, they are absent from what assistive tech walks. */
  const graphics = nodes.filter((node) => /image|graphic|svg/iu.test(node.role));
  expect(graphics, 'an icon reached the accessibility tree').toEqual([]);

  /* The sixth labelled button lives in the win modal, which is display:none
     until the game is won, and a hidden element has no accessible name to
     compute: measured, toHaveAccessibleName reports "" for it here. Its markup
     is checked now and its real name is read out of Chrome's tree in the win
     test, where the modal is genuinely open. */
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
  /* The old failure mode was textContent deleting the <svg>. The new one is a
     swap to an id that is not in the sprite, which leaves the element in place
     and draws nothing: only a browser can tell those two apart. */
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

  /* The resume button is the other icon that only exists while the veil is up.
     Nothing else in the suite could see it: spriteReport only asserts painted
     when the owner has a box, and #resumeBtn is display:none everywhere else,
     so it was the one icon whose painting was never checked. Its name is the
     text plus the icon, so this is also where a leaked icon would show. */
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

  /* The old suite could only check for the class name. This is what the class
     does: a one pixel box clipped to nothing, which is how the region stays off
     screen without leaving the layout, the accessibility tree or the DOM. */
  for (const region of [status, alert]) {
    const box = await region.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { width: rect.width, height: rect.height, clip: getComputedStyle(el).clipPath };
    });
    expect(box).toEqual({ width: 1, height: 1, clip: 'inset(50%)' });
  }

  /* The regions are behind the difficulty dialog, which marks the page inert,
     so Chrome only reports them once play starts. Starting a game announces the
     size of the job into the polite region and must leave the assertive one
     silent. */
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

  /* Starting a game announces the size of the job once, and nothing else. */
  await expect(status).toHaveText(/^\d+ celdas por llenar\.$/u);
  const opening = await status.textContent();

  const before = await selectedCell(page);
  for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft']) await page.keyboard.press(key);
  /* Real key events through the browser, so the silence below means the keys
     were handled and said nothing, not that they never arrived. */
  expect(await selectedCell(page), 'the arrow keys never reached the board').not.toBe(before);
  expect(await status.textContent(), 'moving the selection announced something').toBe(opening);

  /* A wrong digit is worth one announcement. Entered the way a player enters
     it: click the cell, press the key. */
  const { index, wrong } = await page.evaluate(() => {
    const i = values.findIndex((_v, k) => !fixed[k]);
    return { index: i, wrong: (solution[i] % 9) + 1 };
  });
  await page.locator('#board .cell').nth(index).click();
  await page.keyboard.press(String(wrong));
  await expect(status).toHaveText(/1 error/u);

  /* "Announced" is a claim about the region, not only about its text. Read at
     the moment the text lands, from the tree Chrome exposes: written into a
     plain span with no role and no aria-live, the same words reach nobody, and
     the textContent assertions above would still pass. The mistake also has to
     stay out of the assertive region, which is reserved for the win. */
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

  /* Assertively, which is the word in the title: the win interrupts whatever
     the polite region was saying. Read from Chrome's tree rather than from the
     markup, so a region downgraded to polite, or reduced to a plain span that
     announces nothing at all, fails here. */
  const winNodes = await accessibleNodes(cdp);
  expect(liveRegion(winNodes, 'alert'), 'the win is not announced assertively').toMatchObject({
    live: 'assertive',
    atomic: true,
  });
  expect(liveRegion(winNodes, 'alert').text).toMatch(/^Ganaste\./u);

  /* The win modal animates in about two seconds after the last digit. It is the
     only moment the sixth labelled button and the seventh sprite icon are on
     screen, so they are checked here rather than against a display:none
     subtree, where Chrome exposes nothing and nothing has a box. */
  await expect(page.locator('#winOverlay')).toBeVisible();
  const again = (await spriteReport(page)).find((use) => use.owner === 'againBtn');
  expect(again).toMatchObject({ href: '#i-refresh', tag: 'symbol', painted: true });

  const nodes = await accessibleNodes(cdp);
  const names = nodes.filter((node) => node.role === 'button').map((node) => node.name.trim());
  expect(names.map((name) => name.toLocaleLowerCase())).toContain('otra al tiro');
});

/* An ARIA role is a promise about the subtree under it. role="grid" promises
   role="row" children; the board appends 81 buttons straight into itself, which
   made the tree invalid and cost the page its perfect accessibility audit. */
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

  /* The reason the role is there at all, now observed instead of assumed: with
     a game running, Chrome exposes the board under that role and carries the
     label with it. A bare div would have dropped both.

     What a browser still cannot answer here is the audit rule itself
     (aria-required-children): Chrome reports the tree it built, not the
     violations in it, so the flat children check above stays a DOM check. */
  await startGame(page);
  const nodes = await accessibleNodes(cdp);
  expect(nodes.some((node) => node.role === role && node.name === label)).toBe(true);
});

/* "Notas" was a stylus icon and a five letter label, which says what the button
   is called and nothing about what it does or how to use it. The explanation is
   now on the button as a description, and on screen only while the mode is on,
   so the board is not permanently carrying an instruction. */
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

  /* The keys are what the thumb is aiming at while the mode is being changed.
     Revealing the description on screen pushed them down 33px at exactly that
     moment, and the column has no height to hold the line open with instead, so
     it is out of the layout in both modes. */
  const keypad = () => page.locator('#pad').boundingBox();
  const before = await keypad();

  await notes.click();
  await expect(notes).toHaveAttribute('aria-checked', 'true');
  expect(await keypad(), 'turning notes on moved the keypad').toEqual(before);
  /* Clipped to a pixel rather than removed, so it stays in the tree. */
  expect((await hint.boundingBox()).width, 'the description took layout space').toBeLessThan(5);

  /* Tapping the mode already chosen does nothing, which is what a radio group
     promises and what a toggle button could not: a tap the player was unsure
     about used to undo itself. Leaving the mode is the other radio's job. */
  await notes.click();
  await expect(notes, 'the group toggled instead of choosing').toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.locator('#penBtn').click();
  await expect(notes).toHaveAttribute('aria-checked', 'false');
  expect(await keypad(), 'turning notes off moved the keypad').toEqual(before);

  /* Everything above is layout, and runs on both engines. What follows is the
     description Chrome computes for the button, which is the half that carries
     the explanation to a screen reader, and which only Chromium exposes. */
  test.skip(
    test.info().project.name !== 'chromium',
    'reads the accessibility tree, which only Chromium exposes over CDP',
  );
  const cdp = await context.newCDPSession(page);
  /* radio, not button: the mode is a group of two now. */
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
   playing. touch-action only ever sat on the board, which left the pad, the
   tools and the chrome zooming.

   What this can check in Chromium is the declaration, not the iOS gesture. It
   is asserted on body because the permitted behaviours are the intersection of
   an element's value with its ancestors': the pad keys keep computing "auto"
   and still cannot zoom, and body losing this is the only way that breaks. */
test('a double tap cannot zoom the page, while pinch to zoom still can', async ({ page }) => {
  await startGame(page);

  const touchAction = (selector) =>
    page.locator(selector).evaluate((node) => getComputedStyle(node).touchAction);

  expect(await touchAction('body'), 'double tap can zoom the page again').toBe('manipulation');
  /* And on the board in its own right. The walk up the ancestors runs only "up
     to the one that implements the gesture (in other words, the first
     containing scrolling element)", and .board is overflow:hidden, which makes
     it exactly that. Relying on body alone here would leave the 81 cells, the
     surface the double tap bug was reported on, depending on a reading of the
     spec rather than on a declaration. */
  expect(
    await touchAction('#board'),
    'the board is back to inheriting a gesture the scroll container can truncate',
  ).toBe('manipulation');
  /* Not "none": that would take pinch to zoom away from anyone who needs it. */
  for (const selector of ['body', '#board', '#pad', '.tools']) {
    expect(await touchAction(selector), `${selector} forbids pinch to zoom`).not.toBe('none');
  }
});

/* The three complaints a player sent in, measured rather than argued about.
   Keys were 36.7px wide against the 44px that Apple's guidelines and WCAG 2.5.5
   both set, laid out nine across with 5px between them, and hit testing every
   pixel of that strip found 9.2 percent of it answering to nothing: a tap that
   landed in a gutter did nothing at all, which is what "sometimes it does not
   take my touch" was. Three across is what buys the width back. */
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

  /* Three columns, so the row a finger crosses holds three keys and not nine. */
  const keys = await page.locator('.key').all();
  const tops = new Set();
  for (const key of keys) tops.add(Math.round((await key.boundingBox()).y));
  expect(tops.size, 'the keypad is not three rows').toBe(3);

  /* And nothing overflows the column sideways, which the header did the moment
     it took two more buttons. */
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow, 'something is wider than the page').toBe(false);
});

/* The other half of "I have to tap several times". Entering the digit that is
   already in the cell used to clear it, so a player who could not tell whether
   the first tap landed tapped again and lost it, which reads as the screen
   having missed both. */
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

  /* Erasing still has a button, and it is now the only thing that erases. */
  await page.locator('#eraseBtn').click();
  await expect(cell.locator('.v')).toHaveText('');
});

/* The mode is said again on the keypad, because the control is a row below the
   eye line of somebody looking at the board. The class doing it is "noting" and
   not "notes": .notes is already the grid of pencil marks inside a cell, and it
   is position:absolute, so the shared name took the keypad out of flow and drew
   it 800px tall across the board. */
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
  /* Past the 120ms the keys take to change colour, or this reads the old one. */
  await page.waitForTimeout(250);
  const on = await shape();

  expect(on.position, 'notes mode took the keypad out of flow').toBe('static');
  expect(on.height, 'notes mode changed the size of the keypad').toBe(off.height);
  /* Colour is the whole of the difference. Notes mode used to redraw the digits
     smaller as well, 22px against 17 on a phone, so the thing the eye was aiming
     at changed shape at the moment the mode changed. */
  expect(on.digitSize, 'the digits are a different size in notes mode').toBe(off.digitSize);
  expect(on.keyHeight, 'the keys are a different height in notes mode').toBe(off.keyHeight);
  expect(on.keyBg, 'the keypad says nothing about the mode it is in').not.toBe(off.keyBg);
  await expect(page.locator('#pad')).toHaveClass(/noting/u);
});

/* At the full width of the column the leftmost digits sit at the far end of a
   right thumb's arc and the rightmost at the far end of a left one. The board
   keeps the whole width, because what it needs is size; the controls are pulled
   in and centred, because what they need is to be within reach of either hand.
   Capped at the board's own floor, so they can never come out wider than the
   grid they stand under, which on the smallest phone they would. */
test('the controls are narrower than the board and centred under it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await startGame(page);

  /* Resized rather than reloaded between the two: a second visit restores the
     board this one started and never offers the difficulty dialog again, and the
     layout answers to the viewport either way. */
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
    /* Centred, to within the rounding of an odd number of pixels. */
    const leftGap = laid.controls.left - laid.board.left;
    const rightGap = laid.board.right - laid.controls.right;
    expect(
      Math.abs(leftGap - rightGap),
      `the controls are not centred at ${where}`,
    ).toBeLessThanOrEqual(1);
    /* And none of the reach was bought with target size. */
    expect(laid.key.w, `a key is under 44px wide at ${where}`).toBeGreaterThanOrEqual(44);
    expect(laid.key.h, `a key is under 44px tall at ${where}`).toBeGreaterThanOrEqual(44);
  }
});

/* Pista spends the flawless bonus and used to sit in the tool row beside the
   notes toggle. It moved to the far corner of the header, which put it outside
   the container pause makes inert, so both halves of that are checked here. */
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
  /* Nueva partida is the one header action a pause keeps, so that a game can be
     abandoned without being resumed first. */
  await expect(page.locator('#newBtn')).toHaveJSProperty('inert', false);
  await page.locator('#resumeBtn').click();
  await expect(page.locator('#hintBtn')).toHaveJSProperty('inert', false);
});

/* The wide button that closes a dialog or resumes a board. Its rule was deleted
   with the tool row it sat beside in the stylesheet, and nothing said so: three
   buttons went on working and quietly rendered as bare browser defaults for
   several releases. Size is what tells them apart from an unstyled button, so
   size is what is asserted. */
/* The win dialog is put up by a timer about two seconds after the last digit,
   and the board is finished by then, so nothing has made the page inert: the
   Nueva partida button is live for the whole of that window. Opening the picker
   inside it left the win dialog to arrive on top and take the focus. */
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

  /* Inside the window, before any of the win timers have run. */
  await page.locator('#newBtn').click();
  await expect(page.locator('#startOverlay')).toBeVisible();
  /* Past the last of them, which is the dialog itself at about 1.9 seconds. */
  await page.waitForTimeout(2600);

  await expect(page.locator('#winOverlay'), 'the win dialog opened over the picker').toBeHidden();
  await expect(page.locator('#startOverlay')).toBeVisible();
  /* And the picker offers nothing to go back to, because there is no board to
     go back to: the game that was on the screen is over. */
  await expect(page.locator('#cancelNew')).toBeHidden();
});

/* Reported by a player: after finishing a game, Seguir jugando took them back to
   the finished game. The attribute was being set, so every check of the property
   said the button was gone, but .modal .quiet:has(.ico) sets a display and the
   browser's own [hidden] rule is display:none at zero specificity, so it stayed
   on screen. Pressing it only hides the dialog, and what is behind the dialog is
   the board that was just won. */
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
  /* Rendered, not merely marked: the attribute was always right. */
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

  /* An unstyled button of this text is about 22px tall, and these carry 22px of
     padding of their own, so 32 separates the two without pinning a number the
     stylesheet is free to move. */
  await startGame(page);
  await page.locator('#pauseBtn').click();
  const resume = await spans('resumeBtn', '#veil');
  expect(resume.button.height, 'Seguir is not a button, it is browser default').toBeGreaterThan(32);
  await page.locator('#resumeBtn').click();

  await page.locator('#newBtn').click();
  await page.locator('#recordBtn').click();
  const close = await spans('closeRecord', '#recordOverlay .modal');
  expect(close.button.height, 'Listo lost the shape that makes it a button').toBeGreaterThan(32);
  /* The one that only a width rule can give it: a default button is as wide as
     its word. */
  expect(close.ratio, 'Listo no longer spans the dialog').toBeGreaterThan(0.8);
});

/* The one event where the answer reaches the finger before the eye: the error is
   drawn in the cell and counted in a bar nobody is looking at while their thumb
   is on the keypad. Nothing else buzzes, because a buzz on every digit is fifty
   of them a board.

   Stubbed, because no engine Playwright drives has a vibration motor and because
   what is worth holding down is when the game asks and when it does not. iPhones
   have no Vibration API at all, Chrome there included, so the absent case is the
   ordinary one and gets a test of its own below. */
const stubVibrate = (page) =>
  page.addInitScript(() => {
    window.buzzLog = [];
    navigator.vibrate = (pattern) => {
      window.buzzLog.push(pattern);
      return true;
    };
  });

const buzzes = (page) => page.evaluate(() => window.buzzLog.length);

/* Back to the start dialog and into the record, which is the only way in. */
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

  /* The switch is out of sight for now, so nothing in the record offers it. */
  await openRecord(page);
  await expect(page.locator('#buzzRow')).toBeHidden();
});

/* The row is down but the preference behind it is still read, so a stored no is
   still a no. This is what makes putting the row back on screen the only thing
   that would take. */
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

/* Every iPhone, which is where the request came from. WebKit has never shipped
   the Vibration API and Chrome on iOS is WebKit, so this is the common case. */
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

/* The pencil marks are painted into spans the label does not gather, so a cell
   carrying the player's own candidates announced itself as empty and nothing
   else. Lighthouse names it label-content-name-mismatch, at a weight of zero:
   the score never moved, and the only reader it mattered to was the one with
   nothing but the label to go on. */
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

  /* A cell holding an answer says the answer. Marks are cleared when a digit
     lands, and a label that read them anyway would be quoting a stale set. */
  await page.evaluate((i) => {
    values[i] = solution[i];
    render();
  }, target);
  expect(await label(target), 'a filled cell still reads out marks').not.toMatch(/nota/u);
});

/* Confirming what the notes already say. Placing a correct digit already deletes
   it from every peer's pencil marks, so the late game keeps leaving cells with
   one mark left. That mark is the answer, and typing it again is bookkeeping.

   Fills the board correctly except for the last `leave` cells and writes the
   true candidate set into the first `noted` of them, which is what a player who
   keeps complete marks would be looking at. */
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
      /* Complete marks are the true candidate set, so a marked cell is only
         down to one when the board is too. Which of them that is depends on the
         board this seed dealt, so it is reported rather than assumed. */
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
  /* It puts nothing on the board that was not already on screen in the player's
     own hand, so there is nothing for either counter to record. */
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

/* The rule that makes it provable rather than trusted. A mark saying less than
   the board says is either a cleverer deduction or a mistake, and nothing here
   can tell those apart without reading the solution, which would be a hint. */
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

/* One wrong digit poisons the candidate arithmetic, so a cell can be left with a
   single option that is not the answer. Wrong digits are painted from the moment
   they land, so standing down tells the player nothing they cannot already see. */
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

/* Tapping beside a dialog to leave it is what Escape has always done here with a
   keyboard, and a phone has no Escape. The rule is that the two agree, which is
   what settles the two cases below: a dialog nobody can Escape out of is a
   dialog nobody can tap out of either. */
const asideOf = (page, id) => page.locator(`#${id}`).click({ position: { x: 8, y: 8 } });

test('tapping beside a dialog closes it, one step at a time', async ({ page }) => {
  await startGame(page);
  await page.locator('#newBtn').click();
  await expect(page.locator('#startOverlay')).toBeVisible();
  await page.locator('#recordBtn').click();
  await expect(page.locator('#recordOverlay')).toBeVisible();

  await asideOf(page, 'recordOverlay');
  /* One step, to the picker that put it up. Going straight to the board would
     skip a dialog the player never asked to leave. */
  await expect(page.locator('#recordOverlay')).toBeHidden();
  await expect(page.locator('#startOverlay')).toBeVisible();

  await asideOf(page, 'startOverlay');
  await expect(page.locator('#startOverlay')).toBeHidden();
  await expect(page.locator('#board .cell').first()).toBeVisible();
});

test('the picker with nothing behind it cannot be tapped away', async ({ page }) => {
  await expect(page.locator('#startOverlay')).toBeVisible();
  /* The same condition Escape reads: no way back is offered because there is no
     game to go back to. */
  await expect(page.locator('#cancelNew')).toBeHidden();

  await asideOf(page, 'startOverlay');
  await expect(page.locator('#startOverlay'), 'the player was left with no game').toBeVisible();
});

/* Behind this one is a board that has been finished, and handing a finished game
   back is a bug this repository has already shipped once. */
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

/* Both ends of the press have to land outside. A click is dispatched to the
   nearest ancestor of where the press began and where it ended, so a drag that
   starts on the dialog and lifts off beside it arrives at the backdrop looking
   exactly like a tap there, and selecting a line of the record used to be enough
   to close it. */
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
