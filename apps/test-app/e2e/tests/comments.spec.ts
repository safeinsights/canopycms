import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'

const BASE_URL = 'http://localhost:5174'

/**
 * E2E tests for the comments system.
 */
test.describe('Comments', () => {
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

  test('add and resolve a field-level comment thread', async ({ page }) => {
    await test.step('open editor and navigate to Home Page entry', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Home Page')
      // Close navigator so form pane is interactive
      await page.keyboard.press('Escape')
      await expect(editorPage.entryNavigator).not.toBeVisible({ timeout: 5000 })
    })

    const commentText = `Field comment ${Date.now()}`

    await test.step('click "New comment" on the title field', async () => {
      const newCommentButton = page.locator('[data-testid="field-new-comment-title"]')
      await newCommentButton.waitFor({ state: 'visible', timeout: 10000 })
      await newCommentButton.click()
    })

    await test.step('fill and submit new thread', async () => {
      const textarea = page.locator('[data-testid="new-thread-textarea"]')
      await textarea.waitFor({ state: 'visible', timeout: 5000 })
      await textarea.fill(commentText)

      const createButton = page.locator('[data-testid="create-thread-button"]')
      await createButton.click()
    })

    await test.step('verify inline thread appears as unresolved', async () => {
      const thread = page.locator('[data-testid="inline-comment-thread"]')
      await thread.waitFor({ state: 'visible', timeout: 5000 })
      await expect(thread).toContainText(commentText)
      await expect(thread).toContainText('Unresolved')
    })

    await test.step('resolve the thread', async () => {
      const resolveButton = page.locator('[data-testid="resolve-thread-button"]')
      await resolveButton.waitFor({ state: 'visible', timeout: 5000 })
      await resolveButton.click()
    })

    await test.step('verify thread is marked resolved', async () => {
      const thread = page.locator('[data-testid="inline-comment-thread"]')
      await expect(thread).toContainText('Resolved', { timeout: 5000 })
      // Resolve button should be gone
      await expect(page.locator('[data-testid="resolve-thread-button"]')).not.toBeVisible()
    })
  })

  test('add a branch-level comment and verify persistence', async ({ page }) => {
    await test.step('open editor', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    await test.step('open comments panel', async () => {
      const commentsButton = page.locator('[data-testid="comments-button"]')
      await commentsButton.waitFor({ state: 'visible', timeout: 10000 })
      await commentsButton.click()
    })

    const commentText = `Branch comment ${Date.now()}`

    await test.step('add a branch-level comment', async () => {
      const textarea = page.locator('[data-testid="comment-textarea"]')
      await textarea.waitFor({ state: 'visible', timeout: 5000 })
      await textarea.fill(commentText)

      const submitButton = page.locator('[data-testid="comment-submit"]')
      await submitButton.click()

      // Comment textarea should clear after submit
      await expect(textarea).toHaveValue('', { timeout: 5000 })
    })

    await test.step('verify comment appears in the thread list', async () => {
      const threads = page.locator('[data-testid="comment-thread"]')
      await expect(threads).toHaveCount(1, { timeout: 5000 })
      await expect(threads.first()).toContainText(commentText)
    })

    await test.step('close panel, reload, and reopen to verify persistence', async () => {
      // Close panel via Escape
      await page.keyboard.press('Escape')

      await page.reload()
      await editorPage.waitForReady()

      // Reopen comments panel
      const commentsButton = page.locator('[data-testid="comments-button"]')
      await commentsButton.waitFor({ state: 'visible', timeout: 10000 })
      await commentsButton.click()

      // Comment should still be there
      const threads = page.locator('[data-testid="comment-thread"]')
      await expect(threads).toHaveCount(1, { timeout: 5000 })
      await expect(threads.first()).toContainText(commentText)
    })
  })
})
