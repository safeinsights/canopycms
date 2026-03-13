import { type Page, type Locator, expect } from '@playwright/test'

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
    await this.branchManager.waitFor({ state: 'visible', timeout: 10000 })
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
    await this.branchNameInput.waitFor({ state: 'visible', timeout: 5000 })

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

    // Wait for the branch to appear in the list
    await this.page.waitForTimeout(500)
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

  /**
   * Get the status text of a branch.
   *
   * @param branchName - The name of the branch
   * @returns The status text (e.g., 'editing', 'submitted')
   */
  async getBranchStatus(branchName: string): Promise<string> {
    const badge = this.getBranchStatusBadge(branchName)
    await badge.waitFor({ state: 'visible', timeout: 5000 })
    return await badge.textContent() || ''
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
      await branchItem.waitFor({ state: 'visible', timeout: 5000 })
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
    const switchButton = this.branchManager.locator(`[data-testid="switch-to-branch-button-${branchName}"]`)
    await switchButton.click()

    // Wait for branch switcher to update
    await this.page.waitForTimeout(1000)
    await this.page.waitForLoadState('networkidle')
  }

  /**
   * Submit a branch for review (creates PR).
   *
   * @param branchName - The name of the branch to submit
   */
  async submitBranch(branchName: string): Promise<void> {
    const submitButton = this.branchManager.locator(`[data-testid="submit-branch-button-${branchName}"]`)

    // Wait for button to be enabled
    await submitButton.waitFor({ state: 'visible', timeout: 5000 })

    // Check if button is disabled and throw a clear error
    const isDisabled = await submitButton.isDisabled()
    if (isDisabled) {
      throw new Error(`Submit button for branch ${branchName} is disabled. The branch may not be in 'editing' status or user may not be the creator.`)
    }

    await submitButton.click()

    // Confirm the Mantine confirmation modal (exact: true avoids matching "Submit Branch..." in EditorHeader)
    const confirmButton = this.page.getByRole('button', { name: 'Submit Branch', exact: true })
    await confirmButton.waitFor({ state: 'visible', timeout: 5000 })
    await confirmButton.click()

    // Wait for status update
    await this.page.waitForTimeout(2000)
  }

  /**
   * Withdraw a submitted branch (converts PR back to draft).
   *
   * @param branchName - The name of the branch to withdraw
   */
  async withdrawBranch(branchName: string): Promise<void> {
    const withdrawButton = this.branchManager.locator(`[data-testid="withdraw-branch-button-${branchName}"]`)
    await withdrawButton.click()

    // Confirm the Mantine confirmation modal (exact: true avoids matching "Withdraw Branch..." in EditorHeader)
    const confirmButton = this.page.getByRole('button', { name: 'Withdraw Branch', exact: true })
    await confirmButton.waitFor({ state: 'visible', timeout: 5000 })
    await confirmButton.click()

    // Wait for status update
    await this.page.waitForTimeout(1000)
  }

  // NOTE: No approve-branch-button exists in the UI. Branch approval happens
  // outside the editor (via GitHub PR). Only request-changes is available for reviewers.

  /**
   * Request changes on a submitted branch (reviewer action).
   *
   * @param branchName - The name of the branch
   * @param comment - Optional comment explaining the requested changes
   */
  async requestChanges(branchName: string, comment?: string): Promise<void> {
    const requestChangesButton = this.branchManager.locator(`[data-testid="request-changes-branch-button-${branchName}"]`)
    await requestChangesButton.click()

    // If there's a comment field in a modal, fill it
    if (comment) {
      // This may need adjustment based on actual UI implementation
      const commentInput = this.page.locator('[data-testid="request-changes-comment"]')
      if (await commentInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await commentInput.fill(comment)
        await this.page.locator('[data-testid="confirm-request-changes"]').click()
      }
    }

    // Wait for status update
    await this.page.waitForTimeout(1000)
  }

  /**
   * Delete a branch.
   *
   * @param branchName - The name of the branch to delete
   */
  async deleteBranch(branchName: string): Promise<void> {
    const deleteButton = this.branchManager.locator(`[data-testid="delete-branch-button-${branchName}"]`)
    await deleteButton.click()

    // Handle confirmation dialog if present
    const confirmButton = this.page.locator('[data-testid="confirm-delete-branch"]')
    if (await confirmButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmButton.click()
    }

    // Wait for deletion to complete
    await this.page.waitForTimeout(1000)
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
    action: 'submit' | 'withdraw' | 'request-changes' | 'delete' | 'switch-to'
  ): Promise<boolean> {
    const button = this.branchManager.locator(`[data-testid="${action}-branch-button-${branchName}"]`)
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
    action: 'submit' | 'withdraw' | 'request-changes' | 'delete' | 'switch-to'
  ): Promise<boolean> {
    const button = this.branchManager.locator(`[data-testid="${action}-branch-button-${branchName}"]`)
    return await button.isDisabled()
  }

  /**
   * Close the branch manager.
   */
  async closeBranchManager(): Promise<void> {
    // Click outside or use close button if available
    const closeButton = this.branchManager.locator('[data-testid="close-branch-manager"]')
    if (await closeButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await closeButton.click()
    } else {
      // Press Escape key to close modal
      await this.page.keyboard.press('Escape')
    }

    await this.branchManager.waitFor({ state: 'hidden', timeout: 5000 })
  }

  /**
   * Verify the branch status changed to expected value.
   *
   * @param branchName - The name of the branch
   * @param expectedStatus - Expected status (editing, submitted, archived, etc.)
   */
  async verifyBranchStatus(branchName: string, expectedStatus: string): Promise<void> {
    const badge = this.getBranchStatusBadge(branchName)
    await expect(badge).toContainText(expectedStatus, { timeout: 10000 })
  }

  /**
   * Wait for a branch to appear in the list.
   *
   * @param branchName - The name of the branch
   * @param timeout - Maximum time to wait in milliseconds
   */
  async waitForBranchInList(branchName: string, timeout = 10000): Promise<void> {
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
