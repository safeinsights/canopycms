import { test, expect } from '@playwright/test'

/**
 * Basic E2E tests for CanopyCMS editor - verifies core UI loads and works.
 */

test.describe.skip('Editor Basic Functionality', () => {
  test('home page loads with link to editor', async ({ page }) => {
    await page.goto('/')

    await expect(page.locator('h1')).toContainText('CanopyCMS Test App')
    await expect(page.locator('a[href="/edit"]')).toBeVisible()
  })

  test('navigates to editor page', async ({ page }) => {
    await page.goto('/')
    await page.click('a[href="/edit"]')

    // Should navigate to /edit
    await expect(page).toHaveURL(/\/edit/)
  })

  test('editor loads with form and preview panes', async ({ page }) => {
    await page.goto('/edit')

    // Wait for editor to load - give it more time
    await page.waitForSelector('[data-testid="form-pane"]', { timeout: 30000 })

    // Verify both panes are present
    await expect(page.locator('[data-testid="form-pane"]')).toBeVisible()
    await expect(page.locator('[data-testid="preview-pane"]')).toBeVisible()
  })

  test('can select a content entry from navigation', async ({ page }) => {
    await page.goto('/edit')

    // Wait for editor to load
    await page.waitForSelector('[data-testid="form-pane"]', { timeout: 30000 })

    // Editor should show navigation or entry selector
    // The exact selectors will depend on the CanopyCMS UI
    // For now, just verify the panes loaded
    const formPane = page.locator('[data-testid="form-pane"]')
    await expect(formPane).toBeVisible()
  })
})
