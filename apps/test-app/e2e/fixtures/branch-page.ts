import { type Page, type Locator, expect } from '@playwright/test'
import { SHORT_TIMEOUT, STANDARD_TIMEOUT, LONG_TIMEOUT } from './timeouts'
// Isomorphic/dependency-free module (see its own doc comment) -- safe to
// import directly in test code, same convention test-workspace.ts already
// uses for other package internals (e.g. resource-generation.ts).
import { sanitizeBranchName } from '../../../../packages/canopycms/src/paths/branch-name'

export { sanitizeBranchName }

/**
 * A branch list entry as returned by GET /api/canopycms/branches.
 * Loosely typed -- only the fields callers below actually read.
 */
export interface BranchListEntry {
  name: string
  status: string
  isProtected?: boolean
  [key: string]: unknown
}

/**
 * Discover the server's protected/base branch by calling GET /branches and
 * finding the entry the server itself flagged `isProtected`.
 *
 * NEVER hardcode which branch is protected: dev mode derives the base
 * branch from the git HEAD of the checkout running the server. On a
 * checkout whose git branch isn't literally `main` (true for many worktrees)
 * the server auto-provisions a separate, sanitized-git-branch-named
 * directory and flags THAT one protected, while the fixtures' own `main`
 * content branch stays a normal, non-protected branch. On CI (detached
 * HEAD) the fallback is literally `main`. Always discover at runtime.
 */
export async function findProtectedBranch(
  baseUrl: string,
  userId: string,
): Promise<BranchListEntry> {
  const response = await fetch(`${baseUrl}/api/canopycms/branches`, {
    headers: { 'X-Test-User': userId },
  })
  if (!response.ok) {
    throw new Error(`Failed to list branches: ${response.status}`)
  }
  const body = (await response.json()) as { data: { branches: BranchListEntry[] } }
  const protectedBranch = body.data.branches.find((b) => b.isProtected)
  if (!protectedBranch) {
    throw new Error('No protected branch found in branch list')
  }
  return protectedBranch
}

/**
 * Page object for interacting with the Branch Manager in CanopyCMS.
 * Provides methods for branch lifecycle operations like create, submit, approve, delete.
 */
export class BranchPage {
  readonly page: Page

  // Branch menu and buttons
  readonly branchDropdownButton: Locator
  readonly branchMenu: Locator
  readonly manageBranchesMenuItem: Locator

  // Branch manager modal/drawer
  readonly branchManager: Locator
  readonly createBranchButton: Locator

  // Create branch form
  readonly branchNameInput: Locator
  readonly branchTitleInput: Locator
  readonly branchDescriptionInput: Locator
  readonly createBranchSubmitButton: Locator

  constructor(page: Page) {
    this.page = page

    // Branch dropdown in header
    this.branchDropdownButton = page.locator('[data-testid="branch-dropdown-button"]')
    this.branchMenu = page.locator('[data-testid="branch-menu"]')
    this.manageBranchesMenuItem = page.locator('[data-testid="manage-branches-menu-item"]')

    // Branch manager
    this.branchManager = page.locator('[data-testid="branch-manager"]')
    this.createBranchButton = page.locator('[data-testid="create-branch-button"]')

    // Create branch form fields
    this.branchNameInput = page.locator('[data-testid="branch-name-input"]')
    this.branchTitleInput = page.locator('[data-testid="branch-title-input"]')
    this.branchDescriptionInput = page.locator('[data-testid="branch-description-textarea"]')
    this.createBranchSubmitButton = page.locator('[data-testid="create-branch-submit"]')
  }

  /**
   * Open the branch manager modal/drawer.
   */
  async openBranchManager(): Promise<void> {
    await this.branchDropdownButton.click()
    await this.manageBranchesMenuItem.click()
    await this.branchManager.waitFor({
      state: 'visible',
      timeout: STANDARD_TIMEOUT,
    })
  }

  /**
   * Create a new branch with the given name and optional metadata.
   *
   * @param name - Branch name (required)
   * @param title - Branch title (optional)
   * @param description - Branch description (optional)
   */
  async createBranch(name: string, title?: string, description?: string): Promise<void> {
    // Open create branch form
    await this.createBranchButton.click()

    // Wait for form to appear
    await this.branchNameInput.waitFor({
      state: 'visible',
      timeout: SHORT_TIMEOUT,
    })

    // Fill in branch details
    await this.branchNameInput.fill(name)

    if (title) {
      await this.branchTitleInput.fill(title)
    }

    if (description) {
      await this.branchDescriptionInput.fill(description)
    }

    // Submit the form
    await this.createBranchSubmitButton.click()
  }

