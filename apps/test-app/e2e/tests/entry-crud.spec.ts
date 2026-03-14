import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'

const BASE_URL = 'http://localhost:5174'

/**
 * E2E tests for entry CRUD operations.
 */
test.describe('Entry CRUD Operations', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      ;(window as any).__E2E_TEST__ = true
    })
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('create a new entry', async ({ page }) => {
    const testSlug = `test-post-${Date.now()}`

    await test.step('open editor', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    await test.step('open entry navigator', async () => {
      await editorPage.openEntryNavigator()
      await expect(editorPage.entryNavigator).toBeVisible()
    })

    await test.step('open Posts collection menu and click Add Entry', async () => {
      const collectionMenuButton = page.locator('[data-testid="collection-menu-posts"]')
      await collectionMenuButton.waitFor({ state: 'visible', timeout: 10000 })
      await collectionMenuButton.click()

      const addEntryItem = page.locator('[data-testid="add-entry-menu-item"]')
      await addEntryItem.waitFor({ state: 'visible', timeout: 5000 })
      await addEntryItem.click()
    })

    await test.step('fill in slug and submit', async () => {
      const modal = page.locator('[data-testid="create-entry-modal"]')
      await expect(modal).toBeVisible()

      const slugInput = page.locator('[data-testid="entry-slug-input"]')
      await slugInput.fill(testSlug)

      const createButton = page.locator('[data-testid="create-entry-submit"]')
      await createButton.click()

      // Wait for modal to close
      await expect(modal).not.toBeVisible({ timeout: 10000 })
    })

    await test.step('verify new entry appears in navigator', async () => {
      // The entry label comes from the entry type label ("Post"), not the slug.
      // The Posts collection should be auto-expanded after creation.
      const navItem = page.locator('[data-testid="entry-nav-item-post"]')
      await expect(navItem).toBeVisible({ timeout: 10000 })
    })

    await test.step('reload and verify persistence', async () => {
      await page.reload()
      await editorPage.waitForReady()
      await editorPage.openEntryNavigator()

      // Expand the Posts collection (collapsed after reload)
      const postsCollection = page.locator('[data-testid="entry-nav-item-posts"]')
      await postsCollection.waitFor({ state: 'visible', timeout: 10000 })
      await postsCollection.click()

      const navItem = page.locator('[data-testid="entry-nav-item-post"]')
      await expect(navItem).toBeVisible({ timeout: 10000 })
    })
  })
})
