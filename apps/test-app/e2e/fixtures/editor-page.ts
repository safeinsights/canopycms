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

  /**
   * Get a list field locator by its field name.
   * @param fieldName - The field name
   */
  getListField(fieldName: string): Locator {
    return this.formPane.locator(`[data-testid="list-field-${fieldName}"]`)
  }

  /**
   * Add an item to a list field.
   * @param fieldName - The field name
   * @param value - The value to add
   */
  async addListItem(fieldName: string, value: string): Promise<void> {
    const addButton = this.formPane.locator(`[data-testid="add-list-item-${fieldName}"]`)
    await addButton.click()

    // Find the newly added input (usually the last one)
    const listField = this.getListField(fieldName)
    const inputs = listField.locator('input')
    const count = await inputs.count()
    const newInput = inputs.nth(count - 1)
    await newInput.fill(value)
  }

  /**
   * Remove an item from a list field by index.
   * @param fieldName - The field name
   * @param index - The index of the item to remove (0-based)
   */
  async removeListItem(fieldName: string, index: number): Promise<void> {
    const removeButton = this.formPane.locator(
      `[data-testid="remove-list-item-${fieldName}-${index}"]`,
    )
    await removeButton.click()
  }

  /**
   * Fill a list field with multiple values.
   * @param fieldName - The field name
   * @param values - Array of values to set
   */
  async fillListField(fieldName: string, values: string[]): Promise<void> {
    // Clear existing items first (implementation depends on UI)
    // For now, assume we can just add items
    for (const value of values) {
      await this.addListItem(fieldName, value)
    }
  }

  /**
   * Toggle a boolean field.
   * @param fieldName - The field name
   */
  async toggleBooleanField(fieldName: string): Promise<void> {
    const toggle = this.formPane.locator(`[data-testid="toggle-field-${fieldName}"]`)
    await toggle.click()
  }

  /**
   * Select a value from a dropdown/select field.
   * @param fieldName - The field name
   * @param value - The value to select
   */
  async selectDropdownValue(fieldName: string, value: string): Promise<void> {
    const select = this.formPane.locator(`[data-testid="select-field-${fieldName}"]`)
    await select.click()

    // Wait for dropdown options to appear
    await this.page.waitForTimeout(300)

    // Select the option (implementation may vary)
    const option = this.page.locator(`[data-value="${value}"]`)
    await option.click()
  }

  /**
   * Fill a nested field within an object field.
   * @param fieldName - The object field name
   * @param nestedFieldName - The nested field name
   * @param value - The value to set
   */
  async fillObjectField(fieldName: string, nestedFieldName: string, value: string): Promise<void> {
    const objectField = this.formPane.locator(`[data-testid="object-field-${fieldName}"]`)
    const nestedInput = objectField.locator(`[data-canopy-field="${nestedFieldName}"]`)
    await nestedInput.fill(value)
  }

  /**
   * Verify a validation error message is displayed for a field.
   * @param fieldName - The field name
   * @param expectedMessage - Expected error message (optional, if not provided just checks for presence)
   */
  async verifyValidationError(fieldName: string, expectedMessage?: string): Promise<void> {
    const errorLocator = this.formPane.locator(`[data-testid="field-error-${fieldName}"]`)
    await expect(errorLocator).toBeVisible({ timeout: 5000 })

    if (expectedMessage) {
      await expect(errorLocator).toContainText(expectedMessage)
    }
  }

  /**
   * Wait for the preview pane to update with specific content.
   * @param expectedContent - Text that should appear in the preview
   */
  async waitForPreviewUpdate(expectedContent: string): Promise<void> {
    await expect(this.previewPane.locator(`text="${expectedContent}"`)).toBeVisible({
      timeout: 10000,
    })
  }

  /**
   * Get the discard draft button locator.
   */
  get discardButton(): Locator {
    return this.page.locator('[data-testid="discard-button"]')
  }

  /**
   * Discard the current draft changes.
   */
  async discardDraft(): Promise<void> {
    await this.discardButton.click()

    // Handle confirmation dialog if present
    const confirmButton = this.page.locator('[data-testid="confirm-discard"]')
    if (await confirmButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmButton.click()
    }

    await this.page.waitForTimeout(500)
  }

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
}
