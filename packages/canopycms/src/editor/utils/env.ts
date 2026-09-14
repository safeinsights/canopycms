/**
 * Detect if we're running in a test environment.
 * Playwright and other E2E frameworks often set specific globals.
 */
export function isTestEnvironment(): boolean {
  if (typeof window === 'undefined') return false

  return (
    'playwright' in window ||
    'Cypress' in window ||
    (window as unknown as Record<string, unknown>).__E2E_TEST__ === true ||
    navigator.webdriver === true
  )
}

/**
 * Get notification duration based on environment.
 * Tests get longer durations to be more reliable.
 *
 * @param defaultMs - Default duration in milliseconds for production (default: 4000)
 * @returns Duration in milliseconds (15000ms for tests, defaultMs for production)
 */
export function getNotificationDuration(defaultMs = 4000): number {
  return isTestEnvironment() ? 15000 : defaultMs
}
