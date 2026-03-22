import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { BranchPage } from '../fixtures/branch-page'
import { switchUser } from '../fixtures/test-users'
import { STANDARD_TIMEOUT, LONG_TIMEOUT } from '../fixtures/timeouts'
import {
  resetWorkspace,
  ensureMainBranch,
  createBranchViaAPI,
  commitBranchChanges,
  pushConflictingChangeToMain,
  triggerRebase,
} from '../fixtures/test-workspace'

const BASE_URL = 'http://localhost:5174'

const HOME_ENTRY_FILE = 'home.home.bo7QdSwn9Tod.json'
const ORIGINAL_HOME_CONTENT =
  '{"title":"Home Page","tagline":"Welcome to the test app","featuredPosts":[]}\n'

/**
 * Conflict Management E2E Tests.
 * Verifies the full conflict detection → UI feedback loop:
 *   worker rebase detects conflicts → metadata updated → sidebar badges + form alert appear.
 */
test.describe('Conflict Management', () => {
  let editorPage: EditorPage
  let branchPage: BranchPage

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__E2E_TEST__ = true
    })
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    branchPage = new BranchPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('conflict detection shows sidebar badge and form alert after rebase', async ({ page }) => {
    test.setTimeout(120_000)

    const branchName = `conflict-test-${Date.now()}`

    // 0. Restore main content to known state (in case a previous run polluted remote.git)
    await test.step('restore clean main content', async () => {
      await pushConflictingChangeToMain(HOME_ENTRY_FILE, ORIGINAL_HOME_CONTENT)
    })

    // 1. Create a feature branch (cloned from clean main)
    await test.step('create branch via API', async () => {
      await createBranchViaAPI(BASE_URL, branchName, 'admin')
    })

    // 2. Navigate to editor and switch to the new branch
    await test.step('switch to branch', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await branchPage.openBranchManager()
      await branchPage.switchToBranch(branchName)
      await branchPage.closeBranchManager()
    })

    // 3. Edit the Home Page entry on the branch
    await test.step('edit Home Page on branch', async () => {
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Home Page')
      await editorPage.fillTextField('title', 'Branch Edit Title')
      await editorPage.saveAndVerify()
    })

    // 4. Commit branch changes so the working tree is clean (rebase skips dirty branches)
    await test.step('commit branch changes', async () => {
      await commitBranchChanges(branchName)
    })

    // 5. Push a conflicting change to main (modifies the same Home Page entry)
    await test.step('push conflicting change to main', async () => {
      await pushConflictingChangeToMain(
        HOME_ENTRY_FILE,
        JSON.stringify(
          { title: 'Upstream Conflict Title', tagline: 'Changed upstream', featuredPosts: [] },
          null,
          2
        ) + '\n'
      )
    })

    // 6. Trigger the worker rebase cycle
    await test.step('trigger rebase', async () => {
      await triggerRebase(BASE_URL)
    })

    // 7. Reload and verify conflict UI appears
    await test.step('verify conflict badge in navigator', async () => {
      await page.reload()
      await editorPage.waitForReady()
      await editorPage.openEntryNavigator()

      // Select the home entry (first treeitem — always present, title may have changed)
      const homeEntry = editorPage.entryNavigator.locator('[role="treeitem"]').first()
      await homeEntry.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
      await homeEntry.click()

      const conflictBadge = page.locator('[data-testid="conflict-badge"]')
      await expect(conflictBadge.first()).toBeVisible({ timeout: LONG_TIMEOUT })
    })

    await test.step('verify conflict alert in form', async () => {
      const conflictAlert = page.locator('[data-testid="conflict-alert"]')
      await expect(conflictAlert).toBeVisible({ timeout: STANDARD_TIMEOUT })
      await expect(conflictAlert).toContainText('Page updated since your draft started')
    })

    // 8. Verify the editor can still edit and save a conflicted entry
    await test.step('verify editing still works on conflicted entry', async () => {
      // Close the entry navigator drawer (its overlay blocks form interaction)
      await page.keyboard.press('Escape')
      await editorPage.fillTextField('title', 'Post-Conflict Edit')
      await editorPage.saveAndVerify()
    })

    // 9. Restore main content so other tests aren't affected by polluted remote.git
    await test.step('cleanup: restore main content', async () => {
      await pushConflictingChangeToMain(HOME_ENTRY_FILE, ORIGINAL_HOME_CONTENT)
    })
  })
})
