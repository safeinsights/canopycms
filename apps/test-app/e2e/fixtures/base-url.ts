/**
 * The port and base URL of the app under test — the ONE place they are
 * defined for spec code. `playwright.config.ts` computes the same values
 * from the same variable, so the launched server, Playwright's `baseURL`,
 * and every fixture's direct `fetch()` always agree.
 *
 * Override with `CANOPY_E2E_PORT` to run concurrent e2e sessions from
 * different checkouts of this repo on one machine. With a fixed port plus
 * `reuseExistingServer: true`, a second session's Playwright silently
 * attaches to whichever session's server bound the port first — a server
 * rooted in a DIFFERENT checkout's workspace — so every seeded-filesystem
 * assertion reads the wrong `.canopy-dev` and fails with baffling symptoms
 * (observed live 2026-07-31: a freshly seeded task queue reading
 * "pending 0"). CI is unaffected: the variable is unset there and each
 * shard runs on an isolated runner.
 */
export const E2E_PORT = Number(process.env.CANOPY_E2E_PORT ?? 5174)
export const BASE_URL = `http://localhost:${E2E_PORT}`
