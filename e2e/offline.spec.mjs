import { expect, test } from '@playwright/test';

const controlled = (page) =>
  page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });

async function installedThenOffline(page, context) {
  await page.goto('./');
  await expect(page.locator('#board .cell')).toHaveCount(81);
  await controlled(page);
  await context.setOffline(true);
}

test('offline, the installed app still opens', async ({ page, context }) => {
  await installedThenOffline(page, context);

  await page.reload();
  await expect(page.locator('#board .cell')).toHaveCount(81);
});

test('offline, a path that does not exist shows the game 404 page', async ({ page, context }) => {
  await installedThenOffline(page, context);

  const response = await page.goto('./no-existe');
  expect(response?.status(), 'the offline fallback should answer as a 404').toBe(404);
  await expect(page.locator('h1')).toHaveText('404');
  await expect(page.getByRole('link', { name: 'Volver al sudoku' })).toBeVisible();

  await page.getByRole('link', { name: 'Volver al sudoku' }).click();
  await expect(page.locator('#board .cell')).toHaveCount(81);
});
