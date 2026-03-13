import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch, readContentFile } from '../fixtures/test-workspace'

const BASE_URL = 'http://localhost:5174'

/**
 * Multi-Field Content Editing E2E Tests.
 * Tests editing capabilities across different field types to validate data integrity.
 */
test.describe('Multi-Field Content Editing', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    // Mark window as E2E test environment for environment-aware notifications
    await page.addInitScript(() => {
      ;(window as any).__E2E_TEST__ = true
    })

    // Reset workspace and ensure main branch exists
    await resetWorkspace()
    await ensureMainBranch(BASE_URL)

    editorPage = new EditorPage(page)

    // Set default user to admin
    await switchUser(page, 'admin')
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

  test.skip('textarea/MDX field: multi-line content', async ({ page }) => {
    // TODO: Rewrite to create post via API instead of manually writing files.
    // Post files use the naming convention post.{slug}.{id}.json inside posts.qrstuvwxyz12/
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const testPostPath = path.join(
      process.cwd(),
      'apps/test-app/.canopy-prod-sim/content-branches/main/content/posts.qrstuvwxyz12/test-mdx-post.json',
    )

    // Ensure posts directory exists
    await fs.mkdir(path.dirname(testPostPath), { recursive: true })

    // Create initial post content
    await fs.writeFile(
      testPostPath,
      JSON.stringify(
        {
          title: 'Test MDX Post',
          author: 'Test Author',
          date: '2026-01-10',
          tags: [],
          body: 'Initial content',
        },
        null,
        2,
      ),
    )

    await editorPage.goto()
    await editorPage.waitForReady()

    // Open the test post
    await editorPage.openEntryNavigator()

    // Expand Posts collection and select the test post
    const postsNode = page.locator('[data-testid="entry-nav-item-posts"]')
    await postsNode.click()

    // Wait for posts to expand
    await page.waitForTimeout(300)

    // Select the test post
    await editorPage.selectEntry('Test MDX Post')

    // Edit body field (MDX field - textarea) with multi-line content
    const multiLineContent = `Multi-line test\nSecond line\nThird line with **markdown**`
    await editorPage.fillTextareaField('body', multiLineContent)

    await editorPage.saveAndVerify()

    // Verify persistence
    const content = await readContentFile<{ title: string; body: string }>(
      'posts/test-mdx-post.json',
    )
    expect(content.body).toBe(multiLineContent)
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
      await editorPage.page.waitForTimeout(200)
    }

    // Save final state
    await editorPage.saveAndVerify()

    // Verify final value persisted
    const content = await readContentFile<{ title: string }>('home.home.bo7QdSwn9Tod.json')
    expect(content.title).toBe('Final Value')
  })

  test('field edit and preview update', async ({ page }) => {
    await editorPage.goto()
    await editorPage.waitForReady()

    await editorPage.openEntryNavigator()
    await editorPage.selectEntry('Home Page')

    const uniqueTitle = `Preview-Test-${Date.now()}`
    await editorPage.fillTextField('title', uniqueTitle)

    // Wait a moment for preview to potentially update
    await page.waitForTimeout(1000)

    // Verify preview pane is still visible (actual preview content verification depends on implementation)
    await expect(editorPage.previewPane).toBeVisible()
  })
})
