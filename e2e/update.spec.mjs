/* Picking up a new deploy, which is the part of an installed app that has no
   user visible symptom until it has one.

   A service worker is only checked for updates on an in-scope navigation, or on
   a functional event at most once a day. A home screen web app is a single page
   that never navigates: the player switches away and back, and the worker
   answers every request from its cache. Nothing in that loop ever asks the
   network whether a newer build exists, so the app can stay on the version it
   was installed with for as long as it is never closed.

   The three things that have to hold, and each fails in a different direction:

   1. Coming back to the app asks. Without this there is no trigger at all.
   2. A first install does not reload. clients.claim() fires controllerchange on
      the very first load, so an unguarded reload here would restart the page
      under every new visitor, once, for no reason they could see.
   3. A real swap does reload, or the document keeps markup that no longer
      matches the cache serving it.

   What is simulated, and stated plainly rather than implied: neither engine
   this file runs on gives a test a way to background a page, or to install a
   second worker without changing the bytes on the server mid run. So
   visibilitychange and controllerchange are dispatched by hand. That exercises
   this page's handlers and its guards, which is where the logic being tested
   lives; it does not prove either browser fires those events when a phone is
   unlocked. Nothing here is gated to one project, deliberately: these are the
   specs whose subject is an installed app, and every installed copy on iOS runs
   on WebKit. */

import { expect, test } from '@playwright/test';

/* Counts update checks at the registration object rather than on the wire.
   Service worker script fetches are not attributed to the page, and the browser
   may answer a check from its own cache within the day, so the network is not
   where this is observable. The call is what this page decides to make, and
   what was added, so it is what gets counted. */
const countUpdateChecks = (page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    window.__updates = 0;
    const real = registration.update.bind(registration);
    registration.update = () => {
      window.__updates++;
      return real();
    };
  });

const updateChecks = (page) => page.evaluate(() => window.__updates);
const resume = (page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

/* Resolves once this document is under a worker, which is when clients.claim()
   has run and controllerchange has already fired. */
const controlled = (page) =>
  page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });

/* A value that a reload destroys. Nothing in the page writes it, so its absence
   afterwards means the document was replaced, not merely repainted. */
const mark = (page) => page.evaluate(() => (window.__survived = 'yes'));
const survived = (page) => page.evaluate(() => window.__survived ?? null);

/* Attached before the first navigation, as every other spec here does. Nothing
   below reads the console otherwise, so a page that threw on its way through
   the update path would still count the checks it was asked for and pass. */
function watch(page) {
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
  return problems;
}

test('a first install does not reload the page under the player', async ({ page }) => {
  const problems = watch(page);
  await page.goto('./');
  await expect(page.locator('#board .cell')).toHaveCount(81);

  await mark(page);
  /* The worker installs, activates and claims this page. That claim is a real
     controllerchange, not a simulated one, and it is the case the guard exists
     for: the page it hands control to is already the newest there is. */
  await controlled(page);

  /* Waited for, not assumed absent. Reading the marker straight after the claim
     races the navigation this is looking for, and wins often enough on Chromium
     that removing the guard left this test green there while WebKit caught it. */
  const reloaded = await page
    .waitForEvent('load', { timeout: 1500 })
    .then(() => true)
    .catch(() => false);
  expect(reloaded, 'a brand new visitor had the page reloaded out from under them').toBe(false);
  expect(await survived(page), 'the page was replaced without firing a load').toBe('yes');
  expect(problems).toEqual([]);
});

test('coming back to the app asks whether a newer worker exists', async ({ page }) => {
  const problems = watch(page);
  await page.goto('./');
  await expect(page.locator('#board .cell')).toHaveCount(81);
  await controlled(page);
  await countUpdateChecks(page);

  /* Dispatched by hand: a test cannot background a real page. document.hidden
     stays false, which is what the handler requires anyway. */
  await resume(page);
  expect(await updateChecks(page), 'resuming the app checked nothing').toBe(1);

  /* And it does not ask again on every switch: an hour has not passed. */
  for (let i = 0; i < 3; i++) await resume(page);
  expect(await updateChecks(page), 'every app switch fires a check').toBe(1);
  expect(problems).toEqual([]);
});

/* The case the throttle exists to survive, and the one it used to get wrong in
   opposite directions on the two engines. Offline, registration.update() is not
   the same call twice over: measured on the built page, WebKit rejects and
   Chromium resolves without having reached the network. So an implementation
   that reacted to the rejection did nothing at all on Chromium, and on WebKit
   handed the whole throttle back on every resume. Refusing before the call is
   spent is the only version that behaves the same on both. */
