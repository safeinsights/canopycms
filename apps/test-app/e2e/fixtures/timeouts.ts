/**
 * CI-aware timeout constants for E2E tests.
 * GitHub Actions runners are slower than local machines — scale timeouts accordingly.
 */
const CI_MULTIPLIER = process.env.CI ? 3 : 1

/** Short wait — UI animations, menu appearance (local: 5s, CI: 15s) */
export const SHORT_TIMEOUT = 5000 * CI_MULTIPLIER

/** Standard wait — API responses, component rendering (local: 10s, CI: 30s) */
export const STANDARD_TIMEOUT = 10000 * CI_MULTIPLIER

/** Long wait — git operations, workspace initialization (local: 30s, CI: 90s) */
export const LONG_TIMEOUT = 30000 * CI_MULTIPLIER
