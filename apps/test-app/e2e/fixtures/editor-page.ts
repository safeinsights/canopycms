import { type FrameLocator, type Page, type Locator, expect } from '@playwright/test'
import { SHORT_TIMEOUT, STANDARD_TIMEOUT, LONG_TIMEOUT } from './timeouts'
import { BranchPage } from './branch-page'

/** Entries of the rail's Settings menu, named for what they open. */
export type SettingsItem = 'Groups' | 'Permissions' | 'Media library' | 'System health'

const SETTINGS_ITEM_TEST_IDS: Record<SettingsItem, string> = {
  Groups: 'settings-menu-groups',
  Permissions: 'settings-menu-permissions',
  'Media library': 'settings-menu-media-library',
  'System health': 'settings-menu-system-health',
}

/** The navigator derives its per-node test ids from the node label this way. */
const navigatorTestIdSuffix = (label: string): string => label.toLowerCase().replace(/\s+/g, '-')

/**
 * Page object for the CanopyCMS Editor.
 * Provides methods for common editor interactions in E2E tests.
 *
 * The editor `data-testid`s this class and the other page objects use are the e2e contract: a UI
 * change that renames or removes one does so deliberately and updates the page object in the same
 * PR. Specs reach editor chrome (header, rail, navigator, comments, toasts) only through page
 * objects.
 */
export class EditorPage {
  readonly page: Page

  // Panes
  readonly formPane: Locator
  readonly previewPane: Locator

  // Header elements
  readonly saveButton: Locator
  private readonly fileDropdownButton: Locator
  private readonly allFilesMenuItem: Locator

  /** The entry navigator (a drawer): the tree of collections and entries. */
  readonly contentNavigator: Locator

  constructor(page: Page) {
    this.page = page

    // Panes
    this.formPane = page.locator('[data-testid="form-pane"]')
    this.previewPane = page.locator('[data-testid="preview-pane"]')

    // Header elements
    this.fileDropdownButton = page.locator('[data-testid="file-dropdown-button"]')
    this.saveButton = page.locator('[data-testid="save-button"]')
    this.allFilesMenuItem = page.locator('[data-testid="all-files-menu-item"]')

    this.contentNavigator = page.locator('[data-testid="entry-navigator"]')
  }

  /**
   * The previewed site page inside the preview pane.
   */
  previewFrame(): FrameLocator {
    return this.page.frameLocator('[data-testid="preview-pane"] iframe')
  }

  /**
   * Navigate to the editor page.
   */
  async goto(): Promise<void> {
    // Pin the editor to the 'main' content branch. Without the param the
    // editor adopts the server's defaultBranch, which dev mode derives from
    // the *git* HEAD of the checkout running the dev server — so edits would
    // land on a git-branch-named content branch while the fixtures read
    // .canopy-dev/content-branches/main/. See e2e/E2E-FAILURE-ANALYSIS.md.
    await this.page.goto('/edit?branch=main')
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
   * Open the content navigator via the header's file menu.
   */
  async openContentNavigator(): Promise<void> {
    await this.fileDropdownButton.click()
    await this.allFilesMenuItem.click()
    await this.contentNavigator.waitFor({
      state: 'visible',
      timeout: STANDARD_TIMEOUT,
    })
  }

  /**
   * Close the content navigator so the form pane is interactive.
   */
  async closeContentNavigator(): Promise<void> {
    await this.page.keyboard.press('Escape')
    await expect(this.contentNavigator).not.toBeVisible({ timeout: STANDARD_TIMEOUT })
  }

  /**
   * The navigator row for a collection or entry, by its display label.
   */
  navigatorItem(label: string): Locator {
    return this.contentNavigator.locator(
      `[data-testid="entry-nav-item-${navigatorTestIdSuffix(label)}"]`,
    )
  }

  /**
   * Every node (collection or entry) in the navigator tree, in display order.
   */
  navigatorNodes(): Locator {
    return this.contentNavigator.locator('[role="treeitem"]')
  }

  /**
   * The navigator's markers on entries whose content conflicts with the base branch.
   */
  navigatorConflictBadges(): Locator {
    return this.contentNavigator.locator('[data-testid="conflict-badge"]')
  }

  /**
   * Expand or collapse a collection in the navigator.
   */
  async toggleCollection(label: string): Promise<void> {
    await this.navigatorItem(label).click()
  }

  /**
   * Select an entry by its label in the navigator tree.
   * @param label - The display label of the entry to select
   */
  async selectEntry(label: string): Promise<void> {
    const entry = this.navigatorItem(label)
    await entry.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })

