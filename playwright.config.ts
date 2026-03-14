import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for CanopyCMS E2E tests.
 * Tests UI-only features like preview bridge, draft persistence, modals, and drag-drop.
 */
export default defineConfig({
  testDir: './apps/test-app/e2e',

  // Run tests sequentially for now (shared workspace)
  fullyParallel: false,

  // Generous timeout: workspace init (git clone) + editor load can take 30s+
  timeout: 90000,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // All tests share the same workspace and server - must run sequentially
  workers: 1,

  // Reporters: html for detailed UI, json for machine-readable timing, list for per-test durations in terminal
  reporter: [['html'], ['json', { outputFile: 'test-results/results.json' }], ['list']],

  // Shared settings for all the projects below
  use: {
    // Base URL to use in actions like `await page.goto('/')`
    baseURL: 'http://localhost:5174',

    // Collect trace when retrying the failed test
    trace: 'on-first-retry',

    // Take screenshot on failure for debugging
    screenshot: 'only-on-failure',
  },

  // CI runners are slower — give expect() assertions more time
  expect: {
    timeout: process.env.CI ? 15000 : 5000,
  },

  // Configure projects for major browsers
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Run your local dev server before starting the tests
  webServer: {
    command: 'npm run dev -w canopycms-test-app',
    url: 'http://localhost:5174',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
})
