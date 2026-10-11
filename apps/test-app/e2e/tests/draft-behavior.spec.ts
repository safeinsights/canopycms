import { BASE_URL } from '../fixtures/base-url'
import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'

/**
 * E2E tests for editor draft behavior: persistence across reloads and discard.
 */
test.describe('Draft Behavior', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('discard file draft reverts field to last-saved state', async () => {
    await test.step('open editor and select Home Page', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home Page')
    })

    await test.step('verify initial state — save button disabled (no changes)', async () => {
      await expect(editorPage.saveButton).toBeDisabled()
    })

    await test.step('edit title field', async () => {
      await editorPage.fillTextField('title', 'Modified Title')
      // Save button should now be enabled
      await expect(editorPage.saveButton).toBeEnabled({ timeout: 5000 })
    })

    await test.step('discard file draft via file dropdown menu', async () => {
      // Discarding a dirty draft asks for confirmation — confirm through the dialog.
      const confirmDialog = await editorPage.discardEntryDraft()
      await expect(confirmDialog).toBeVisible({ timeout: 5000 })
      await editorPage.confirmDiscard(confirmDialog)

      // Verify notification appears
      await expect(editorPage.notification('Draft cleared for file')).toBeVisible({
        timeout: 5000,
      })
    })

    await test.step('verify field reverts and save button is disabled', async () => {
      // Title should revert to the last-saved value
      await editorPage.verifyFieldValue('title', 'Home Page')
      // Save button should be disabled again (no dirty state)
      await expect(editorPage.saveButton).toBeDisabled({ timeout: 5000 })
    })
  })

  test('unsaved draft survives a page reload', async ({ page }) => {
    await test.step('open editor and select Home Page', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home Page')
    })

    const draftTitle = `Draft-${Date.now()}`

    await test.step('edit title field without saving', async () => {
      await editorPage.fillTextField('title', draftTitle)
      await expect(editorPage.saveButton).toBeEnabled({ timeout: 5000 })
    })

    await test.step('reload the page', async () => {
      await page.reload()
      await editorPage.waitForReady()
    })

    await test.step('verify draft is restored after reload', async () => {
      // Draft should be restored from localStorage — field shows the unsaved value
      await editorPage.verifyFieldValue('title', draftTitle)
      // Save button should still be enabled (draft is dirty)
      await expect(editorPage.saveButton).toBeEnabled({ timeout: 5000 })
    })
  })
})
