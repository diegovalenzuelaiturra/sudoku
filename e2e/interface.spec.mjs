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
  ['notesBtn', 'Notas N'],
  ['hintBtn', 'Pista H'],
  ['newBtn', 'Nueva partida'],
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

  /* Icon-only, so its whole accessible name is the aria-label. */
  await expect(page.locator('#pauseBtn')).toHaveText('');
  await expect(page.locator('#pauseBtn')).toHaveAccessibleName('Pausar');

  const nodes = await accessibleNodes(cdp);
  /* The names above come from Playwright's own role engine. This is Chrome's
     tree, which is the one a screen reader reads. */
  const names = nodes.filter((node) => node.role === 'button').map((node) => node.name.trim());
  for (const [, name] of [...LABELLED, ['pauseBtn', 'Pausar']]) {
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
test('the notes button explains itself, on screen only while notes are on', async ({
  page,
  context,
}) => {
  await startGame(page);

  const hint = page.locator('#notesHint');
  const notes = page.locator('#notesBtn');
  const text = await hint.textContent();
  expect(text, 'the hint says nothing').toMatch(/candidat/iu);

  /* Clipped to a pixel rather than removed, so it stays in the tree. */
  const clipped = async () => (await hint.boundingBox()).width;

  expect(await clipped(), 'the hint is on screen before notes are on').toBeLessThan(5);
  await notes.click();
  await expect(notes).toHaveAttribute('aria-pressed', 'true');
  expect(await clipped(), 'turning notes on did not reveal the hint').toBeGreaterThan(80);
  await notes.click();
  expect(await clipped(), 'the hint stayed on screen after notes were turned off').toBeLessThan(5);

  /* Everything above is layout, and runs on both engines. What follows is the
     description Chrome computes for the button, which is the half that carries
     the explanation to a screen reader, and which only Chromium exposes. */
  test.skip(
    test.info().project.name !== 'chromium',
    'reads the accessibility tree, which only Chromium exposes over CDP',
  );
  const cdp = await context.newCDPSession(page);
  const described = () =>
    accessibleNodes(cdp).then(
      (nodes) =>
        nodes.find((node) => node.role === 'button' && /Notas/u.test(node.name))?.description,
    );

  expect(await described(), 'the button carries no description while notes are off').toBe(text);
  await notes.click();
  expect(await described(), 'the description was lost when the hint became visible').toBe(text);
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
