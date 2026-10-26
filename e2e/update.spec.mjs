import { expect, test } from '@playwright/test';

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

const controlled = (page) =>
  page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });

const mark = (page) => page.evaluate(() => (window.__survived = 'yes'));
const survived = (page) => page.evaluate(() => window.__survived ?? null);

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
  await controlled(page);

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

  await resume(page);
  expect(await updateChecks(page), 'resuming the app checked nothing').toBe(1);

  for (let i = 0; i < 3; i++) await resume(page);
  expect(await updateChecks(page), 'every app switch fires a check').toBe(1);
  expect(problems).toEqual([]);
});

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

  for (let i = 0; i < 5; i++) await resume(page);
  expect(
    await updateChecks(page),
    'a failed check handed the throttle back, so every switch now fetches sw.js',
  ).toBe(1);
  expect(problems).toEqual([]);
});

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

  await page.reload();
  await expect(page.locator('#board .cell')).toHaveCount(81);
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller !== null),
    'the second load was not controlled, so this proves nothing',
  ).toBe(true);

  await mark(page);
  const reloaded = page.waitForEvent('load');
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));
  await reloaded;

  expect(await survived(page), 'the swap did not reload the page').toBe(null);
  await expect(page.locator('#board .cell')).toHaveCount(81);
  expect(problems).toEqual([]);
});
