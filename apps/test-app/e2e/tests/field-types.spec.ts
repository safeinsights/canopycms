import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch, readContentFile } from '../fixtures/test-workspace'
import { SHORT_TIMEOUT, STANDARD_TIMEOUT, LONG_TIMEOUT } from '../fixtures/timeouts'

const BASE_URL = 'http://localhost:5174'

/**
 * Multi-Field Content Editing E2E Tests.
 * Tests editing capabilities across different field types to validate data integrity.
 */
test.describe('Multi-Field Content Editing', () => {
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

  test('text field: basic input and persistence', async ({ page }) => {
    await editorPage.goto()
    await editorPage.waitForReady()

    // Open Home Page entry
    await editorPage.openEntryNavigator()
    await editorPage.selectEntry('Home Page')

    // Edit title field
    const testValue = `Test-Title-${Date.now()}`
    await editorPage.fillTextField('title', testValue)

    // Save and verify
    await editorPage.saveAndVerify()

    // Verify persistence by reading file
    const content = await readContentFile<{ title: string }>('home.home.bo7QdSwn9Tod.json')
    expect(content.title).toBe(testValue)

    // Reload page and verify value persists
    await page.reload()
    await editorPage.waitForReady()

    // Don't reopen navigator - the current entry should still be loaded
    // Just verify the field value
    await editorPage.verifyFieldValue('title', testValue)
  })

  test('textarea/MDX field: multi-line content', async ({ page }) => {
    await test.step('open editor', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    await test.step('create a post entry via UI', async () => {
      await editorPage.openEntryNavigator()

      const collectionMenuButton = page.locator('[data-testid="collection-menu-posts"]')
      await collectionMenuButton.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
      await collectionMenuButton.click()

      const addEntryItem = page.locator('[data-testid="add-entry-menu-item"]')
      await addEntryItem.waitFor({ state: 'visible', timeout: SHORT_TIMEOUT })
      await addEntryItem.click()

      const modal = page.locator('[data-testid="create-entry-modal"]')
      await expect(modal).toBeVisible()
      await page.locator('[data-testid="entry-slug-input"]').fill('mdx-body-test')
      await page.locator('[data-testid="create-entry-submit"]').click()
      await expect(modal).not.toBeVisible({ timeout: LONG_TIMEOUT })

      // Close the navigator drawer so the form pane is interactive
      await page.keyboard.press('Escape')
      await expect(editorPage.entryNavigator).not.toBeVisible({ timeout: SHORT_TIMEOUT })
    })

    await test.step('fill title and body fields', async () => {
      // Title is a regular text input
      await editorPage.fillTextField('title', 'Test Body Post')

      // Body is a rich text (markdown) editor — interact via ARIA role
      const bodyEditor = page.getByRole('textbox', { name: 'editable markdown' })
      await bodyEditor.waitFor({ state: 'visible', timeout: LONG_TIMEOUT })
      await bodyEditor.fill('Hello world body content')
    })

    await test.step('save', async () => {
      await editorPage.saveAndVerify()
    })

    await test.step('reload and verify body persists', async () => {
      await page.reload()
      await editorPage.waitForReady()

      // The post should still be selected after reload
      const bodyEditor = page.getByRole('textbox', { name: 'editable markdown' })
      await expect(bodyEditor).toBeVisible({ timeout: STANDARD_TIMEOUT })
      await expect(bodyEditor).toContainText('Hello world body content')
    })
  })

  test('toggle (boolean) field: on/off and persistence', async ({ page }) => {
    await test.step('open editor and select Home Page', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Home Page')
    })

    const toggle = page.locator('[data-testid="field-toggle-published"]')
    const toggleInput = toggle.locator('input[type="checkbox"]')

    await test.step('verify initial state is unchecked', async () => {
      await toggle.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
      await expect(toggleInput).not.toBeChecked()
    })

    await test.step('toggle on and save', async () => {
      await toggle.click()
      await expect(toggleInput).toBeChecked()
      await editorPage.saveAndVerify()
    })

    await test.step('reload and verify published=true persists', async () => {
      await page.reload()
      await editorPage.waitForReady()
      await expect(toggle).toBeVisible({ timeout: STANDARD_TIMEOUT })
      await expect(toggleInput).toBeChecked()
    })

    await test.step('toggle off and save', async () => {
      await toggle.click()
      await expect(toggleInput).not.toBeChecked()
      await editorPage.saveAndVerify()
    })

    await test.step('reload and verify published=false persists', async () => {
      await page.reload()
      await editorPage.waitForReady()
      await expect(toggle).toBeVisible({ timeout: STANDARD_TIMEOUT })
      await expect(toggleInput).not.toBeChecked()
    })
  })

  test.skip('list field: add/remove items', async () => {
    // TODO: List field items have no data-testid attributes in the current UI.
    // Can't programmatically add/remove items; save button stays disabled with no changes.
  })

  test('multiple fields in single entry', async () => {
    await editorPage.goto()
    await editorPage.waitForReady()

    // Open Home Page
    await editorPage.openEntryNavigator()
    await editorPage.selectEntry('Home Page')

    // Edit multiple fields
    const title = `Multi-Field-Test-${Date.now()}`
    const tagline = 'Testing multiple field persistence'

    await editorPage.fillTextField('title', title)
    await editorPage.fillTextField('tagline', tagline)

    // Save once
    await editorPage.saveAndVerify()

    // Verify all changes persisted
    const content = await readContentFile<{ title: string; tagline: string }>(
      'home.home.bo7QdSwn9Tod.json',
    )
    expect(content.title).toBe(title)
    expect(content.tagline).toBe(tagline)

    // Reload and verify all fields retain values
    // After reload, the current entry is still loaded (persisted via URL/state)
    // No need to re-open the navigator - just verify the fields directly
    await editorPage.page.reload()
    await editorPage.waitForReady()

    await editorPage.verifyFieldValue('title', title)
    await editorPage.verifyFieldValue('tagline', tagline)
  })

  test('special characters and unicode', async () => {
    await editorPage.goto()
    await editorPage.waitForReady()

    await editorPage.openEntryNavigator()
    await editorPage.selectEntry('Home Page')

    // Test with special characters and unicode
    const specialChars = 'Test™ • €100 • 你好 • Émojis: 🚀✨'
    await editorPage.fillTextField('title', specialChars)

    await editorPage.saveAndVerify()

    // Verify persistence
    const content = await readContentFile<{ title: string }>('home.home.bo7QdSwn9Tod.json')
    expect(content.title).toBe(specialChars)
  })

  test('empty field persistence', async () => {
    await editorPage.goto()
    await editorPage.waitForReady()

    await editorPage.openEntryNavigator()
    await editorPage.selectEntry('Home Page')

    // Clear the tagline field
    await editorPage.fillTextField('tagline', '')

    await editorPage.saveAndVerify()

    // Verify empty string persists
    const content = await readContentFile<{ tagline: string }>('home.home.bo7QdSwn9Tod.json')
    expect(content.tagline).toBe('')
  })

  test('large content handling', async () => {
    await editorPage.goto()
    await editorPage.waitForReady()

    await editorPage.openEntryNavigator()
    await editorPage.selectEntry('Home Page')

    // Create large content (5KB)
    const largeContent = 'Lorem ipsum dolor sit amet. '.repeat(200)
    await editorPage.fillTextField('tagline', largeContent)

    await editorPage.saveAndVerify()

    // Verify persistence
    const content = await readContentFile<{ tagline: string }>('home.home.bo7QdSwn9Tod.json')
    expect(content.tagline).toBe(largeContent)
  })

  test('rapid successive edits', async () => {
    await editorPage.goto()
    await editorPage.waitForReady()

    await editorPage.openEntryNavigator()
    await editorPage.selectEntry('Home Page')

    // Make several rapid edits
    const values = ['Value 1', 'Value 2', 'Value 3', 'Final Value']

    for (const value of values) {
      await editorPage.fillTextField('title', value)
    }

    // Save final state
    await editorPage.saveAndVerify()

    // Verify final value persisted
    const content = await readContentFile<{ title: string }>('home.home.bo7QdSwn9Tod.json')
    expect(content.title).toBe('Final Value')
  })

  test('field edit and preview update', async () => {
    await editorPage.goto()
    await editorPage.waitForReady()

    await editorPage.openEntryNavigator()
    await editorPage.selectEntry('Home Page')

    const uniqueTitle = `Preview-Test-${Date.now()}`
    await editorPage.fillTextField('title', uniqueTitle)

    // Verify preview pane is still visible (already established by waitForReady())
    await expect(editorPage.previewPane).toBeVisible()
  })
})