    await entry.click()

    // Wait for the editor to show the selected entry (condition-based, no blind wait)
    await expect(this.currentEntryLabel()).toContainText(label, {
      timeout: STANDARD_TIMEOUT,
    })
  }

  /**
   * What the editor shows as the open entry.
   */
  currentEntryLabel(): Locator {
    return this.fileDropdownButton
  }

  /**
   * Create an entry in a collection through the navigator, and wait for the create modal to close.
   * The navigator must be open.
   * @param collection - The collection's display label, e.g. 'Posts'
   * @param slug - The new entry's slug
   */
  async createEntry(collection: string, slug: string): Promise<void> {
    await this.openCollectionMenu(collection, 'add-entry-menu-item')

    const modal = this.page.locator('[data-testid="create-entry-modal"]')
    await expect(modal).toBeVisible()
    await this.page.locator('[data-testid="entry-slug-input"]').fill(slug)
    await this.page.locator('[data-testid="create-entry-submit"]').click()
    // Entry creation involves server-side file writes
    await expect(modal).not.toBeVisible({ timeout: LONG_TIMEOUT })
  }

  /**
   * Rename an entry's slug through the navigator, and wait for the rename modal to close.
   * The navigator must be open.
   * @param entryLabel - The entry's display label (a rename changes the slug, not the label)
   * @param newSlug - The new slug
   */
  async renameEntry(entryLabel: string, newSlug: string): Promise<void> {
    await this.openEntryMenu(entryLabel, 'rename-entry-menu-item')

    const modal = this.page.locator('[data-testid="rename-entry-modal"]')
    await expect(modal).toBeVisible()
    // fill() replaces the pre-filled current slug
    await this.page.locator('[data-testid="rename-slug-input"]').fill(newSlug)
    await this.page.locator('[data-testid="rename-entry-submit"]').click()
    await expect(modal).not.toBeVisible({ timeout: LONG_TIMEOUT })
  }

  /**
   * Start deleting an entry through the navigator and return its confirmation dialog, visible.
   * The navigator must be open.
   */
  async startDeleteEntry(entryLabel: string): Promise<Locator> {
    await this.openEntryMenu(entryLabel, 'delete-entry-menu-item')
    const modal = this.page.locator('[data-testid="confirm-delete-modal"]')
    await expect(modal).toBeVisible()
    return modal
  }

  /**
   * The delete dialog's confirm button. Its label changes to "Delete anyway" once the dialog has
   * listed the entries that reference the one being deleted.
   */
  deleteConfirmButton(): Locator {
    return this.page.locator('[data-testid="confirm-delete-submit"]')
  }

  /**
   * Delete an entry through the navigator, confirming the dialog, and wait for it to close.
   * The navigator must be open.
   */
  async deleteEntry(entryLabel: string): Promise<void> {
    const modal = await this.startDeleteEntry(entryLabel)
    await this.deleteConfirmButton().click()
    await expect(modal).not.toBeVisible({ timeout: LONG_TIMEOUT })
  }

  private async openCollectionMenu(collection: string, itemTestId: string): Promise<void> {
    const menu = this.page.locator(
      `[data-testid="collection-menu-${navigatorTestIdSuffix(collection)}"]`,
    )
    await menu.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
    await menu.click()
    const item = this.page.locator(`[data-testid="${itemTestId}"]`)
    await item.waitFor({ state: 'visible', timeout: SHORT_TIMEOUT })
    await item.click()
  }

  private async openEntryMenu(entryLabel: string, itemTestId: string): Promise<void> {
    const menu = this.page.locator(
      `[data-testid="entry-menu-${navigatorTestIdSuffix(entryLabel)}"]`,
    )
    await menu.waitFor({ state: 'visible', timeout: SHORT_TIMEOUT })
    await menu.click()
    const item = this.page.locator(`[data-testid="${itemTestId}"]`)
    await item.waitFor({ state: 'visible', timeout: SHORT_TIMEOUT })
    await item.click()
  }

  /**
   * Open the header's file menu and discard the open entry's unsaved draft. Returns the
   * confirmation dialog; finish with {@link confirmDiscard}.
   */
  async discardEntryDraft(): Promise<Locator> {
    await this.fileDropdownButton.click()
    const item = this.page.locator('[data-testid="discard-file-draft-menu-item"]')
    await item.waitFor({ state: 'visible', timeout: SHORT_TIMEOUT })
    await item.click()
    return this.page.getByRole('dialog', { name: 'Discard draft' })
  }

  /**
   * Open the branch menu and discard every unsaved file draft. Returns the confirmation dialog;
   * finish with {@link confirmDiscard}.
   */
  async discardAllDrafts(): Promise<Locator> {
    await new BranchPage(this.page).openBranchMenu()
    await this.page.locator('[data-testid="discard-all-drafts-menu-item"]').click()
    return this.page.getByRole('dialog', { name: 'Discard drafts' })
  }

  /**
   * Confirm a discard dialog returned by {@link discardEntryDraft} or {@link discardAllDrafts}.
   */
  async confirmDiscard(dialog: Locator): Promise<void> {
    await dialog.getByRole('button', { name: 'Discard', exact: true }).click()
  }

  /**
   * The banner shown while the branch's content is locked: by a workflow status such as submitted,
   * or until the branch's details load.
   */
  statusLockedBanner(): Locator {
    return this.page.locator('[data-testid="status-locked-banner"]')
  }

  /**
   * A toast notification containing the given text.
   */
  notification(text: string | RegExp): Locator {
    return this.page.locator('.mantine-Notification-root', { hasText: text })
  }

  /**
   * Open the comments panel from the header.
   */
  async openComments(): Promise<void> {
    const button = this.page.locator('[data-testid="comments-button"]')
    await button.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
    await button.click()
  }

  /**
   * Close the comments panel.
   */
  async closeComments(): Promise<void> {
    await this.page.keyboard.press('Escape')
  }

  /**
   * Add a branch-level comment in the open comments panel.
   */
  async addBranchComment(text: string): Promise<void> {
    const textarea = this.branchCommentDraft()
    await textarea.waitFor({ state: 'visible', timeout: SHORT_TIMEOUT })
    await textarea.fill(text)
    await this.page.locator('[data-testid="comment-submit"]').click()
  }

  /**
   * The comments panel's new-comment text box.
   */
  branchCommentDraft(): Locator {
    return this.page.locator('[data-testid="comment-textarea"]')
  }

  /**
   * The threads listed in the comments panel.
   */
  branchCommentThreads(): Locator {
    return this.page.locator('[data-testid="comment-thread"]')
  }

  /**
   * Begin a new comment thread on a form field.
   * @param field - The field's data-canopy-field path
   */
  async startFieldComment(field: string): Promise<void> {
    const trigger = this.page.locator(`[data-testid="field-new-comment-${field}"]`)
    await trigger.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
    await trigger.click()
  }

  /**
   * Fill and create the field comment thread started by {@link startFieldComment}.
   */
  async submitFieldComment(text: string): Promise<void> {
    const textarea = this.page.locator('[data-testid="new-thread-textarea"]')
    await textarea.waitFor({ state: 'visible', timeout: SHORT_TIMEOUT })
    await textarea.fill(text)
    await this.page.locator('[data-testid="create-thread-button"]').click()
  }

  /**
   * The comment thread shown inline in the form.
   */
  fieldCommentThread(): Locator {
    return this.page.locator('[data-testid="inline-comment-thread"]')
  }

  /**
   * The control that resolves a comment thread; absent once the thread is resolved.
   */
  resolveThreadButton(): Locator {
    return this.page.locator('[data-testid="resolve-thread-button"]')
  }

  /**
   * Resolve the inline comment thread.
   */
  async resolveFieldComment(): Promise<void> {
    const button = this.resolveThreadButton()
    await button.waitFor({ state: 'visible', timeout: SHORT_TIMEOUT })
    await button.click()
  }

  /**
   * The rail's preview-highlights toggle; reflects its state in `aria-pressed`.
   */
  highlightToggle(): Locator {
    return this.page.locator('[data-testid="toggle-highlights-button"]')
  }

  /**
   * Switch preview highlights on or off.
   */
  async toggleHighlights(): Promise<void> {
    await this.highlightToggle().click()
  }

  /**
   * The notice shown when the previewed page marks no editable elements.
   */
  noEditableMarksNotice(): Locator {
    return this.page.getByText(/marks no editable elements/)
  }

  /**
   * Open the rail's Settings menu.
   */
  async openSettingsMenu(): Promise<void> {
    await this.page.locator('[data-testid="settings-button"]').click()
    await expect(this.page.locator('[data-testid="settings-menu"]')).toBeVisible({
      timeout: STANDARD_TIMEOUT,
    })
  }

  /**
   * A Settings menu entry. Only meaningful while the menu is open; "System health" is absent from
   * the DOM for non-admins.
   */
  settingsMenuItem(item: SettingsItem): Locator {
    return this.page.locator(`[data-testid="${SETTINGS_ITEM_TEST_IDS[item]}"]`)
  }

  /**
   * Open the Settings menu and choose an entry. The surface it opens is the caller's to wait for.
   */
  async openSettingsItem(item: SettingsItem): Promise<void> {
    await this.openSettingsMenu()
    await this.settingsMenuItem(item).click()
  }

  /**
   * Sign out through the dev auth user switcher.
   */
  async signOut(): Promise<void> {
    await this.page.locator('[data-testid="switch-user-button"]').click()
    await this.page.locator('[data-testid="sign-out-button"]').click()
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
   *
   * @deprecated Prefer {@link saveAndVerify}, which waits for the network PUT response
   * instead of the notification and is immune to stale notifications from prior saves.
   */
  async waitForSaveNotification(): Promise<void> {
    await expect(this.notification('Saved').first()).toBeVisible({ timeout: STANDARD_TIMEOUT })
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
    const options = await this.openReferenceOptions(fieldName)
    const option = options.filter({ hasText: optionLabel })
    await option.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
    await option.click()
  }

  /**
   * Open a reference field's dropdown and return the options in THAT dropdown. Every Select's
   * options stay in the DOM, so an unscoped option locator matches the same post listed by
   * another reference field.
   */
  async openReferenceOptions(fieldName: string): Promise<Locator> {
    // Mantine renders a hidden value input alongside the visible search input
    const input = this.getReferenceField(fieldName).locator('input:not([type="hidden"])')
    await input.click()
    await expect(input).toHaveAttribute('aria-controls', /.+/, { timeout: STANDARD_TIMEOUT })
    const listboxId = await input.getAttribute('aria-controls')
    return this.page.locator(`[id="${listboxId}"] [role="option"]`)
  }

  /**
   * Select multiple options in a multi-select reference field (Mantine MultiSelect).
   * @param fieldName - The data-canopy-field name
   * @param optionLabels - Array of visible labels to select
   */
  async selectMultiReferenceOptions(fieldName: string, optionLabels: string[]): Promise<void> {
    await this.waitForReferenceOptions(fieldName)
    for (const label of optionLabels) {
      const options = await this.openReferenceOptions(fieldName)
      const option = options.filter({ hasText: label })
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

  /**
   * Create a post entry in the Posts collection, fill its title, and save.
   * Leaves the navigator closed with the new post loaded in the form pane.
   *
   * Shared helper used by reference-fields and entry-links tests to avoid
   * duplicating the navigator → modal → expand → select → fill → save flow.
   */
  async createPost(slug: string, title: string): Promise<void> {
    await this.openContentNavigator()
    await this.createEntry('Posts', slug)

    // After creation the navigator is still open. Expand Posts if collapsed,
    // then click the new entry so it loads in the form pane.
    const postsCollection = this.navigatorItem('Posts')
    await postsCollection.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
    const navItem = this.navigatorItem('Post').last()
    if (!(await navItem.isVisible())) {
      await postsCollection.click()
    }
    await navItem.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
    await navItem.click()

    // Close navigator so form pane is interactive
    await this.closeContentNavigator()

    // Fill title and save so the entry has a recognisable label
    await this.fillTextField('title', title)
    await this.saveAndVerify()
  }
}
