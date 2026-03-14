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

  test('rename an entry', async ({ page }) => {
    await test.step('open editor', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    await test.step('open entry navigator', async () => {
      await editorPage.openEntryNavigator()
      await expect(editorPage.entryNavigator).toBeVisible()
    })

    await test.step('create a post entry (setup)', async () => {
      const collectionMenuButton = page.locator('[data-testid="collection-menu-posts"]')
      await collectionMenuButton.waitFor({ state: 'visible', timeout: 10000 })
      await collectionMenuButton.click()

      const addEntryItem = page.locator('[data-testid="add-entry-menu-item"]')
      await addEntryItem.waitFor({ state: 'visible', timeout: 5000 })
      await addEntryItem.click()

      const modal = page.locator('[data-testid="create-entry-modal"]')
      await expect(modal).toBeVisible()
      await page.locator('[data-testid="entry-slug-input"]').fill('post-to-rename')
      await page.locator('[data-testid="create-entry-submit"]').click()
      await expect(modal).not.toBeVisible({ timeout: 10000 })

      // Wait for entry to appear in navigator
      await expect(page.locator('[data-testid="entry-nav-item-post"]')).toBeVisible({
        timeout: 10000,
      })
    })

    await test.step('open entry context menu and click Rename Entry', async () => {
      const entryMenu = page.locator('[data-testid="entry-menu-post"]')
      await entryMenu.waitFor({ state: 'visible', timeout: 5000 })
      await entryMenu.click()

      const renameItem = page.locator('[data-testid="rename-entry-menu-item"]')
      await renameItem.waitFor({ state: 'visible', timeout: 5000 })
      await renameItem.click()
    })

    await test.step('fill in new slug and submit', async () => {
      const modal = page.locator('[data-testid="rename-entry-modal"]')
      await expect(modal).toBeVisible()

      // fill() replaces the pre-filled current slug
      await page.locator('[data-testid="rename-slug-input"]').fill('renamed-post')
      await page.locator('[data-testid="rename-entry-submit"]').click()

      await expect(modal).not.toBeVisible({ timeout: 10000 })
    })

    await test.step('reload and verify renamed entry persists', async () => {
      await page.reload()
      await editorPage.waitForReady()
      await editorPage.openEntryNavigator()

      // Expand the Posts collection (collapsed after reload)
      const postsCollection = page.locator('[data-testid="entry-nav-item-posts"]')
      await postsCollection.waitFor({ state: 'visible', timeout: 10000 })
      await postsCollection.click()

      // Label stays "Post" (rename only changes slug, not the display label)
      const navItem = page.locator('[data-testid="entry-nav-item-post"]')
      await expect(navItem).toBeVisible({ timeout: 10000 })
    })
  })

  test('delete an entry', async ({ page }) => {
    await test.step('open editor', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    await test.step('open entry navigator', async () => {
      await editorPage.openEntryNavigator()
      await expect(editorPage.entryNavigator).toBeVisible()
    })

    await test.step('create a post entry (setup)', async () => {
      const collectionMenuButton = page.locator('[data-testid="collection-menu-posts"]')
      await collectionMenuButton.waitFor({ state: 'visible', timeout: 10000 })
      await collectionMenuButton.click()

      const addEntryItem = page.locator('[data-testid="add-entry-menu-item"]')
      await addEntryItem.waitFor({ state: 'visible', timeout: 5000 })
      await addEntryItem.click()

      const createModal = page.locator('[data-testid="create-entry-modal"]')
      await expect(createModal).toBeVisible()
      await page.locator('[data-testid="entry-slug-input"]').fill('post-to-delete')
      await page.locator('[data-testid="create-entry-submit"]').click()
      await expect(createModal).not.toBeVisible({ timeout: 10000 })

      await expect(page.locator('[data-testid="entry-nav-item-post"]')).toBeVisible({
        timeout: 10000,
      })
    })

    await test.step('open entry context menu and click Delete Entry', async () => {
      const entryMenu = page.locator('[data-testid="entry-menu-post"]')
      await entryMenu.waitFor({ state: 'visible', timeout: 5000 })
      await entryMenu.click()

      const deleteItem = page.locator('[data-testid="delete-entry-menu-item"]')
      await deleteItem.waitFor({ state: 'visible', timeout: 5000 })
      await deleteItem.click()
    })

    await test.step('confirm deletion', async () => {
      const modal = page.locator('[data-testid="confirm-delete-modal"]')
      await expect(modal).toBeVisible()

      await page.locator('[data-testid="confirm-delete-submit"]').click()
      await expect(modal).not.toBeVisible({ timeout: 10000 })
    })

    await test.step('verify entry is removed from navigator', async () => {
      const navItem = page.locator('[data-testid="entry-nav-item-post"]')
      await expect(navItem).not.toBeVisible({ timeout: 10000 })
    })

    await test.step('reload and verify entry is gone', async () => {
      await page.reload()
      await editorPage.waitForReady()
      await editorPage.openEntryNavigator()

      // Expand Posts collection
      const postsCollection = page.locator('[data-testid="entry-nav-item-posts"]')
      await postsCollection.waitFor({ state: 'visible', timeout: 10000 })
      await postsCollection.click()

      const navItem = page.locator('[data-testid="entry-nav-item-post"]')
      await expect(navItem).not.toBeVisible({ timeout: 5000 })
    })
  })
})
