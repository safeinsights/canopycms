import { type Page, type Locator, expect } from '@playwright/test'
import { SHORT_TIMEOUT, STANDARD_TIMEOUT, LONG_TIMEOUT } from './timeouts'

/**
 * Page objects for the Group Manager and Permission Manager drawers
 * (Settings gear -> "Manage Groups" / "Manage Permissions").
 *
 * Unlike the media/admin surfaces, neither module carries `data-testid`
 * attributes on its interactive elements (see EditorSidebar.tsx,
 * group-manager/**, permission-manager/**) — every locator here goes
 * through `getByRole` / visible text, matching what a screen-reader user
 * would rely on. Selectors were confirmed against the component source,
 * not guessed:
 *  - Settings menu: `aria-label="Settings"` action icon; items are Mantine
 *    `Menu.Item`s (role="menuitem") with the exact labels below
 *    (EditorSidebar.tsx).
 *  - Both drawers are plain Mantine `<Drawer title={...}>` (not the
 *    compound Drawer.Root API used by the entry navigator), so the
 *    dialog's accessible name is the concatenation of the bold title and
 *    the dimmed description underneath it (Editor.tsx) — `getByRole`'s
 *    default substring match on just "Groups" / "Permissions" is
 *    deliberate, not a shortcut.
 *  - GroupForm's modal fields are real `<label>`-associated Mantine
 *    TextInput/Textarea ("Group Name" / "Description") — `getByLabel`.
 *  - PermissionEditor's group-search input is a raw `<input
 *    aria-label="Search groups">` (GroupSelector.tsx).
 */

const SETTINGS_BUTTON_NAME = 'Settings'

async function openSettingsMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: SETTINGS_BUTTON_NAME }).click()
}

export class GroupManagerPage {
  readonly page: Page
  readonly drawer: Locator

  constructor(page: Page) {
    this.page = page
    // Substring match: the dialog's accessible name is "Groups" + the
    // dimmed subtitle text concatenated (see module doc comment above).
    this.drawer = page.getByRole('dialog', { name: 'Groups' })
  }

  /** Open via Settings -> "Manage Groups" and wait for the drawer. */
  async open(): Promise<void> {
    await openSettingsMenu(this.page)
    await this.page.getByRole('menuitem', { name: 'Manage Groups' }).click()
    await expect(this.drawer).toBeVisible({ timeout: STANDARD_TIMEOUT })
  }

  async close(): Promise<void> {
    await this.page.keyboard.press('Escape')
    await expect(this.drawer).toBeHidden({ timeout: SHORT_TIMEOUT })
  }

  get createGroupButton(): Locator {
    return this.drawer.getByRole('button', { name: 'Create Group' })
  }

  get saveButton(): Locator {
    return this.drawer.getByRole('button', { name: 'Save Groups' })
  }

  get discardButton(): Locator {
    return this.drawer.getByRole('button', { name: 'Discard Changes' })
  }

  /** The (unique) group name text within the drawer's Internal Groups list. */
  groupEntry(name: string): Locator {
    return this.drawer.getByText(name, { exact: true })
  }

  /**
   * Fill and submit the "Create Group" modal. Leaves the modal closed and
   * the new group listed (but NOT yet saved to the server) in the Internal
   * Groups tab.
   */
  async createGroup(name: string, description: string): Promise<void> {
    await this.createGroupButton.click()
    const modal = this.page.getByRole('dialog', { name: 'Create Group' })
    await expect(modal).toBeVisible({ timeout: SHORT_TIMEOUT })
    await modal.getByLabel('Group Name').fill(name)
    await modal.getByLabel('Description').fill(description)
    await modal.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(modal).toBeHidden({ timeout: SHORT_TIMEOUT })
  }

  /** Click "Save Groups" and wait for the PUT to resolve (settings writes commit+push through a lock). */
  async saveAndVerify(): Promise<void> {
    await Promise.all([
      this.page.waitForResponse(
        (resp) =>
          resp.url().includes('/api/canopycms/groups/internal') &&
          resp.request().method() === 'PUT' &&
          resp.status() === 200,
        { timeout: LONG_TIMEOUT },
      ),
      this.saveButton.click(),
    ])
  }
}

export type PermissionLevelName = 'Read' | 'Edit' | 'Review'

export class PermissionManagerPage {
  readonly page: Page
  readonly drawer: Locator

  constructor(page: Page) {
    this.page = page
    // Substring match — see module doc comment.
    this.drawer = page.getByRole('dialog', { name: 'Permissions' })
  }

