import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser } from '../fixtures/test-users'
import {
  resetWorkspace,
  ensureMainBranch,
  findContentFile,
  readRawContentFile,
} from '../fixtures/test-workspace'
import { SHORT_TIMEOUT, STANDARD_TIMEOUT, LONG_TIMEOUT } from '../fixtures/timeouts'

const BASE_URL = 'http://localhost:5174'

/**
 * E2E tests for the entry link feature in the MDX editor.
 *
 * Entry links allow editors to insert stable inter-page links using content IDs.
 * They appear in the MDXEditor toolbar and insert markdown of the form:
 *   [Entry Label](entry:CONTENT_ID)
 */
test.describe('Entry Links in MDX Editor', () => {
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

  /**
   * Create a post entry and open it for editing, with the body field focused.
   * Returns with the navigator closed and the post form showing.
   */
  async function createPostAndOpenBody(
    page: Parameters<typeof switchUser>[0],
    slug: string,
    title: string,
  ): Promise<void> {
    await editorPage.openEntryNavigator()

    const collectionMenu = page.locator('[data-testid="collection-menu-posts"]')
    await collectionMenu.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
    await collectionMenu.click()

    const addEntry = page.locator('[data-testid="add-entry-menu-item"]')
    await addEntry.waitFor({ state: 'visible', timeout: SHORT_TIMEOUT })
    await addEntry.click()

    const modal = page.locator('[data-testid="create-entry-modal"]')
    await expect(modal).toBeVisible()
    await page.locator('[data-testid="entry-slug-input"]').fill(slug)
    await page.locator('[data-testid="create-entry-submit"]').click()
    await expect(modal).not.toBeVisible({ timeout: LONG_TIMEOUT })

    // After creation the navigator is still open. Expand Posts if collapsed, then
    // click the new post entry so it's loaded in the form pane.
    const postsCollection = page.locator('[data-testid="entry-nav-item-posts"]')
    await postsCollection.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
    const navItem = page.locator('[data-testid="entry-nav-item-post"]').last()
    const isVisible = await navItem.isVisible()
    if (!isVisible) {
      await postsCollection.click()
    }
    await navItem.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
    await navItem.click()

    // Close navigator
    await page.keyboard.press('Escape')
    await expect(editorPage.entryNavigator).not.toBeVisible({ timeout: SHORT_TIMEOUT })

    // Fill title field so the entry has a recognisable label
    await editorPage.fillTextField('title', title)
    await editorPage.saveAndVerify()
  }

  test('entry link toolbar button is visible in MDX editor', async ({ page }) => {
    await test.step('open editor and create a post', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await createPostAndOpenBody(page, 'link-test-post', 'Link Test Post')
    })

    await test.step('verify body MDX editor is visible', async () => {
      const bodyEditor = page.getByRole('textbox', { name: 'editable markdown' })
      await bodyEditor.waitFor({ state: 'visible', timeout: LONG_TIMEOUT })
    })

    await test.step('verify entry link toolbar button is present', async () => {
      const linkButton = page.locator('[data-testid="insert-entry-link-button"]')
      await expect(linkButton).toBeVisible({ timeout: STANDARD_TIMEOUT })
    })
  })

  test('clicking toolbar button opens Link to Entry modal with entry list', async ({ page }) => {
    await test.step('open editor, create two posts, then reload so entries are refreshed', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await createPostAndOpenBody(page, 'modal-test-post', 'Modal Test Post')
      await createPostAndOpenBody(page, 'second-post', 'Second Post')
      // Reload so entriesState re-fetches with updated post labels
      await page.reload()
      await editorPage.waitForReady()
    })

    await test.step('focus body editor', async () => {
      const bodyEditor = page.getByRole('textbox', { name: 'editable markdown' })
      await bodyEditor.waitFor({ state: 'visible', timeout: LONG_TIMEOUT })
      await bodyEditor.click()
    })

    await test.step('click insert entry link button', async () => {
      await page.locator('[data-testid="insert-entry-link-button"]').click()
    })

    await test.step('verify modal opens with title "Link to Entry"', async () => {
      await expect(page.getByRole('dialog', { name: 'Link to Entry' })).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
    })

    await test.step('verify search input is visible', async () => {
      await expect(page.locator('[data-testid="entry-link-search"]')).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
    })

    await test.step('verify entries are listed (open dropdown)', async () => {
      const searchInput = page.locator('[data-testid="entry-link-search"]')
      await searchInput.click()

      // Home Page is always present
      await expect(page.locator('[role="option"]', { hasText: 'Home Page' })).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
      // Both posts should appear with their saved titles
      await expect(page.locator('[role="option"]', { hasText: 'Second Post' })).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
    })
  })

  test('search filters entries in the entry link modal', async ({ page }) => {
    await test.step('create a searchable post then reload to refresh entries', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await createPostAndOpenBody(page, 'searchable-post', 'Searchable Post')
      // Reload so entriesState re-fetches with the saved post title
      await page.reload()
      await editorPage.waitForReady()
    })

    await test.step('open entry link modal', async () => {
      const bodyEditor = page.getByRole('textbox', { name: 'editable markdown' })
      await bodyEditor.waitFor({ state: 'visible', timeout: LONG_TIMEOUT })
      await bodyEditor.click()
      await page.locator('[data-testid="insert-entry-link-button"]').click()
      await expect(page.getByRole('dialog', { name: 'Link to Entry' })).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
    })

    await test.step('type "Searchable" to filter entries', async () => {
      const searchInput = page.locator('[data-testid="entry-link-search"]')
      await searchInput.fill('Searchable')

      await expect(page.locator('[role="option"]', { hasText: 'Searchable Post' })).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })

      // Home Page should not be visible after filtering
      await expect(page.locator('[role="option"]', { hasText: 'Home Page' })).not.toBeVisible()
    })

    await test.step('clear search restores all entries', async () => {
      const searchInput = page.locator('[data-testid="entry-link-search"]')
      await searchInput.clear()

      await expect(page.locator('[role="option"]', { hasText: 'Home Page' })).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
    })
  })

  test('no entries found message shown for unmatched search', async ({ page }) => {
    await test.step('open editor, create post, open entry link modal', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await createPostAndOpenBody(page, 'no-match-post', 'No Match Post')
      const bodyEditor = page.getByRole('textbox', { name: 'editable markdown' })
      await bodyEditor.waitFor({ state: 'visible', timeout: LONG_TIMEOUT })
      await bodyEditor.click()
      await page.locator('[data-testid="insert-entry-link-button"]').click()
      await expect(page.getByRole('dialog', { name: 'Link to Entry' })).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
    })

    await test.step('type nonsense search term', async () => {
      const searchInput = page.locator('[data-testid="entry-link-search"]')
      await searchInput.fill('zzz-no-match-zzz')

      await expect(page.getByText('No entries found')).toBeVisible({ timeout: STANDARD_TIMEOUT })
    })
  })

  test('selecting an entry inserts markdown link into the editor', async ({ page }) => {
    await test.step('open editor and create a target post', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await createPostAndOpenBody(page, 'link-target', 'Link Target Post')
    })

    await test.step('open entry link modal and select an entry', async () => {
      const bodyEditor = page.getByRole('textbox', { name: 'editable markdown' })
      await bodyEditor.waitFor({ state: 'visible', timeout: LONG_TIMEOUT })
      await bodyEditor.click()

      const linkButton = page.locator('[data-testid="insert-entry-link-button"]')
      await linkButton.click()
      await expect(page.getByRole('dialog', { name: 'Link to Entry' })).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })

      // Open the dropdown and select Home Page
      const searchInput = page.locator('[data-testid="entry-link-search"]')
      await searchInput.click()
      const option = page.locator('[role="option"]', { hasText: 'Home Page' })
      await option.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
      await option.click()
    })

    await test.step('verify modal closes after selection', async () => {
      await expect(page.getByRole('dialog', { name: 'Link to Entry' })).not.toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
    })

    await test.step('verify link appears in editor', async () => {
      const bodyEditor = page.getByRole('textbox', { name: 'editable markdown' })
      // The inserted link should render as a link in the WYSIWYG editor
      await expect(bodyEditor).toContainText('Home Page', { timeout: STANDARD_TIMEOUT })
    })

    await test.step('save and verify link persists on disk', async () => {
      await editorPage.saveAndVerify()

      // Find the post content file — naming is post.{slug}.{id}.json
      // findContentFile returns the full relative path from content/ root
      const relPath = await findContentFile('posts.qrstuvwxyz12/post.link-target.')
      expect(relPath).toBeTruthy()

      const raw = await readRawContentFile(relPath!)
      const data = JSON.parse(raw) as { body?: string }
      // The body should contain an entry link in the form [Label](entry:ID)
      expect(data.body).toMatch(/\[Home Page\]\(entry:[^)]+\)/)
    })
  })
})
