import { BASE_URL } from '../fixtures/base-url'
import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'

/**
 * E2E tests for the comments system.
 */
test.describe('Comments', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('add and resolve a field-level comment thread', async () => {
    await test.step('open editor and navigate to Home Page entry', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home Page')
      // Close navigator so form pane is interactive
      await editorPage.closeContentNavigator()
    })

    const commentText = `Field comment ${Date.now()}`

    await test.step('click "New comment" on the title field', async () => {
      await editorPage.startFieldComment('title')
    })

    await test.step('fill and submit new thread', async () => {
      await editorPage.submitFieldComment(commentText)
    })

    await test.step('verify inline thread appears as unresolved', async () => {
      const thread = editorPage.fieldCommentThread()
      await thread.waitFor({ state: 'visible', timeout: 5000 })
      await expect(thread).toContainText(commentText)
      await expect(thread).toContainText('Unresolved')
    })

    await test.step('resolve the thread', async () => {
      await editorPage.resolveFieldComment()
    })

    await test.step('verify thread is marked resolved', async () => {
      const thread = editorPage.fieldCommentThread()
      await expect(thread).toContainText('Resolved', { timeout: 5000 })
      // Resolve button should be gone
      await expect(editorPage.resolveThreadButton()).not.toBeVisible()
    })
  })

  test('add a branch-level comment and verify persistence', async ({ page }) => {
    await test.step('open editor', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    await test.step('open comments panel', async () => {
      await editorPage.openComments()
    })

    const commentText = `Branch comment ${Date.now()}`

    await test.step('add a branch-level comment', async () => {
      await editorPage.addBranchComment(commentText)

      // Comment textarea should clear after submit
      await expect(editorPage.branchCommentDraft()).toHaveValue('', { timeout: 5000 })
    })

    await test.step('verify comment appears in the thread list', async () => {
      const threads = editorPage.branchCommentThreads()
      await expect(threads).toHaveCount(1, { timeout: 5000 })
      await expect(threads.first()).toContainText(commentText)
    })

    await test.step('close panel, reload, and reopen to verify persistence', async () => {
      await editorPage.closeComments()

      await page.reload()
      await editorPage.waitForReady()

      await editorPage.openComments()

      // Comment should still be there
      const threads = editorPage.branchCommentThreads()
      await expect(threads).toHaveCount(1, { timeout: 5000 })
      await expect(threads.first()).toContainText(commentText)
    })
  })
})
