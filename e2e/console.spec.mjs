/* A clean console on load, checked in a real browser.

   Nothing outside a browser can answer this. The page ships to Chrome, and an
   exception thrown by a platform feature a simulator would stub out can only
   surface in the runtime that implements it.

   Scoped deliberately to console errors and uncaught exceptions. Warnings and
   failed requests are not asserted on: the browser warns about things this
   repository does not control, and treating every warning as a failure makes
   the check something people learn to ignore. */

import { expect, test } from '@playwright/test';

test('the console is clean on load', async ({ page }) => {
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));

  await page.goto('./');

  /* The page has to be up before the console means anything: a dead page has a
     quiet console too. This is the same boot e2e/boot.spec.mjs asserts on,
     which is what caught render() throwing on the first cell and leaving the
     grid dead with no difficulty picker. */
  await expect(page.locator('#board .cell')).toHaveCount(81);
  await expect(page.locator('#startOverlay')).toBeVisible();

  /* Give anything the page kicked off during load a chance to fail before the
     assertion reads the list. */
  await page.waitForLoadState('networkidle');

  expect(problems).toEqual([]);
});
