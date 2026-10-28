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

/** A workflow or admin action on a branch card; each lives on the card or in its "…" menu. */
export type BranchAction = 'submit' | 'withdraw' | 'approve' | 'request-changes' | 'delete'

/** What a user sees of an action: usable, shown but not usable, or not offered at all. */
export type BranchActionState = 'enabled' | 'disabled' | 'absent'

/**
 * Page object for interacting with the Branch Manager in CanopyCMS.
 * Provides methods for branch lifecycle operations like create, submit, approve, delete.
 */
export class BranchPage {
  readonly page: Page

  // Branch menu and buttons
  private readonly branchDropdownButton: Locator
  private readonly manageBranchesMenuItem: Locator

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
   * Open the header's branch menu.
   */
  async openBranchMenu(): Promise<void> {
    await this.branchDropdownButton.click()
  }

  /**
   * Open the branch manager modal/drawer.
   */
  async openBranchManager(): Promise<void> {
    await this.openBranchMenu()
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

  /** The status badge of the protected base branch's row, which reads "Protected". */
  getProtectedBadge(branchName: string): Locator {
    return this.branchManager.locator(
      `[data-testid="branch-status-badge-${branchName}"][data-protected]`,
    )
  }

  /** The "Current" badge of the branch the editor has open. */
  getCurrentBadge(branchName: string): Locator {
    return this.branchManager.locator(`[data-testid="branch-current-badge-${branchName}"]`)
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
   * Get the raw workflow status of a branch, read from the badge's `data-status`
   * (the badge text is a display label such as "In review").
   *
   * @param branchName - The name of the branch
   * @returns The status (e.g., 'editing', 'submitted')
   */
  async getBranchStatus(branchName: string): Promise<string> {
    const badge = this.getBranchStatusBadge(branchName)
    await badge.waitFor({ state: 'visible', timeout: SHORT_TIMEOUT })
    return (await badge.getAttribute('data-status')) || ''
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
    // The current branch has no Open button: it is already the one open.
    if (!(await this.getCurrentBadge(branchName).isVisible())) {
      await this.branchManager
        .locator(`[data-testid="switch-to-branch-button-${branchName}"]`)
        .click()
    }

    // Wait for the branch dropdown to reflect the new branch (condition-based)
    await expect(this.branchDropdownButton).toContainText(branchName, {
      timeout: STANDARD_TIMEOUT,
    })
  }

  /**
   * Find an action on a branch's card: its primary button when the card shows it there, else
   * its item in the card's "…" menu, which this opens (the menu renders in a portal, hence
   * `this.page`). Without either, the locator matches nothing. Callers that open the menu
   * (`menuOpened`) close it with {@link closeActionMenu}.
   */
  private async locateAction(
    branchName: string,
    action: BranchAction,
    timeout = SHORT_TIMEOUT,
  ): Promise<{ locator: Locator; menuOpened: boolean }> {
    const card = this.getBranchListItem(branchName)
    const testId = `${action}-branch-button-${branchName}`
    const primary = card.locator(`[data-testid="${testId}"]`)
    const trigger = card.locator(`[data-testid="branch-actions-menu-${branchName}"]`)

    // Whichever the card shows first: it has rendered once one of them is there.
    await primary
      .or(trigger)
      .first()
      .waitFor({ state: 'visible', timeout })
      .catch(() => undefined)
    if (await primary.isVisible()) return { locator: primary, menuOpened: false }
    if (!(await trigger.isVisible())) return { locator: primary, menuOpened: false }

    await trigger.click()
    // An item missing from a menu that never opened must not read as an action that is not offered.
    await this.page
      .locator('[role="menu"]')
      .waitFor({ state: 'visible', timeout: SHORT_TIMEOUT })
      .catch(() => {
        throw new Error(
          `The actions menu for branch ${branchName} did not open, so whether ${action} is offered is unknown.`,
        )
      })
    const item = this.page.locator(`[role="menu"] [data-testid="${testId}"]`)
    await item.waitFor({ state: 'visible', timeout: SHORT_TIMEOUT }).catch(() => undefined)
    return { locator: item, menuOpened: true }
  }

  /** Close a card's "…" menu with Escape, which leaves the drawer open. */
  private async closeActionMenu(): Promise<void> {
    await this.page.keyboard.press('Escape')
    await this.page.locator('[role="menu"]').waitFor({ state: 'hidden', timeout: SHORT_TIMEOUT })
  }

  /**
   * Whether a branch's action is offered, and if so whether it can be used now. A blocked
   * action is `aria-disabled`, which Playwright's `isDisabled()` reads on buttons and menu items.
   *
   * @param branchName - The name of the branch
   * @param action - The action
   */
  async actionState(branchName: string, action: BranchAction): Promise<BranchActionState> {
    const { locator, menuOpened } = await this.locateAction(branchName, action)
    try {
      if (!(await locator.isVisible())) return 'absent'
      return (await locator.isDisabled()) ? 'disabled' : 'enabled'
    } finally {
      if (menuOpened) await this.closeActionMenu()
    }
  }

  /**
   * Click an action that is offered, from the card or its menu, once it is enabled: a status
   * change the last action made can still be on its way to the list.
   */
  private async clickAction(branchName: string, action: BranchAction): Promise<void> {
    const { locator, menuOpened } = await this.locateAction(branchName, action)
    const enabled = await expect(locator)
      .toBeEnabled({ timeout: STANDARD_TIMEOUT })
      .then(() => true)
      .catch(() => false)
    if (!enabled || !(await locator.isVisible())) {
      const state = (await locator.isVisible()) ? 'disabled' : 'not offered'
      if (menuOpened) await this.closeActionMenu()
      throw new Error(
        `The ${action} action for branch ${branchName} is ${state}. The branch may be in another status, or the user may lack access.`,
      )
    }
    await locator.click()
  }

  /**
   * Submit a branch for review (creates PR).
   *
   * @param branchName - The name of the branch to submit
   */
  async submitBranch(branchName: string): Promise<void> {
    await this.clickAction(branchName, 'submit')

    const confirmButton = this.page.locator('[data-testid="confirm-submit-branch"]')
    await confirmButton.waitFor({ state: 'visible', timeout: SHORT_TIMEOUT })
    await confirmButton.click()
  }

  /**
   * Withdraw a submitted branch (converts PR back to draft).
   *
   * @param branchName - The name of the branch to withdraw
   */
  async withdrawBranch(branchName: string): Promise<void> {
    await this.clickAction(branchName, 'withdraw')

    const confirmButton = this.page.locator('[data-testid="confirm-withdraw-branch"]')
    await confirmButton.waitFor({ state: 'visible', timeout: SHORT_TIMEOUT })
    await confirmButton.click()
  }

  /**
   * Request changes on a submitted branch (reviewer action), confirming the dialog.
   *
   * @param branchName - The name of the branch
   */
  async requestChanges(branchName: string): Promise<void> {
    await this.clickAction(branchName, 'request-changes')
    const confirmButton = this.page.locator('[data-testid="confirm-request-changes"]')
    await confirmButton.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
    await confirmButton.click()
  }

  /**
   * Delete a branch.
   *
   * @param branchName - The name of the branch to delete
   */
  async deleteBranch(branchName: string): Promise<void> {
    await this.clickAction(branchName, 'delete')

    // Deletion always confirms. Wait for the dialog: `isVisible()` resolves at once and
    // would race the modal's render.
    const confirmButton = this.page.locator('[data-testid="confirm-delete-branch"]')
    await confirmButton.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
    await confirmButton.click()

    // Wait for the branch to disappear from the list
    await this.branchManager
      .locator(`[data-testid="branch-list-item-${branchName}"]`)
      .waitFor({ state: 'hidden', timeout: STANDARD_TIMEOUT })
  }

  /**
   * Verify an action is offered for a specific branch, on its card or in its "…" menu.
   *
   * @param branchName - The name of the branch
   * @param action - The action (submit, withdraw, request-changes, delete, switch-to)
   * @returns True if the action is shown, enabled or not
   */
  async isActionButtonVisible(
    branchName: string,
    action: BranchAction | 'switch-to',
  ): Promise<boolean> {
    if (action === 'switch-to') {
      return await this.branchManager
        .locator(`[data-testid="switch-to-branch-button-${branchName}"]`)
        .isVisible()
    }
    return (await this.actionState(branchName, action)) !== 'absent'
  }

  /**
   * Verify an action is shown but disabled for a specific branch.
   *
   * @param branchName - The name of the branch
   * @param action - The action (submit, withdraw, request-changes, delete, switch-to)
   * @returns True if the action is shown and disabled; false if it is enabled or not offered
   */
  async isActionButtonDisabled(
    branchName: string,
    action: BranchAction | 'switch-to',
  ): Promise<boolean> {
    if (action === 'switch-to') {
      return await this.branchManager
        .locator(`[data-testid="switch-to-branch-button-${branchName}"]`)
        .isDisabled()
    }
    return (await this.actionState(branchName, action)) === 'disabled'
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
   * Verify the branch status changed to expected value, compared against the badge's
   * `data-status` (the badge text is a display label such as "In review").
   *
   * @param branchName - The name of the branch
   * @param expectedStatus - Expected status (editing, submitted, archived, etc.)
   */
  async verifyBranchStatus(branchName: string, expectedStatus: string): Promise<void> {
    const badge = this.getBranchStatusBadge(branchName)
    await expect(badge).toHaveAttribute('data-status', expectedStatus, {
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