  /**
   * Get a locator for a specific branch list item.
   *
   * @param branchName - The name of the branch
   * @returns Locator for the branch list item
   */
  getBranchListItem(branchName: string): Locator {
    return this.branchManager.locator(`[data-testid="branch-list-item-${branchName}"]`)
  }

  /**
   * Get the status badge for a specific branch.
   *
   * @param branchName - The name of the branch
   * @returns Locator for the status badge
   */
  getBranchStatusBadge(branchName: string): Locator {
    return this.branchManager.locator(`[data-testid="branch-status-badge-${branchName}"]`)
  }

  /** Badge shown while a GitHub sync (submit/withdraw/etc.) is in flight. */
  getPendingSyncBadge(branchName: string): Locator {
    return this.branchManager.locator(`[data-testid="pending-sync-badge-${branchName}"]`)
  }

  /** Badge shown when the last GitHub sync attempt failed. */
  getSyncFailedBadge(branchName: string): Locator {
    return this.branchManager.locator(`[data-testid="sync-failed-badge-${branchName}"]`)
  }

  /** Badge shown when a rebase kept this branch's version for conflicting entries. */
  getConflictsBadge(branchName: string): Locator {
    return this.branchManager.locator(`[data-testid="conflicts-badge-${branchName}"]`)
  }

  /** Badge shown on the protected base branch's row. */
  getProtectedBadge(branchName: string): Locator {
    return this.branchManager.locator(`[data-testid="branch-protected-badge-${branchName}"]`)
  }

  /** Badge shown once an approved/archived branch has been merged. */
  getMergedBadge(branchName: string): Locator {
    return this.branchManager.locator(`[data-testid="branch-merged-badge-${branchName}"]`)
  }

  /** The "Updated <relative time>" text rendered inside a branch row. */
  getBranchUpdatedText(branchName: string): Locator {
    return this.getBranchListItem(branchName).getByText(/^Updated /)
  }

  /**
   * Get the status text of a branch.
   *
   * @param branchName - The name of the branch
   * @returns The status text (e.g., 'editing', 'submitted')
   */
  async getBranchStatus(branchName: string): Promise<string> {
    const badge = this.getBranchStatusBadge(branchName)
    await badge.waitFor({ state: 'visible', timeout: SHORT_TIMEOUT })
    return (await badge.textContent()) || ''
  }

  /**
   * Verify a branch exists in the branch list.
   *
   * @param branchName - The name of the branch
   * @returns True if the branch is visible in the list
   */
  async verifyBranchInList(branchName: string): Promise<boolean> {
    try {
      const branchItem = this.getBranchListItem(branchName)
      await branchItem.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
      return true
    } catch {
      return false
    }
  }

  /**
   * Switch to a different branch.
   *
   * @param branchName - The name of the branch to switch to
   */
  async switchToBranch(branchName: string): Promise<void> {
    const switchButton = this.branchManager.locator(
      `[data-testid="switch-to-branch-button-${branchName}"]`,
    )
    await switchButton.click()

    // Wait for the branch dropdown to reflect the new branch (condition-based)
    await expect(this.branchDropdownButton).toContainText(branchName, {
      timeout: STANDARD_TIMEOUT,
    })
  }

  /**
   * Submit a branch for review (creates PR).
   *
   * @param branchName - The name of the branch to submit
   */
  async submitBranch(branchName: string): Promise<void> {
    const submitButton = this.branchManager.locator(
      `[data-testid="submit-branch-button-${branchName}"]`,
    )

    // Wait for button to be enabled
    await submitButton.waitFor({ state: 'visible', timeout: SHORT_TIMEOUT })

    // Check if button is disabled and throw a clear error
    const isDisabled = await submitButton.isDisabled()
    if (isDisabled) {
      throw new Error(
        `Submit button for branch ${branchName} is disabled. The branch may not be in 'editing' status or user may not be the creator.`,
      )
    }

    await submitButton.click()

    // Confirm the Mantine confirmation modal (exact: true avoids matching "Submit Branch..." in EditorHeader)
    const confirmButton = this.page.getByRole('button', {
      name: 'Submit Branch',
      exact: true,
    })
    await confirmButton.waitFor({ state: 'visible', timeout: SHORT_TIMEOUT })
    await confirmButton.click()
  }

  /**
   * Withdraw a submitted branch (converts PR back to draft).
   *
   * @param branchName - The name of the branch to withdraw
   */
  async withdrawBranch(branchName: string): Promise<void> {
    const withdrawButton = this.branchManager.locator(
      `[data-testid="withdraw-branch-button-${branchName}"]`,
    )
    await withdrawButton.click()

    // Confirm the Mantine confirmation modal (exact: true avoids matching "Withdraw Branch..." in EditorHeader)
    const confirmButton = this.page.getByRole('button', {
      name: 'Withdraw Branch',
      exact: true,
    })
    await confirmButton.waitFor({ state: 'visible', timeout: SHORT_TIMEOUT })
    await confirmButton.click()
  }

