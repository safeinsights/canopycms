import { type Page, type Locator, expect } from '@playwright/test'

/**
 * Page object for the CanopyCMS Editor.
 * Provides methods for common editor interactions in E2E tests.
 */
export class EditorPage {
  readonly page: Page

  // Panes
  readonly formPane: Locator
  readonly previewPane: Locator

  // Header elements
  readonly fileDropdownButton: Locator
  readonly allFilesMenuItem: Locator
  readonly saveButton: Locator

  // Entry navigator
  readonly entryNavigator: Locator

  constructor(page: Page) {
    this.page = page

    // Panes
    this.formPane = page.locator('[data-testid="form-pane"]')
    this.previewPane = page.locator('[data-testid="preview-pane"]')

    // Header elements
    this.fileDropdownButton = page.locator('[data-testid="file-dropdown-button"]')
    this.saveButton = page.locator('[data-testid="save-button"]')
    this.allFilesMenuItem = page.locator('[data-testid="all-files-menu-item"]')

    // Entry navigator (in drawer)
    this.entryNavigator = page.locator('[data-testid="entry-navigator"]')
  }

  /**
   * Navigate to the editor page.
   */
  async goto(): Promise<void> {
    await this.page.goto('/edit')
  }

  /**
   * Wait for the editor to be fully loaded and ready.
   * Waits for both panes to be visible.
   */
  async waitForReady(): Promise<void> {
    await this.formPane.waitFor({ state: 'visible', timeout: 30000 })
    await this.previewPane.waitFor({ state: 'visible', timeout: 30000 })
  }

  /**
   * Open the entry navigator drawer via the file dropdown menu.
   */
  async openEntryNavigator(): Promise<void> {
    await this.fileDropdownButton.click()
    await this.allFilesMenuItem.click()
    await this.entryNavigator.waitFor({ state: 'visible', timeout: 10000 })
  }

  /**
   * Select an entry by its label in the navigator tree.
   * @param label - The display label of the entry to select
   */
  async selectEntry(label: string): Promise<void> {
    // Use the data-testid for reliable selection
    const testId = `entry-nav-item-${label.toLowerCase().replace(/\s+/g, '-')}`
    const entry = this.entryNavigator.locator(`[data-testid="${testId}"]`)
    await entry.waitFor({ state: 'visible', timeout: 10000 })

    // Click on the entry item
    await entry.click()

    // Small delay for state update
    await this.page.waitForTimeout(500)

    // Wait for the file dropdown to show the selected entry name
    await expect(this.fileDropdownButton).toContainText(label, { timeout: 10000 })

    // Wait for network requests to settle
    await this.page.waitForLoadState('networkidle')
  }

  /**
   * Get a field input by its data-canopy-field attribute.
   * @param fieldName - The field name (matches data-canopy-field value)
   */
  getFieldInput(fieldName: string): Locator {
    // Use input selector to avoid matching the label wrapper
    return this.formPane.locator(
      `input[data-canopy-field="${fieldName}"], textarea[data-canopy-field="${fieldName}"]`,
    )
  }

  /**
   * Fill a text field with a value.
   * @param fieldName - The field name (matches data-canopy-field value)
   * @param value - The value to enter
   */
  async fillTextField(fieldName: string, value: string): Promise<void> {
    const input = this.getFieldInput(fieldName)
    await input.click()
    await input.fill(value)
  }

  /**
   * Click the save button.
   */
  async save(): Promise<void> {
    await this.saveButton.click()
  }

  /**
   * Wait for the save success notification to appear.
   */
  async waitForSaveNotification(): Promise<void> {
    await expect(this.page.locator('.mantine-Notification-root', { hasText: 'Saved' })).toBeVisible(
      { timeout: 10000 },
    )
  }

  /**
   * Complete save flow: click save and wait for success notification.
   */
  async saveAndVerify(): Promise<void> {
    await this.save()
    await this.waitForSaveNotification()
  }
}
