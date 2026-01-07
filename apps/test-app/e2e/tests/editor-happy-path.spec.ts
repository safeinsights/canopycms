import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { readContentFile, resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'

const BASE_URL = 'http://localhost:5174'

/**
 * Happy path E2E tests for the CanopyCMS editor.
 * Tests the core workflow: load → select entry → edit → save → verify.
 */
test.describe('Editor Happy Path', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    // Mark window as E2E test environment for environment-aware notifications
    await page.addInitScript(() => {
      ;(window as any).__E2E_TEST__ = true
    })

    // Reset workspace and ensure main branch exists before each test for isolation
    await resetWorkspace()
    await ensureMainBranch(BASE_URL)
    editorPage = new EditorPage(page)
  })

  test('editor loads with form and preview panes', async () => {
    // First test may need extra time for workspace initialization
    test.setTimeout(60000)

    await editorPage.goto()
    await editorPage.waitForReady()

    await expect(editorPage.formPane).toBeVisible()
    await expect(editorPage.previewPane).toBeVisible()
  })

  test('can open entry navigator', async ({ page }) => {
    await editorPage.goto()
    await editorPage.waitForReady()

    await editorPage.openEntryNavigator()
    await expect(editorPage.entryNavigator).toBeVisible()

    // Should show Home Page entry in the tree (label comes from content title)
    await expect(editorPage.entryNavigator.locator('text="Home Page"')).toBeVisible()

    // Check the data-testid matches the label
    const homeItem = page.locator('[data-testid="entry-nav-item-home-page"]')
    await expect(homeItem).toBeVisible()
  })

  test('complete edit workflow: load → select → edit → save → verify', async () => {
    // Step 1: Navigate to editor
    await editorPage.goto()
    await editorPage.waitForReady()

    // Step 2: Open entry navigator and select Home Page entry
    await editorPage.openEntryNavigator()
    await editorPage.selectEntry('Home Page')

    // Step 3: Wait for form to load and verify title field exists
    const titleInput = editorPage.getFieldInput('title')
    await expect(titleInput).toBeVisible()

    // Step 4: Edit the title field with a unique value
    const testValue = `E2E-Test-${Date.now()}`
    await editorPage.fillTextField('title', testValue)

    // Step 5: Save and verify notification
    await editorPage.saveAndVerify()

    // Step 6: Verify disk write - read the content file directly
    const content = await readContentFile<{ title: string }>('home.json')
    expect(content.title).toBe(testValue)
  })

  test('edited value persists after page reload', async ({ page }) => {
    // First, make an edit
    await editorPage.goto()
    await editorPage.waitForReady()
    await editorPage.openEntryNavigator()
    await editorPage.selectEntry('Home Page')

    const testValue = `Reload-Test-${Date.now()}`
    await editorPage.fillTextField('title', testValue)
    await editorPage.saveAndVerify()

    // Reload the page
    await page.reload()
    await editorPage.waitForReady()

    // After reload, the current entry should still be loaded
    // No need to re-select, just verify the field value
    const titleInput = editorPage.getFieldInput('title')
    await expect(titleInput).toHaveValue(testValue)
  })
})
