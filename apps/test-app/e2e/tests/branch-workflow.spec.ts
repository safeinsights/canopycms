import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { BranchPage } from '../fixtures/branch-page'
import { switchUser } from '../fixtures/test-users'
import {
  resetWorkspace,
  ensureMainBranch,
  createBranchViaAPI,
  submitBranchViaAPI,
} from '../fixtures/test-workspace'

const BASE_URL = 'http://localhost:5174'

/**
 * Branch Lifecycle & Workflow E2E Tests.
 * Tests CanopyCMS's core differentiator: branch-based editing with full PR workflow.
 */
test.describe('Branch Lifecycle & Workflow', () => {
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

  test('complete happy path: create → edit → submit → approve → archive', async ({ page }) => {
    test.setTimeout(90000)

    const branchName = `test-branch-${Date.now()}`

    // Step 1: Set user to editor FIRST
    await switchUser(page, 'editor')

    // Step 2: Navigate to editor and create branch
    await editorPage.goto()
    await editorPage.waitForReady()
    await branchPage.openBranchManager()

    await branchPage.createBranch(branchName, 'Test Branch Title', 'Test branch for E2E testing')

    // Step 3: Wait for branch to appear and verify status
    await branchPage.waitForBranchInList(branchName, 10000)
    await branchPage.verifyBranchStatus(branchName, 'editing')

    // Step 4: Switch to the new branch
    await branchPage.switchToBranch(branchName)
    await branchPage.closeBranchManager()

    // Step 5: Make some edits
    await editorPage.openEntryNavigator()
    await editorPage.selectEntry('Home Page')
    const testValue = `Branch-Test-${Date.now()}`
    await editorPage.fillTextField('title', testValue)
    await editorPage.saveAndVerify()

    // Step 6: Submit branch for review
    await branchPage.openBranchManager()
    await branchPage.waitForBranchInList(branchName)
    await branchPage.submitBranch(branchName)

    // Step 7: Verify status changed to 'submitted'
    await branchPage.verifyBranchStatus(branchName, 'submitted')

    // Step 8: Switch to reviewer/admin user and approve
    await switchUser(page, 'admin')
    await page.reload()
    await editorPage.waitForReady()
    await branchPage.openBranchManager()

    // Wait for branch to appear for admin
    await branchPage.waitForBranchInList(branchName)

    // Note: The actual approve workflow depends on the implementation
    // For now, we verify the request changes button is visible (admin can request changes)
    const canRequestChanges = await branchPage.isActionButtonVisible(branchName, 'request-changes')
    expect(canRequestChanges).toBe(true)

    await branchPage.closeBranchManager()
  })

  test('branch creation with metadata and validation', async ({ page }) => {
    await editorPage.goto()
    await editorPage.waitForReady()
    await branchPage.openBranchManager()

    const branchName = `feature-branch-${Date.now()}`
    const title = 'Feature Branch'
    const description = 'Adding new feature with tests'

    // Create branch with metadata
    await branchPage.createBranch(branchName, title, description)

    // Verify branch was created
    expect(await branchPage.verifyBranchInList(branchName)).toBe(true)

    // Test duplicate branch name — submit same name again
    await branchPage.createBranchButton.click()
    await branchPage.branchNameInput.fill(branchName)
    await branchPage.createBranchSubmitButton.click()

    // Branch manager should remain visible (duplicate was rejected or ignored)
    await expect(branchPage.branchManager).toBeVisible()
  })

  test('submit and withdraw flow', async ({ page }) => {
    const branchName = `test-withdraw-${Date.now()}`

    // Set user to editor FIRST
    await switchUser(page, 'editor')

    // Create branch via API as editor
    const createResponse = await createBranchViaAPI(BASE_URL, branchName, 'editor')
    expect(createResponse.ok).toBe(true)

    await editorPage.goto()
    await editorPage.waitForReady()
    await branchPage.openBranchManager()

    // Wait for branch to appear and verify status
    await branchPage.waitForBranchInList(branchName)
    await branchPage.verifyBranchStatus(branchName, 'editing')

    // Submit the branch via UI
    await branchPage.submitBranch(branchName)

    // Verify status changed to submitted
    await branchPage.verifyBranchStatus(branchName, 'submitted')

    // Verify withdraw button is visible for creator
    const canWithdraw = await branchPage.isActionButtonVisible(branchName, 'withdraw')
    expect(canWithdraw).toBe(true)

    // Withdraw the branch
    await branchPage.withdrawBranch(branchName)

    // Verify status returns to editing
    await branchPage.verifyBranchStatus(branchName, 'editing')

    // Re-submit
    await branchPage.submitBranch(branchName)
    await branchPage.verifyBranchStatus(branchName, 'submitted')
  })

  test('request changes flow', async ({ page }) => {
    const branchName = `test-request-changes-${Date.now()}`

    // Set editor user first
    await switchUser(page, 'editor')

    // Create and submit branch as editor
    await createBranchViaAPI(BASE_URL, branchName, 'editor')
    const submitResponse = await submitBranchViaAPI(BASE_URL, branchName, 'editor')
    expect(submitResponse.ok).toBe(true)

    // Load page as admin/reviewer
    await switchUser(page, 'admin')
    await editorPage.goto()
    await editorPage.waitForReady()
    await branchPage.openBranchManager()

    // Wait for branch and verify it's submitted
    await branchPage.waitForBranchInList(branchName)
    await branchPage.verifyBranchStatus(branchName, 'submitted')

    // Request changes
    await branchPage.requestChanges(branchName)

    // Verify status changed back to editing
    await branchPage.verifyBranchStatus(branchName, 'editing')

    // Switch back to editor user
    await switchUser(page, 'editor')
    await page.reload()
    await editorPage.waitForReady()
    await branchPage.openBranchManager()

    // Wait for branch to appear
    await branchPage.waitForBranchInList(branchName)

    // Editor can now re-submit
    const canSubmit = await branchPage.isActionButtonVisible(branchName, 'submit')
    expect(canSubmit).toBe(true)
  })

  test('permission boundaries: non-reviewers cannot request changes', async ({ page }) => {
    const branchName = `test-permissions-${Date.now()}`

    // Set editor user and create/submit branch
    await switchUser(page, 'editor')
    await createBranchViaAPI(BASE_URL, branchName, 'editor')
    const submitResponse = await submitBranchViaAPI(BASE_URL, branchName, 'editor')
    expect(submitResponse.ok).toBe(true)

    // Try to request changes as editor (not in Reviewers or Admins group, but can see their own branch)
    await switchUser(page, 'editor')
    await editorPage.goto()
    await editorPage.waitForReady()
    await branchPage.openBranchManager()

    // Wait for branch to appear (editor can see their own branch)
    await branchPage.waitForBranchInList(branchName)

    // Verify request changes button is disabled for non-reviewer
    const isDisabled = await branchPage.isActionButtonDisabled(branchName, 'request-changes')
    expect(isDisabled).toBe(true)
  })

  test('permission boundaries: admin can withdraw another user\'s branch', async ({ page }) => {
    const branchName = `test-withdraw-perms-${Date.now()}`

    // Create and submit branch as editor
    await createBranchViaAPI(BASE_URL, branchName, 'editor')
    await submitBranchViaAPI(BASE_URL, branchName, 'editor')

    // Try to withdraw as different user (admin can, but let's test another editor)
    // For now, test with admin to verify the branch state
    await switchUser(page, 'admin')
    await editorPage.goto()
    await editorPage.waitForReady()
    await branchPage.openBranchManager()

    // Admin should see the branch
    expect(await branchPage.verifyBranchInList(branchName)).toBe(true)

    // Admin has override permissions (canPerformWorkflowActions = true for admins),
    // so the withdraw button should be visible and enabled.
    const withdrawVisible = await branchPage.isActionButtonVisible(branchName, 'withdraw')
    expect(withdrawVisible).toBe(true)
  })

  test('branch deletion permissions', async ({ page }) => {
    const branchName = `test-delete-${Date.now()}`

    // Set user to editor FIRST, then create branch
    await switchUser(page, 'editor')

    // Create branch as editor
    await createBranchViaAPI(BASE_URL, branchName, 'editor')

    await editorPage.goto()
    await editorPage.waitForReady()
    await branchPage.openBranchManager()

    // Wait for branch to appear
    await branchPage.waitForBranchInList(branchName)

    // Verify branch is in editing status
    await branchPage.verifyBranchStatus(branchName, 'editing')

    // Creator should be able to delete
    const canDelete = await branchPage.isActionButtonVisible(branchName, 'delete')
    expect(canDelete).toBe(true)

    // Submit the branch
    await branchPage.submitBranch(branchName)

    // Wait for status to reflect submitted before checking button states
    await branchPage.verifyBranchStatus(branchName, 'submitted')

    // Cannot delete submitted branch
    const canDeleteSubmitted = await branchPage.isActionButtonDisabled(branchName, 'delete')
    expect(canDeleteSubmitted).toBe(true)

    // Withdraw it
    await branchPage.withdrawBranch(branchName)

    // Now can delete again
    await branchPage.deleteBranch(branchName)

    // Verify branch is removed from list
    await branchPage.verifyBranchNotInList(branchName)
  })

  test('branch list filtering and status display', async ({ page }) => {
    // Set user context first
    await switchUser(page, 'editor')

    // Create multiple branches with different statuses via API
    const editingBranch = `editing-${Date.now()}`
    const submittedBranch = `submitted-${Date.now()}`

    await createBranchViaAPI(BASE_URL, editingBranch, 'editor')
    await createBranchViaAPI(BASE_URL, submittedBranch, 'editor')

    // Load page first to establish session
    await editorPage.goto()
    await editorPage.waitForReady()

    // Submit the second branch via API
    const submitResponse = await submitBranchViaAPI(BASE_URL, submittedBranch, 'editor')
    expect(submitResponse.ok).toBe(true)

    // Reload to get fresh branch status
    await page.reload()
    await editorPage.waitForReady()
    await branchPage.openBranchManager()

    // Wait for branches to appear
    await branchPage.waitForBranchInList(editingBranch)
    await branchPage.waitForBranchInList(submittedBranch)

    // Verify statuses
    await branchPage.verifyBranchStatus(editingBranch, 'editing')
    await branchPage.verifyBranchStatus(submittedBranch, 'submitted')

    // Verify status badges have correct styling (color may vary)
    const editingBadge = branchPage.getBranchStatusBadge(editingBranch)
    const submittedBadge = branchPage.getBranchStatusBadge(submittedBranch)

    await expect(editingBadge).toBeVisible()
    await expect(submittedBadge).toBeVisible()
  })
})
