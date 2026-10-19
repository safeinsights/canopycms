import { BASE_URL } from '../fixtures/base-url'
import { test, expect, type Locator } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import {
  resetWorkspace,
  ensureMainBranch,
  readContentFile,
  findContentFile,
} from '../fixtures/test-workspace'
import { STANDARD_TIMEOUT, LONG_TIMEOUT } from '../fixtures/timeouts'

/**
 * E2E tests for reference field functionality.
 *
 * Tests single-select and multi-select reference fields that load options
 * dynamically from the API, including the entryTypes filter feature.
 */
test.describe('Reference Fields', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
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
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home')
      await editorPage.closeContentNavigator()
    })

    await test.step('verify relatedPost reference field loads options', async () => {
      await editorPage.waitForReferenceOptions('relatedPost')
      const field = editorPage.getReferenceField('relatedPost')
      await expect(field).toBeVisible({ timeout: STANDARD_TIMEOUT })

      const options = await editorPage.openReferenceOptions('relatedPost')
      await expect(options.filter({ hasText: 'Alpha Post' })).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
      await expect(options.filter({ hasText: 'Beta Post' })).toBeVisible({
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
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home')
      await editorPage.closeContentNavigator()
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

  test('single reference field: clear selection', async () => {
    await test.step('set up: create post, select reference, save', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.createPost('clearable-post', 'Clearable Post')
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home')
      await editorPage.closeContentNavigator()
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

  test('list reference field: pick several, reorder, save, and persist', async ({ page }) => {
    await test.step('create two posts to reference', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.createPost('featured-one', 'Featured One')
      await editorPage.createPost('featured-two', 'Featured Two')
    })

    await test.step('navigate to Home Page', async () => {
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home')
      await editorPage.closeContentNavigator()
    })

    await test.step('pick both posts in featuredPosts', async () => {
      await editorPage.addReferenceListPicks('featuredPosts', ['Featured One', 'Featured Two'])
      await expect(editorPage.referenceListTitles('featuredPosts').nth(0)).toHaveAttribute(
        'aria-label',
        'Featured One',
      )
      await expect(editorPage.referenceListTitles('featuredPosts').nth(1)).toHaveAttribute(
        'aria-label',
        'Featured Two',
      )
    })

    let picked: string[] = []
    await test.step('save, and find both content IDs on disk in picking order', async () => {
      await editorPage.saveAndVerify()
      const content = await readContentFile<{ featuredPosts?: string[] }>(
        'home.home.bo7QdSwn9Tod.json',
      )
      expect(content.featuredPosts).toHaveLength(2)
      for (const id of content.featuredPosts ?? []) {
        expect(typeof id).toBe('string')
        expect(id).toBeTruthy()
      }
      picked = content.featuredPosts ?? []
    })

    await test.step('move the second pick up, save, and find the order reversed on disk', async () => {
      const second = editorPage.referenceListTitles('featuredPosts').nth(1)
      await second.getByRole('button', { name: 'Actions for Featured Two' }).click()
      await page.getByRole('menuitem', { name: /^Move up/ }).click()
      await expect(editorPage.referenceListTitles('featuredPosts').nth(0)).toHaveAttribute(
        'aria-label',
        'Featured Two',
      )
      await editorPage.saveAndVerify()
      const content = await readContentFile<{ featuredPosts?: string[] }>(
        'home.home.bo7QdSwn9Tod.json',
      )
      expect(content.featuredPosts).toEqual([picked[1], picked[0]])
    })

    await test.step('reload and find both picks in their saved order', async () => {
      await page.reload()
      await editorPage.waitForReady()
      await expect(editorPage.getFieldInput('title')).toHaveValue('Home Page', {
        timeout: LONG_TIMEOUT,
      })
      const rows = editorPage.referenceListTitles('featuredPosts')
      await expect(rows.nth(0)).toHaveAttribute('aria-label', 'Featured Two', {
        timeout: STANDARD_TIMEOUT,
      })
      await expect(rows.nth(1)).toHaveAttribute('aria-label', 'Featured One')
    })
  })

  test('reference field search filters options', async () => {
    await test.step('create three posts with distinct titles', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.createPost('apple-post', 'Apple')
      await editorPage.createPost('banana-post', 'Banana')
      await editorPage.createPost('cherry-post', 'Cherry')
    })

    await test.step('navigate to Home Page', async () => {
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home')
      await editorPage.closeContentNavigator()
    })

    await test.step('open dropdown and type to filter', async () => {
      await editorPage.waitForReferenceOptions('relatedPost')
      const options = await editorPage.openReferenceOptions('relatedPost')
      await expect(options).toHaveCount(3, { timeout: STANDARD_TIMEOUT })
      await editorPage
        .getReferenceField('relatedPost')
        .locator('input:not([type="hidden"])')
        .fill('Ban')

      await expect(options).toHaveText(['Banana'], { timeout: STANDARD_TIMEOUT })
    })
  })
  test('deleting a referenced post names the referencing entry, then deletes on confirm', async () => {
    await test.step('reference a new post from the Home Page and save', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.createPost('doomed-post', 'Doomed Post')
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home')
      await editorPage.closeContentNavigator()
      await editorPage.selectReferenceOption('relatedPost', 'Doomed Post')
      await editorPage.saveAndVerify()
    })

    let modal: Locator

    await test.step('delete the post: the dialog names the Home Page', async () => {
      await editorPage.openContentNavigator()
      modal = await editorPage.startDeleteEntry('Doomed Post')
      await editorPage.deleteConfirmButton().click()

      const list = modal.locator('[data-testid="referenced-by-list"]')
      await expect(list).toBeVisible({ timeout: STANDARD_TIMEOUT })
      await expect(list).toContainText('Home Page')
      await expect(list).toContainText('relatedPost')
      await expect(editorPage.deleteConfirmButton()).toHaveText('Delete anyway')
      expect(await findContentFile('posts.qrstuvwxyz12/post.doomed-post.')).not.toBeNull()
    })

    await test.step('Delete anyway removes the post', async () => {
      await editorPage.deleteConfirmButton().click()
      await expect(modal).not.toBeVisible({ timeout: LONG_TIMEOUT })
      await expect(editorPage.navigatorItem('Doomed Post')).not.toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
      expect(await findContentFile('posts.qrstuvwxyz12/post.doomed-post.')).toBeNull()
    })
  })
})
