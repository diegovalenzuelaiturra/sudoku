import { expect, test } from '@playwright/test';

test('the console is clean on load', async ({ page }) => {
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));

  await page.goto('./');

  await expect(page.locator('#board .cell')).toHaveCount(81);
  await expect(page.locator('#startOverlay')).toBeVisible();

  await page.waitForLoadState('networkidle');

  expect(problems).toEqual([]);
});
