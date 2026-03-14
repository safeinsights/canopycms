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
