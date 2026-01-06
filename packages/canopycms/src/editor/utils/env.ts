/**
 * Detect if we're running in a test environment.
 * Playwright and other E2E frameworks often set specific globals.
 */
export function isTestEnvironment(): boolean {
  if (typeof window === 'undefined') return false

  // Check for common E2E testing indicators
  return (
    // Playwright sets window.playwright
    'playwright' in window ||
    // Cypress sets window.Cypress
    'Cypress' in window ||
    // Check if running in test mode via env variable (set by test runner)
    (window as any).__E2E_TEST__ === true ||
    // Some test frameworks set navigator.webdriver
    navigator.webdriver === true
  )
}

/**
 * Get notification duration based on environment.
 * Tests get longer durations to be more reliable.
 *
 * @param defaultMs - Default duration in milliseconds for production (default: 4000)
 * @returns Duration in milliseconds (15000ms for tests, defaultMs for production)
 *
 * @example
 * ```typescript
 * notifications.show({
 *   message: 'Saved',
 *   color: 'green',
 *   autoClose: getNotificationDuration(4000),  // 4s in production, 15s in tests
 * })
 * ```
 */
export function getNotificationDuration(defaultMs = 4000): number {
  return isTestEnvironment() ? 15000 : defaultMs
}
