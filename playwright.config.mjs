import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PLAYWRIGHT_PORT || 4173);
/* The site is published as a project site at /sudoku/, so the local server
   mounts the build output under the same prefix. A path that starts with a
   slash then fails here the way it fails in production instead of resolving to
   the account root by accident. */
const BASE_PATH = 'sudoku';
const BASE_URL = `http://127.0.0.1:${PORT}/${BASE_PATH}/`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.mjs$/u,

  outputDir: './node_modules/.cache/playwright',

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  timeout: 30_000,
  expect: { timeout: 10_000 },

  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],

  webServer: {
    command: `node scripts/build.mjs && node e2e/static-server.mjs ${PORT} ${BASE_PATH}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
