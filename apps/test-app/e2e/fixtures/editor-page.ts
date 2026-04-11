import { type Page, type Locator, expect } from '@playwright/test'
import { STANDARD_TIMEOUT, LONG_TIMEOUT } from './timeouts'

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
    await Promise.all([
      this.formPane.waitFor({ state: 'visible', timeout: LONG_TIMEOUT }),
      this.previewPane.waitFor({ state: 'visible', timeout: LONG_TIMEOUT }),
    ])
  }

  /**
   * Open the entry navigator drawer via the file dropdown menu.
   */
  async openEntryNavigator(): Promise<void> {
    await this.fileDropdownButton.click()
    await this.allFilesMenuItem.click()
    await this.entryNavigator.waitFor({
      state: 'visible',
      timeout: STANDARD_TIMEOUT,
    })
  }

  /**
   * Select an entry by its label in the navigator tree.
   * @param label - The display label of the entry to select
   */
  async selectEntry(label: string): Promise<void> {
    // Use the data-testid for reliable selection
    const testId = `entry-nav-item-${label.toLowerCase().replace(/\s+/g, '-')}`
    const entry = this.entryNavigator.locator(`[data-testid="${testId}"]`)
    await entry.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })

    // Click on the entry item
    await entry.click()

    // Wait for the file dropdown to show the selected entry name (condition-based, no blind wait)
    await expect(this.fileDropdownButton).toContainText(label, {
      timeout: STANDARD_TIMEOUT,
    })
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
   * Uses .first() because multiple saves in quick succession can stack notifications.
   */
  async waitForSaveNotification(): Promise<void> {
    await expect(
      this.page.locator('.mantine-Notification-root', { hasText: 'Saved' }).first(),
    ).toBeVisible({ timeout: STANDARD_TIMEOUT })
  }

  /**
   * Complete save flow: click save and wait for the content PUT response.
   * Uses waitForResponse instead of notification polling so stale notifications
   * from prior saves don't cause false positives.
   */
  async saveAndVerify(): Promise<void> {
    await Promise.all([
      this.page.waitForResponse(
        (resp) =>
          resp.url().includes('/api/canopycms/') &&
          resp.request().method() === 'PUT' &&
          resp.status() === 200,
        { timeout: STANDARD_TIMEOUT },
      ),
      this.save(),
    ])
  }

  // NOTE: List field add/remove buttons and toggle/select/object fields
  // do not have data-testid attributes in the current UI implementation.

  /**
   * Wait for the preview pane to update with specific content.
   * @param expectedContent - Text that should appear in the preview
   */
  async waitForPreviewUpdate(expectedContent: string): Promise<void> {
    await expect(this.previewPane.locator(`text="${expectedContent}"`)).toBeVisible({
      timeout: STANDARD_TIMEOUT,
    })
  }

  // NOTE: No discard-button data-testid exists in the editor UI yet.
  // Discard is available via "Discard File Draft" menu item but has no data-testid.

  /**
   * Fill a textarea field (for MDX, markdown, etc.).
   * @param fieldName - The field name
   * @param value - The value to set
   */
  async fillTextareaField(fieldName: string, value: string): Promise<void> {
    const textarea = this.formPane.locator(`textarea[data-canopy-field="${fieldName}"]`)
    await textarea.click()
    await textarea.fill(value)
  }

  /**
   * Verify a field has a specific value.
   * @param fieldName - The field name
   * @param expectedValue - Expected value
   */
  async verifyFieldValue(fieldName: string, expectedValue: string): Promise<void> {
    const input = this.getFieldInput(fieldName)
    await expect(input).toHaveValue(expectedValue)
  }

  /**
   * Get the container for a reference field.
   */
  getReferenceField(fieldName: string): Locator {
    return this.formPane.locator(`[data-testid="reference-field-${fieldName}"]`)
  }

  /**
   * Wait for a reference field to finish loading its options.
   */
  async waitForReferenceOptions(fieldName: string): Promise<void> {
    const loader = this.formPane.locator(`[data-testid="reference-loading-${fieldName}"]`)
    // Wait for loader to disappear (it's shown while fetching options)
    await expect(loader).not.toBeVisible({ timeout: STANDARD_TIMEOUT })
  }

  /**
   * Select an option in a single-select reference field (Mantine Select).
   * @param fieldName - The data-canopy-field name
   * @param optionLabel - The visible label of the option to select
   */
  async selectReferenceOption(fieldName: string, optionLabel: string): Promise<void> {
    await this.waitForReferenceOptions(fieldName)
    const field = this.getReferenceField(fieldName)
    // Mantine Select renders a hidden value input alongside the visible search input
    const input = field.locator('input:not([type="hidden"])')
    await input.click()
    // Scope to mantine-Select-option to avoid collisions with MultiSelect portals
    // that may also be rendered in the DOM simultaneously
    const option = this.page.locator('.mantine-Select-option', { hasText: optionLabel })
    await option.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
    await option.click()
  }

  /**
   * Select multiple options in a multi-select reference field (Mantine MultiSelect).
   * @param fieldName - The data-canopy-field name
   * @param optionLabels - Array of visible labels to select
   */
  async selectMultiReferenceOptions(fieldName: string, optionLabels: string[]): Promise<void> {
    await this.waitForReferenceOptions(fieldName)
    const field = this.getReferenceField(fieldName)
    const input = field.locator('input:not([type="hidden"])')
    for (const label of optionLabels) {
      await input.click()
      // Scope to mantine-MultiSelect-option to avoid collisions with Select portals
      const option = this.page.locator('.mantine-MultiSelect-option', { hasText: label })
      await option.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
      await option.click()
    }
  }

  /**
   * Clear a single-select reference field by clicking the rightSection button.
   * Mantine Select renders a clear (CloseButton) in [data-position="right"] when a value is set.
   */
  async clearReferenceField(fieldName: string): Promise<void> {
    const field = this.getReferenceField(fieldName)
    // The clear button lives in the input's right section
    const clearButton = field.locator('[data-position="right"] button')
    await clearButton.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
    await clearButton.click()
  }
}