  /** Open via Settings -> "Manage Permissions" and wait for the drawer. */
  async open(): Promise<void> {
    await openSettingsMenu(this.page)
    await this.page.getByRole('menuitem', { name: 'Manage Permissions' }).click()
    await expect(this.drawer).toBeVisible({ timeout: STANDARD_TIMEOUT })
  }

  async close(): Promise<void> {
    await this.page.keyboard.press('Escape')
    await expect(this.drawer).toBeHidden({ timeout: SHORT_TIMEOUT })
  }

  /** Select a content-tree node by its visible label (e.g. "Posts"). */
  async selectNode(label: string): Promise<void> {
    await this.drawer.getByText(label, { exact: true }).click()
  }

  /**
   * Every tree node's PermissionEditor panel (tabs, "Add Groups" button,
   * etc.) is ALWAYS present in the DOM, not just the selected node's —
   * PermissionTree.tsx wraps each in `<Collapse in={isSelected}>` but never
   * unmounts it ("content stays in DOM for test accessibility", per its own
   * comment), and the collapsed copies are still a nonzero-size element as
   * far as Playwright's actionability/visibility checks are concerned (only
   * their zero-height *ancestor* clips them visually) — so a locator scoped
   * to `this.drawer` matches once PER NODE (e.g. once for "content", once
   * for "Posts") the moment more than one node exists.
   *
   * `.first()` is the correct fix, not a shortcut: `activeLevel` and the
   * group/user-search UI state (`useGroupsAndUsers`) are held ONCE in
   * PermissionManager and passed down identically to every node's
   * PermissionEditor, so clicking either copy of "Edit" or "Add Groups"
   * flips the same shared state. Which node's permission actually gets
   * mutated is governed entirely by `selectedNode` (set via `selectNode`
   * above) — the group-search results list itself is a REAL conditional
   * render (`showGroupSearch && isSelected && activeLevel === level` in
   * PermissionEditor.tsx), so it only ever exists for the truly-selected
   * node regardless of which button instance was clicked to open it.
   */
  levelTab(level: PermissionLevelName): Locator {
    return this.drawer.getByRole('tab', { name: level }).first()
  }

  get addGroupsButton(): Locator {
    return this.drawer.getByRole('button', { name: 'Add Groups' }).first()
  }

  get saveButton(): Locator {
    return this.drawer.getByRole('button', { name: 'Save Permissions' })
  }

  get discardButton(): Locator {
    return this.drawer.getByRole('button', { name: 'Discard Changes' })
  }

  /**
   * Assign a group (by its display label, e.g. "Team A") to the currently
   * selected node at the given level, via the "Add Groups" search panel.
   * Caller must have already selected a node.
   */
  async assignGroup(groupLabel: string, level: PermissionLevelName): Promise<void> {
    await this.levelTab(level).click()
    await this.addGroupsButton.click()
    await this.drawer.getByLabel('Search groups').fill(groupLabel)
    await this.drawer.getByText(groupLabel, { exact: true }).click()
  }

  /** Click "Save Permissions" and wait for the PUT to resolve. */
  async saveAndVerify(): Promise<void> {
    await Promise.all([
      this.page.waitForResponse(
        (resp) =>
          resp.url().includes('/api/canopycms/permissions') &&
          resp.request().method() === 'PUT' &&
          resp.status() === 200,
        { timeout: LONG_TIMEOUT },
      ),
      this.saveButton.click(),
    ])
  }
}

/**
 * Wipe all path permissions server-side via the API. Permissions live in a
 * dedicated settings workspace that `resetWorkspace()` never touches (it
 * only resets `content-branches/`), so they persist indefinitely across
 * test runs. Tests that assert on a specific path/level/group combination
 * call this first for a deterministic starting point — otherwise a group
 * already assigned from a previous run makes the "assign" step a no-op
 * (`handleAddGroup` skips `updateNodePermission` when the group is already
 * present), and the Save button never appears.
 */
export async function clearPermissionsViaApi(page: Page): Promise<void> {
  const getRes = await page.request.get('/api/canopycms/permissions', {
    headers: { 'X-Test-User': 'admin' },
  })
  if (!getRes.ok()) {
    throw new Error(`Failed to read permissions before clearing: ${getRes.status()}`)
  }
  const body = (await getRes.json()) as { data: { version: number } }
  const putRes = await page.request.put('/api/canopycms/permissions', {
    headers: { 'X-Test-User': 'admin' },
    data: { permissions: [], expectedContentVersion: body.data.version },
  })
  if (!putRes.ok()) {
    throw new Error(`Failed to clear permissions: ${putRes.status()}`)
  }
}
