import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'
import { SHORT_TIMEOUT, STANDARD_TIMEOUT } from '../fixtures/timeouts'

const BASE_URL = 'http://localhost:5174'

/**
 * E2E tests for the "truthful draft lifecycle" rework (commits e43b7a6,
 * b9990b2): a saved entry must not look permanently dirty, the discard-all
 * confirm dialog must pluralize correctly, and a restored localStorage
 * draft must not prevent the entry's real server value from loading.
 *
 * `draft-behavior.spec.ts` already covers discarding a SINGLE file's draft
 * (the singular "Discard draft" dialog) and an unsaved draft surviving a
 * reload — this file deliberately does not repeat either.
 */
test.describe('Draft Lifecycle', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('E3: saving clears the draft — save button stays disabled after a reload (regression e43b7a6)', async ({
    page,
  }) => {
    const newTitle = `E3-${Date.now()}`

    await test.step('open editor and select Home Page', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Home Page')
    })

    await test.step('verify initial state — save button disabled', async () => {
      await expect(editorPage.saveButton).toBeDisabled()
    })

    await test.step('edit and save', async () => {
      await editorPage.fillTextField('title', newTitle)
      await expect(editorPage.saveButton).toBeEnabled({ timeout: SHORT_TIMEOUT })
      await editorPage.saveAndVerify()
    })

    await test.step('save button is disabled immediately after save', async () => {
      await expect(editorPage.saveButton).toBeDisabled({ timeout: STANDARD_TIMEOUT })
    })

    await test.step('reload — save button STAYS disabled (a stale draft equal to the loaded value used to read as dirty)', async () => {
      await page.reload()
      await editorPage.waitForReady()
      await editorPage.verifyFieldValue('title', newTitle)
      await expect(editorPage.saveButton).toBeDisabled({ timeout: STANDARD_TIMEOUT })
    })
  })

  test('E4: discard-all confirm dialog pluralizes correctly (regression b9990b2)', async ({
    page,
  }) => {
    const homeDraftTitle = `E4-Home-${Date.now()}`
    const postSavedTitle = `E4 Post ${Date.now()}`
    const postDraftTitle = `E4-Post-Dirty-${Date.now()}`
    const postSlug = `e2e-e4-${Date.now()}`

    await test.step('open editor and dirty Home Page without saving', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Home Page')
      await page.keyboard.press('Escape')
      await editorPage.fillTextField('title', homeDraftTitle)
      await expect(editorPage.saveButton).toBeEnabled({ timeout: SHORT_TIMEOUT })
    })

    await test.step('create a second entry (a Post) and dirty it too, without saving the new edit', async () => {
      // createPost() saves once to give the entry a recognisable label —
      // leaves it clean. Dirty it again afterward so two DIFFERENT entries
      // are unsaved-dirty at once (Home from the step above, Post here).
      await editorPage.createPost(postSlug, postSavedTitle)
      await editorPage.fillTextField('title', postDraftTitle)
      await expect(editorPage.saveButton).toBeEnabled({ timeout: SHORT_TIMEOUT })
    })

    await test.step('open discard-all and assert the PLURAL dialog naming 2 files', async () => {
      await page.locator('[data-testid="branch-dropdown-button"]').click()
      await page.getByRole('menuitem', { name: 'Discard All File Drafts' }).click()
      const dialog = page.getByRole('dialog', { name: 'Discard drafts' })
      await expect(dialog).toBeVisible({ timeout: SHORT_TIMEOUT })
      await expect(dialog).toContainText('Discard drafts for 2 files?')
      await dialog.getByRole('button', { name: 'Discard', exact: true }).click()
      await expect(dialog).toBeHidden({ timeout: SHORT_TIMEOUT })
    })

    await test.step('both entries reverted to their last-saved values; save button disabled', async () => {
      // The Post (currently selected) reverts to its last-saved title.
      await editorPage.verifyFieldValue('title', postSavedTitle)
      await expect(editorPage.saveButton).toBeDisabled({ timeout: STANDARD_TIMEOUT })

      // Home reverts too.
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Home Page')
      await page.keyboard.press('Escape')
      await editorPage.verifyFieldValue('title', 'Home Page')
      await expect(editorPage.saveButton).toBeDisabled({ timeout: STANDARD_TIMEOUT })
    })

    await test.step('repeat with exactly ONE dirty file — assert the SINGULAR "file" wording', async () => {
      const secondDraftTitle = `E4-Single-${Date.now()}`
      await editorPage.fillTextField('title', secondDraftTitle)
      await expect(editorPage.saveButton).toBeEnabled({ timeout: SHORT_TIMEOUT })

      await page.locator('[data-testid="branch-dropdown-button"]').click()
      await page.getByRole('menuitem', { name: 'Discard All File Drafts' }).click()
      const dialog = page.getByRole('dialog', { name: 'Discard drafts' })
      await expect(dialog).toBeVisible({ timeout: SHORT_TIMEOUT })
      await expect(dialog).toContainText('Discard drafts for 1 file?')
      // Guard against a regression back to "1 files" — toContainText above
      // would still pass against "1 files" since it's a substring match.
      await expect(dialog).not.toContainText('1 files')
      await dialog.getByRole('button', { name: 'Discard', exact: true }).click()
      await expect(dialog).toBeHidden({ timeout: SHORT_TIMEOUT })
    })
  })

  test('E5: entries still load when a draft was restored from localStorage (regression e43b7a6)', async ({
    page,
  }) => {
    const draftTitle = `E5-Home-${Date.now()}`

    await test.step('dirty Home Page without saving', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Home Page')
      await page.keyboard.press('Escape')
      await editorPage.fillTextField('title', draftTitle)
      await expect(editorPage.saveButton).toBeEnabled({ timeout: SHORT_TIMEOUT })
    })

    await test.step('reload — draft is restored from localStorage', async () => {
      await page.reload()
      await editorPage.waitForReady()
      await editorPage.verifyFieldValue('title', draftTitle)
      await expect(editorPage.saveButton).toBeEnabled({ timeout: SHORT_TIMEOUT })
    })

    await test.step('the entry navigator still lists entries normally', async () => {
      await editorPage.openEntryNavigator()
      await expect(page.locator('[data-testid="entry-nav-item-home-page"]')).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
      await expect(page.locator('[data-testid="entry-nav-item-test-site"]')).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
    })

    await test.step('switching to a different entry shows its real saved value (server load was not short-circuited by the restored draft)', async () => {
      await editorPage.selectEntry('Test Site')
      await page.keyboard.press('Escape')
      await editorPage.verifyFieldValue('siteName', 'Test Site')
      // This entry has no draft of its own, so it should read as clean —
      // proving its loadedValues entry was actually populated rather than
      // left undefined (which the pre-fix code treats as permanently dirty).
      await expect(editorPage.saveButton).toBeDisabled({ timeout: STANDARD_TIMEOUT })
    })
  })
})
