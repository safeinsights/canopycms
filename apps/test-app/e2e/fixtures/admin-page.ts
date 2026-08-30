/**
 * Page object for the admin System health panel.
 *
 * The panel is the only in-product recovery surface for a stuck worker, a
 * poisoned task queue, or a corrupt branch directory — in production there is
 * no shell and no EFS access, so if these controls regress the failure is
 * unrecoverable without a redeploy.
 *
 * Selector strategy: the panel carries `data-testid` only on the per-entity
 * ACTION controls (retry/delete/repair/purge/mark-merged/rebase-failure), all
 * of which interpolate an id or directory name. Everything else — the modal,
 * the tabs, the status filter, the badges — is selected by role + visible
 * text, which is also what a screen-reader user would rely on.
 *
 * Mantine keeps a Modal's root wrapper in the DOM when closed, so open/closed
 * assertions go through `getByRole('dialog', { name })` rather than a testid
 * on the modal itself (see E2E-BACKLOG.md's gotcha list).
 */

import { expect, type Locator, type Page } from '@playwright/test'
import { STANDARD_TIMEOUT } from './timeouts'

/** Queue buckets selectable in the Tasks tab's segmented control. */
export type TaskFilter = 'Pending' | 'Processing' | 'Completed' | 'Failed' | 'Corrupt'

export class AdminPage {
  readonly page: Page
  /** The System health modal itself. */
  readonly panel: Locator

  constructor(page: Page) {
    this.page = page
    this.panel = page.getByRole('dialog', { name: 'System health' })
  }

  /** Open the sidebar Settings menu (gear icon). */
  async openSettingsMenu(): Promise<void> {
    await this.page.getByRole('button', { name: 'Settings' }).click()
    await expect(this.page.getByRole('menuitem', { name: 'Manage Groups' })).toBeVisible({
      timeout: STANDARD_TIMEOUT,
    })
  }

  /**
   * The "System health" menu item. Only rendered for admins — `Editor.tsx`
   * passes `onSystemHealthOpen` conditionally, so for a non-admin the item is
   * absent from the DOM entirely rather than merely disabled.
   */
  systemHealthMenuItem(): Locator {
    return this.page.getByRole('menuitem', { name: 'System health' })
  }

  /** Open Settings → System health and wait for the panel. */
  async open(): Promise<void> {
    await this.openSettingsMenu()
    await this.systemHealthMenuItem().click()
    await expect(this.panel).toBeVisible({ timeout: STANDARD_TIMEOUT })
  }

  async close(): Promise<void> {
    await this.page.keyboard.press('Escape')
    await expect(this.panel).toBeHidden({ timeout: STANDARD_TIMEOUT })
  }

  async selectTab(name: 'Overview' | 'Tasks' | 'Branches'): Promise<void> {
    await this.panel.getByRole('tab', { name }).click()
  }

  /** Click the Overview tab's Refresh button and wait for the reload to settle. */
  async refreshOverview(): Promise<void> {
    await this.panel.getByRole('button', { name: 'Refresh' }).click()
    await expect(this.panel.getByText('Loading status...')).toBeHidden({
      timeout: STANDARD_TIMEOUT,
    })
  }

  /**
   * The worker liveness badge. In dev mode (which is what this e2e app
   * runs) the component renders the plain `Worker: ${state}` — "Worker:
   * alive" / "Worker: stale" / "Worker: absent". The decorated prod labels
   * ("Worker: stale (possible crash)") never appear here; they stay
   * unit-tested (see workerLivenessBadge in SystemHealthPanel.tsx).
   */
  workerBadge(): Locator {
    return this.panel.getByText(/^Worker: /)
  }

  /**
   * A queue stat tile's count, located by its label (case-insensitive: the
   * component renders the lowercase status key as text and capitalizes it
   * purely via CSS `text-transform`, which Playwright's text matching does
   * not see — a case-sensitive regex here would never match).
   */
  queueStat(label: 'Pending' | 'Processing' | 'Completed' | 'Failed' | 'Corrupt'): Locator {
    // Each tile is a Paper containing the label and, below it, the count.
    // `label` is a five-member string-literal union, so the type system already
    // proves no attacker-chosen pattern can reach the constructor.
    return (
      this.panel
        .locator('div')
        // eslint-disable-next-line security/detect-non-literal-regexp
        .filter({ hasText: new RegExp(`^${label}\\d+$`, 'i') })
        .last()
    )
  }

  /** Switch the Tasks tab's status filter. */
  async selectTaskFilter(filter: TaskFilter): Promise<void> {
    await this.panel.getByText(filter, { exact: true }).click()
    await expect(this.panel.getByText('Loading tasks...')).toBeHidden({
      timeout: STANDARD_TIMEOUT,
    })
  }

  retryTaskButton(taskId: string): Locator {
    return this.panel.getByTestId(`retry-task-${taskId}`)
  }

  /**
   * Delete button for a task row. Normal rows key off the task id; corrupt
   * rows key off the raw file name (they have no parseable id).
   */
  deleteTaskButton(idOrFileName: string): Locator {
    return this.panel.getByTestId(`delete-task-${idOrFileName}`)
  }

  repairDirButton(dirName: string): Locator {
    return this.panel.getByTestId(`repair-dir-${dirName}`)
  }

  purgeDirButton(dirName: string): Locator {
    return this.panel.getByTestId(`purge-dir-${dirName}`)
  }

  markMergedButton(branchName: string): Locator {
    return this.panel.getByTestId(`mark-merged-${branchName}`)
  }

  /** The yellow "failing since" indicator on a branch-health row. */
  rebaseFailureIcon(dirName: string): Locator {
    return this.panel.getByTestId(`rebase-failure-${dirName}`)
  }

  /**
   * Confirm a `@mantine/modals` confirm dialog by its title and confirm-button
   * label. These dialogs stack above the panel, so they are located on the
   * page rather than inside `this.panel`.
   */
  async confirmDialog(title: string, confirmLabel: string): Promise<void> {
    const dialog = this.page.getByRole('dialog', { name: title })
    await expect(dialog).toBeVisible({ timeout: STANDARD_TIMEOUT })
    await dialog.getByRole('button', { name: confirmLabel, exact: true }).click()
    await expect(dialog).toBeHidden({ timeout: STANDARD_TIMEOUT })
  }

  /**
   * A branch-health row, located by the directory name in its first cell.
   * `has` + exact text (not `hasText`, which substring-matches the whole
   * row): with substring matching, `branchRow('main')` also matches any
   * environment's git-derived base-branch row whose sanitized name merely
   * CONTAINS "main" (e.g. a `fix/main-nav` checkout) — a strict-mode
   * violation that has nothing to do with the product.
   */
  branchRow(dirName: string): Locator {
    return this.panel
      .getByRole('row')
      .filter({ has: this.page.getByText(dirName, { exact: true }) })
  }

  /** Wait for the Branches tab's table to finish loading. */
  async waitForBranchHealth(): Promise<void> {
    await expect(this.panel.getByText('Loading branch health...')).toBeHidden({
      timeout: STANDARD_TIMEOUT,
    })
  }
}
