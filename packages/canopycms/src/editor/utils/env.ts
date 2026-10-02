/** True when running in a test environment (Playwright, Cypress, or an E2E flag sets these globals). */
function isTestEnvironment(): boolean {
  if (typeof window === 'undefined') return false

  return (
    'playwright' in window ||
    'Cypress' in window ||
    (window as unknown as Record<string, unknown>).__E2E_TEST__ === true ||
    navigator.webdriver === true
  )
}

/**
 * Notification duration, longer in tests for reliability.
 *
 * @param defaultMs - Default in milliseconds for production (default: 4000)
 * @returns 15000ms in tests, defaultMs otherwise
 */
export function getNotificationDuration(defaultMs = 4000): number {
  return isTestEnvironment() ? 15000 : defaultMs
}