  // NOTE: No approve-branch-button exists in the UI. Branch approval happens
  // outside the editor (via GitHub PR). Only request-changes is available for reviewers.

  /**
   * Request changes on a submitted branch (reviewer action).
   * Note: request-changes has no confirmation modal — the action fires immediately.
   *
   * @param branchName - The name of the branch
   */
  async requestChanges(branchName: string): Promise<void> {
    const requestChangesButton = this.branchManager.locator(
      `[data-testid="request-changes-branch-button-${branchName}"]`,
    )
    await requestChangesButton.click()
  }

  /**
   * Delete a branch.
   *
   * @param branchName - The name of the branch to delete
   */
  async deleteBranch(branchName: string): Promise<void> {
    const deleteButton = this.branchManager.locator(
      `[data-testid="delete-branch-button-${branchName}"]`,
    )
    await deleteButton.click()

    // Deletion ALWAYS confirms now, so wait for the dialog rather than probing
    // for it. The previous form was `if (await confirmButton.isVisible(...))`,
    // which reads like a wait but is not one: locator.isVisible() resolves
    // immediately and does not auto-wait. That branch was written
    // speculatively and never actually fired -- no confirmation existed -- so
    // its raciness stayed invisible until a real modal was added, at which
    // point it lost the race against the modal's render, silently skipped the
    // click, and left the test waiting 30s for a branch that was never
    // deleted.
    const confirmButton = this.page.locator('[data-testid="confirm-delete-branch"]')
    await confirmButton.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
    await confirmButton.click()

    // Wait for the branch to disappear from the list
    await this.branchManager
      .locator(`[data-testid="branch-list-item-${branchName}"]`)
      .waitFor({ state: 'hidden', timeout: STANDARD_TIMEOUT })
  }

  /**
   * Verify a button is visible for a specific branch action.
   *
   * @param branchName - The name of the branch
   * @param action - The action (submit, withdraw, approve, request-changes, delete, switch-to)
   * @returns True if the button is visible
   */
  async isActionButtonVisible(
    branchName: string,
    action: 'submit' | 'withdraw' | 'request-changes' | 'delete' | 'switch-to',
  ): Promise<boolean> {
    const button = this.branchManager.locator(
      `[data-testid="${action}-branch-button-${branchName}"]`,
    )
    try {
      await button.waitFor({ state: 'visible', timeout: 2000 })
      return true
    } catch {
      return false
    }
  }

  /**
   * Verify a button is disabled for a specific branch action.
   *
   * @param branchName - The name of the branch
   * @param action - The action (submit, withdraw, approve, request-changes, delete, switch-to)
   * @returns True if the button is disabled
   */
  async isActionButtonDisabled(
    branchName: string,
    action: 'submit' | 'withdraw' | 'request-changes' | 'delete' | 'switch-to',
  ): Promise<boolean> {
    const button = this.branchManager.locator(
      `[data-testid="${action}-branch-button-${branchName}"]`,
    )
    return await button.isDisabled()
  }

  /**
   * Close the branch manager.
   */
  async closeBranchManager(): Promise<void> {
    await this.page.keyboard.press('Escape')
    await this.branchManager.waitFor({
      state: 'hidden',
      timeout: SHORT_TIMEOUT,
    })
  }

  /**
   * Verify the branch status changed to expected value.
   *
   * @param branchName - The name of the branch
   * @param expectedStatus - Expected status (editing, submitted, archived, etc.)
   */
  async verifyBranchStatus(branchName: string, expectedStatus: string): Promise<void> {
    const badge = this.getBranchStatusBadge(branchName)
    await expect(badge).toContainText(expectedStatus, {
      timeout: STANDARD_TIMEOUT,
    })
  }

  /**
   * Wait for a branch to appear in the list.
   *
   * @param branchName - The name of the branch
   * @param timeout - Maximum time to wait in milliseconds
   */
  async waitForBranchInList(branchName: string, timeout = LONG_TIMEOUT): Promise<void> {
    const branchItem = this.getBranchListItem(branchName)
    await branchItem.waitFor({ state: 'visible', timeout })
  }

  /**
   * Verify a branch is NOT in the list.
   *
   * @param branchName - The name of the branch
   */
  async verifyBranchNotInList(branchName: string): Promise<void> {
    const branchItem = this.getBranchListItem(branchName)
    await expect(branchItem).not.toBeVisible()
  }
}
