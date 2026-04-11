import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch, readContentFile } from '../fixtures/test-workspace'
import { SHORT_TIMEOUT, STANDARD_TIMEOUT, LONG_TIMEOUT } from '../fixtures/timeouts'

const BASE_URL = 'http://localhost:5174'

/**
 * E2E tests for reference field functionality.
 *
 * Tests single-select and multi-select reference fields that load options
 * dynamically from the API, including the entryTypes filter feature.
 */
test.describe('Reference Fields', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.assign(window, { __E2E_TEST__: true })
    })
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('single reference field loads options from collection', async ({ page }) => {
    await test.step('open editor and create two posts', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.createPost('alpha-post', 'Alpha Post')
      await editorPage.createPost('beta-post', 'Beta Post')
    })

    await test.step('navigate to Home Page entry', async () => {
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Home Page')
      await page.keyboard.press('Escape')
      await expect(editorPage.entryNavigator).not.toBeVisible({ timeout: SHORT_TIMEOUT })
    })

    await test.step('verify relatedPost reference field loads options', async () => {
      await editorPage.waitForReferenceOptions('relatedPost')
      const field = editorPage.getReferenceField('relatedPost')
      await expect(field).toBeVisible({ timeout: STANDARD_TIMEOUT })

      // Open the dropdown to see available options
      const input = field.locator('input:not([type="hidden"])')
      await input.click()

      // Both post titles should appear as options (scope to Select dropdown)
      await expect(page.locator('.mantine-Select-option', { hasText: 'Alpha Post' })).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
      await expect(page.locator('.mantine-Select-option', { hasText: 'Beta Post' })).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })

      // Close dropdown
      await page.keyboard.press('Escape')
    })
  })

  test('single reference field: select, save, and persist', async ({ page }) => {
    await test.step('create a post to reference', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.createPost('ref-target', 'Ref Target Post')
    })

    await test.step('navigate to Home Page', async () => {
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Home Page')
      await page.keyboard.press('Escape')
      await expect(editorPage.entryNavigator).not.toBeVisible({ timeout: SHORT_TIMEOUT })
    })

    await test.step('select the reference option', async () => {
      await editorPage.selectReferenceOption('relatedPost', 'Ref Target Post')
    })

    await test.step('save', async () => {
      await editorPage.saveAndVerify()
    })

    await test.step('verify persisted on disk', async () => {
      const content = await readContentFile<{ relatedPost?: string }>('home.home.bo7QdSwn9Tod.json')
      // relatedPost should be a non-empty string (content ID)
      expect(typeof content.relatedPost).toBe('string')
      expect(content.relatedPost).toBeTruthy()
    })

    await test.step('reload and verify selection survives', async () => {
      await page.reload()
      await editorPage.waitForReady()

      // Wait for the Home Page entry to be loaded in the form (title confirms entry is ready)
      await expect(editorPage.getFieldInput('title')).toHaveValue('Home Page', {
        timeout: LONG_TIMEOUT,
      })

      // Wait for reference options to load, then check the Select's displayed value
      await editorPage.waitForReferenceOptions('relatedPost')
      const field = editorPage.getReferenceField('relatedPost')
      const input = field.locator('input:not([type="hidden"])')
      await expect(input).toHaveValue('Ref Target Post', { timeout: STANDARD_TIMEOUT })
    })
  })

  test('single reference field: clear selection', async ({ page }) => {
    await test.step('set up: create post, select reference, save', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.createPost('clearable-post', 'Clearable Post')
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Home Page')
      await page.keyboard.press('Escape')
      await expect(editorPage.entryNavigator).not.toBeVisible({ timeout: SHORT_TIMEOUT })
      await editorPage.selectReferenceOption('relatedPost', 'Clearable Post')
      await editorPage.saveAndVerify()
    })

    await test.step('clear the reference field', async () => {
      await editorPage.clearReferenceField('relatedPost')
    })

    await test.step('save after clearing', async () => {
      await editorPage.saveAndVerify()
    })

    await test.step('verify field is empty on disk', async () => {
      const content = await readContentFile<{ relatedPost?: string }>('home.home.bo7QdSwn9Tod.json')
      // After clear, the value should be empty string or absent
      expect(content.relatedPost ?? '').toBe('')
    })
  })

  test('multi-select reference field: select multiple, save, and persist', async ({ page }) => {
    await test.step('create two posts to reference', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.createPost('featured-one', 'Featured One')
      await editorPage.createPost('featured-two', 'Featured Two')
    })

    await test.step('navigate to Home Page', async () => {
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Home Page')
      await page.keyboard.press('Escape')
      await expect(editorPage.entryNavigator).not.toBeVisible({ timeout: SHORT_TIMEOUT })
    })

    await test.step('select both posts in featuredPosts multi-select', async () => {
      await editorPage.selectMultiReferenceOptions('featuredPosts', [
        'Featured One',
        'Featured Two',
      ])
    })

    await test.step('save', async () => {
      await editorPage.saveAndVerify()
    })

    await test.step('verify array of content IDs on disk', async () => {
      const content = await readContentFile<{ featuredPosts?: string[] }>(
        'home.home.bo7QdSwn9Tod.json',
      )
      expect(Array.isArray(content.featuredPosts)).toBe(true)
      expect(content.featuredPosts).toHaveLength(2)
      // All values should be non-empty content ID strings
      for (const id of content.featuredPosts ?? []) {
        expect(typeof id).toBe('string')
        expect(id).toBeTruthy()
      }
    })

    await test.step('reload and verify both selections survive', async () => {
      await page.reload()
      await editorPage.waitForReady()

      // Wait for the Home Page entry to be loaded in the form
      await expect(editorPage.getFieldInput('title')).toHaveValue('Home Page', {
        timeout: LONG_TIMEOUT,
      })

      // For MultiSelect the selected value pills are rendered as text within the field container
      await editorPage.waitForReferenceOptions('featuredPosts')
      const field = editorPage.getReferenceField('featuredPosts')
      await expect(field).toContainText('Featured One', { timeout: STANDARD_TIMEOUT })
      await expect(field).toContainText('Featured Two', { timeout: STANDARD_TIMEOUT })
    })
  })

  test('reference field search filters options', async ({ page }) => {
    await test.step('create three posts with distinct titles', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.createPost('apple-post', 'Apple')
      await editorPage.createPost('banana-post', 'Banana')
      await editorPage.createPost('cherry-post', 'Cherry')
    })

    await test.step('navigate to Home Page', async () => {
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Home Page')
      await page.keyboard.press('Escape')
      await expect(editorPage.entryNavigator).not.toBeVisible({ timeout: SHORT_TIMEOUT })
    })

    await test.step('open dropdown and type to filter', async () => {
      await editorPage.waitForReferenceOptions('relatedPost')
      const field = editorPage.getReferenceField('relatedPost')
      const input = field.locator('input:not([type="hidden"])')
      await input.click()
      await input.fill('Ban')

      // Only Banana should be visible (scope to Select dropdown)
      await expect(page.locator('.mantine-Select-option', { hasText: 'Banana' })).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
      await expect(page.locator('.mantine-Select-option', { hasText: 'Apple' })).not.toBeVisible()
      await expect(page.locator('.mantine-Select-option', { hasText: 'Cherry' })).not.toBeVisible()
    })
  })
})