test('a resume with no connectivity spends nothing, and the next one still asks', async ({
  page,
  context,
}) => {
  const problems = watch(page);
  await page.goto('./');
  await expect(page.locator('#board .cell')).toHaveCount(81);
  await controlled(page);
  await countUpdateChecks(page);

  await context.setOffline(true);
  /* Asserted rather than assumed: if the emulation ever stopped reaching
     navigator.onLine this test would otherwise pass for the wrong reason. */
  expect(await page.evaluate(() => navigator.onLine), 'the page still believes it is online').toBe(
    false,
  );
  await resume(page);
  expect(await updateChecks(page), 'an offline resume tried to check anyway').toBe(0);

  await context.setOffline(false);
  await resume(page);
  expect(
    await updateChecks(page),
    'the offline resume spent the hour, so coming back online checked nothing',
  ).toBe(1);
  expect(problems).toEqual([]);
});

/* An sw.js that 404s, times out or fails to parse rejects every time. Handing
   the throttle back on each failure turns every installed copy into a fetch per
   app switch, indefinitely, which is worst exactly when the network is worst. */
test('a failing check backs off instead of firing on every switch', async ({ page }) => {
  const problems = watch(page);
  await page.goto('./');
  await expect(page.locator('#board .cell')).toHaveCount(81);
  await controlled(page);

  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    window.__updates = 0;
    registration.update = () => {
      window.__updates++;
      return Promise.reject(new Error('sw.js is unreachable'));
    };
  });

  await resume(page);
  expect(await updateChecks(page), 'the first resume checked nothing').toBe(1);

  /* Well inside the retry gap, so every one of these must be refused. */
  for (let i = 0; i < 5; i++) await resume(page);
  expect(
    await updateChecks(page),
    'a failed check handed the throttle back, so every switch now fetches sw.js',
  ).toBe(1);
  expect(problems).toEqual([]);
});

/* Installed apps are exempt from idle eviction but not from eviction under
   storage pressure, and both the saved game and the prize totals live in
   localStorage. Asking to keep them is one call, but in a browser tab it is a
   permission prompt in some engines, which is a lot to spend on a visitor who
   has not chosen to keep anything. So it is asked only once installed. */
test('storage is only asked to persist once the app is installed', async ({ page }) => {
  const problems = watch(page);
  await page.addInitScript(() => {
    window.__persists = 0;
    if (!navigator.storage) navigator.storage = {};
    navigator.storage.persist = () => {
      window.__persists++;
      return Promise.resolve(true);
    };
  });

  await page.goto('./');
  await expect(page.locator('#board .cell')).toHaveCount(81);
  expect(
    await page.evaluate(() => window.__persists),
    'a browser tab was asked for persistent storage, which prompts the visitor in some engines',
  ).toBe(0);

  /* The same page, answering the one question it asks before deciding. A test
     cannot launch anything from a home screen, and CDP's display-mode
     emulation does not reach matchMedia, so the query is answered the way an
     installed copy would answer it. What is under test is that the decision
     follows the answer, not that Chrome reports display-mode correctly. */
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (query) =>
      query.includes('display-mode')
        ? { matches: true, addEventListener() {}, removeEventListener() {} }
        : real(query);
  });
  await page.reload();
  await expect(page.locator('#board .cell')).toHaveCount(81);
  expect(
    await page.evaluate(() => window.__persists),
    'the installed app never asked to keep the save it depends on',
  ).toBe(1);
  expect(problems).toEqual([]);
});

test('a worker that takes over an already controlled page reloads it', async ({ page }) => {
  const problems = watch(page);
  await page.goto('./');
  await controlled(page);

  /* Second load: this document starts out controlled, which is what separates a
     swap from a first install. */
  await page.reload();
  await expect(page.locator('#board .cell')).toHaveCount(81);
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller !== null),
    'the second load was not controlled, so this proves nothing',
  ).toBe(true);

  await mark(page);
  /* Stands in for a newer worker activating. Installing a real one would mean
     changing the served bytes while other workers run against the same build.
     The load is awaited from a promise created before the dispatch, because the
     reload destroys the execution context the assertion would otherwise run in. */
  const reloaded = page.waitForEvent('load');
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));
  await reloaded;

  expect(await survived(page), 'the swap did not reload the page').toBe(null);
  await expect(page.locator('#board .cell')).toHaveCount(81);
  expect(problems).toEqual([]);
});
