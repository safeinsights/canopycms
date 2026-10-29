import { BASE_URL } from '../fixtures/base-url'
import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'
import { SHORT_TIMEOUT, STANDARD_TIMEOUT } from '../fixtures/timeouts'

/**
 * "Save all", from the caret beside Save: every entry with unsaved changes on the branch is
 * saved, a failure is named with its reason, and a failed entry keeps its unsaved changes.
 */
test.describe('Save all', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('saves the entries it can, names the one that failed, and saves it on Try again', async ({
    page,
  }) => {
    const stamp = Date.now()
    const homeTitle = `Save-all Home ${stamp}`
    const postSlug = `e2e-save-all-${stamp}`
    const postSavedTitle = `Save-all Post ${stamp}`
    const postDraftTitle = `Save-all Post draft ${stamp}`

    await test.step('leave two entries unsaved: Home Page and a new post', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home')
      await editorPage.closeContentNavigator()
      await editorPage.fillTextField('title', homeTitle)
      await editorPage.createPost(postSlug, postSavedTitle)
      await editorPage.fillTextField('title', postDraftTitle)
      await expect(editorPage.branchUnsavedCount()).toHaveText('2 unsaved', {
        timeout: SHORT_TIMEOUT,
      })
    })

    await test.step('"2 unsaved" lists the two under Unsaved, and the open one shows under All', async () => {
      await editorPage.showUnsavedEntries()
      await expect(editorPage.entryFilterOption('Unsaved')).toBeChecked()
      await expect(editorPage.navigatorItem('Home')).toBeVisible()
      await expect(editorPage.navigatorItem(postSavedTitle)).toBeVisible()
      await expect(editorPage.navigatorItem('Settings')).toHaveCount(0)

      await editorPage.showInContentPanel()
      await expect(editorPage.entryFilterOption('All')).toBeChecked()
      await expect(editorPage.navigatorItem('Settings')).toBeVisible()
      await expect(page.locator(':focus')).toHaveAttribute('data-value', /\/e2e-save-all-/)
      await editorPage.closeContentNavigator()
    })

    const failPostWrite = (route: import('@playwright/test').Route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ ok: false, status: 500, error: 'Disk full' }),
          })
        : route.fallback()
    await page.route(`**/api/canopycms/**${postSlug}**`, failPostWrite)

    await test.step('Save all saves Home Page and reports the post as not saved', async () => {
      await editorPage.saveAll()
      const result = editorPage.saveAllResult()
      await expect(result).toBeVisible({ timeout: STANDARD_TIMEOUT })
      await expect(page.getByText('1 of 2 entries not saved')).toBeVisible()
      await expect(result).toContainText('1 entry saved.')
      await expect(result.getByTestId('save-all-failure')).toHaveCount(1)
      await expect(result.getByTestId('save-all-failure')).toContainText(
        `${postSavedTitle}: Save failed. Try again.`,
      )
      await expect(editorPage.branchUnsavedCount()).toHaveText('1 unsaved')
      // The post is open and keeps what was typed.
      await editorPage.verifyFieldValue('title', postDraftTitle)
    })

    await page.unroute(`**/api/canopycms/**${postSlug}**`, failPostWrite)

    await test.step('Try again saves the post', async () => {
      await editorPage.saveAllResult().getByRole('button', { name: 'Try again' }).click()
      await expect(page.getByText('1 entry saved', { exact: true })).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
      await expect(editorPage.branchUnsavedCount()).toHaveCount(0)
    })

    await test.step('both saves are on the server after a reload', async () => {
      await page.reload()
      await editorPage.waitForReady()
      await editorPage.verifyFieldValue('title', postDraftTitle)
      await expect(editorPage.saveButton).toBeDisabled({ timeout: STANDARD_TIMEOUT })
      // A single-entry type is named by its type, so the saved title shows only in its form.
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home')
      await editorPage.closeContentNavigator()
      await editorPage.verifyFieldValue('title', homeTitle)
      await expect(editorPage.saveButton).toBeDisabled({ timeout: STANDARD_TIMEOUT })
    })
  })

  test('says why it cannot run when nothing on the branch is unsaved', async ({ page }) => {
    await editorPage.goto()
    await editorPage.waitForReady()
    const saveAll = editorPage.saveAllButton()
    await expect(saveAll).toHaveAttribute('aria-disabled', 'true')
    await saveAll.focus()
    await expect(page.getByRole('tooltip')).toHaveText(
      'No entry on this branch has unsaved changes.',
    )
  })
})
