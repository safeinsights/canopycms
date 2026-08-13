import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for CanopyCMS E2E tests.
 * Tests UI-only features like preview bridge, draft persistence, modals, and drag-drop.
 */

// Keep in sync with apps/test-app/e2e/fixtures/base-url.ts (specs can't
// import from a config outside their dir, so the env var is the contract).
// Override CANOPY_E2E_PORT to run concurrent e2e sessions from different
// checkouts on one machine: with the fixed default plus reuseExistingServer,
// a second session silently attaches to the FIRST session's server — rooted
// in a different checkout's workspace — and every seeded-filesystem
// assertion reads the wrong .canopy-dev.
const E2E_PORT = Number(process.env.CANOPY_E2E_PORT ?? 5174)

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

  // Reporters. CI uses blob so the 3-way sharded jobs (see ci.yml) can be
  // merged into one HTML report by the e2e-report job; list keeps per-test
  // lines in the job log. Locally: html for detailed UI, json for
  // machine-readable timing, list for per-test durations in terminal.
  reporter: process.env.CI
    ? [['blob'], ['list']]
    : [['html'], ['json', { outputFile: 'test-results/results.json' }], ['list']],

  // Shared settings for all the projects below
  use: {
    // Base URL to use in actions like `await page.goto('/')`
    baseURL: `http://localhost:${E2E_PORT}`,

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

  // Server under test. CI (or E2E_PROD_SERVER=1 locally) runs a production
  // build + `next start` — noticeably faster and more prod-like than the dev
  // server's on-demand compilation. Local default stays `next dev` so
  // iterating on e2e doesn't pay a full build each run (and can reuse a
  // dev server you already have running).
  // CANOPY_E2E=1 marks the server process for the test-only
  // /api/e2e-test/rebase route, which a production-mode server would
  // otherwise refuse (see apps/test-app/app/api/e2e-test/rebase/route.ts).
  // The test app's next.config.mjs imports `canopycms-next/config` (withCanopy),
  // exactly as a real adopter does — that wrapper is what registers the
  // `/assets/:path*` rewrite every public asset URL depends on. That export
  // ships from dist/, so canopycms-next must be built before the server starts
  // on BOTH branches below (~5s; it is only tsc + two esbuild calls).
  webServer: {
    // `exec next … --port` (not the package's dev/start scripts, which pin
    // --port 5174) so CANOPY_E2E_PORT reaches the server. `pnpm --filter X
    // exec` runs with the package as cwd, same as the scripts did.
    command:
      process.env.CI || process.env.E2E_PROD_SERVER
        ? `pnpm --filter canopycms-next build && pnpm --filter canopycms-test-app build && pnpm --filter canopycms-test-app exec next start --port ${E2E_PORT}`
        : `pnpm --filter canopycms-next build && pnpm --filter canopycms-test-app exec next dev --port ${E2E_PORT}`,
    url: `http://localhost:${E2E_PORT}`,
    // NOTE: when a server is already listening locally, the whole command --
    // including the canopycms-next build above -- is skipped, so a
    // long-lived dev server can be serving a stale canopycms-next dist/.
    // Restart the server after touching packages/canopycms-next/src.
    reuseExistingServer: !process.env.CI,
    // Generous: the CI path pays a full `next build` before the server binds.
    timeout: 300 * 1000,
    env: {
      CANOPY_E2E: '1',
    },
  },
})
