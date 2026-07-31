import { BASE_URL } from '../fixtures/base-url'
import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { BranchPage, findProtectedBranch, sanitizeBranchName } from '../fixtures/branch-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { STANDARD_TIMEOUT } from '../fixtures/timeouts'
import {
  resetWorkspace,
  ensureMainBranch,
  createBranchViaAPI,
  submitBranchViaAPI,
  withdrawBranchViaAPI,
  approveBranchViaAPI,
  deleteBranchViaAPI,
} from '../fixtures/test-workspace'
import { patchBranchMetadata } from '../fixtures/admin-workspace'
import type { ContentId } from '../../../../packages/canopycms/src/paths/types'

/** The content id every branch cloned from the fixture repo carries (see conflict-management.spec.ts). */
const HOME_ENTRY_FILE = 'home.home.bo7QdSwn9Tod.json'

interface ApiErrorBody {
  ok: boolean
  status: number
  error?: string
}

/**
 * Branch State Badges E2E Tests.
 *
 * Covers branch-list surfaces shipped since 2026-04-12 that have zero prior
 * e2e coverage: sync status, conflict count, protected/merged badges, the
 * submitted-branch status lock, relative timestamps, and branch-name
 * sanitization. These are multi-editor / operator-facing surfaces with no
 * production fallback -- a regression here is unrecoverable in prod.
 */
test.describe('Branch State Badges', () => {
  let editorPage: EditorPage
  let branchPage: BranchPage

  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    branchPage = new BranchPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('sync badges: pending-sync and sync-failed render, absent on a fresh branch, visible to non-admins (B1/B2)', async ({
    page,
  }) => {
    const branchName = `sync-badge-${Date.now()}`

    await test.step('create branch as editor', async () => {
      const res = await createBranchViaAPI(BASE_URL, branchName, 'editor')
      expect(res.ok).toBe(true)
    })

    await test.step('fresh branch shows neither sync badge', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await branchPage.openBranchManager()
      await branchPage.waitForBranchInList(branchName)
      await expect(branchPage.getPendingSyncBadge(branchName)).not.toBeVisible()
      await expect(branchPage.getSyncFailedBadge(branchName)).not.toBeVisible()
      await branchPage.closeBranchManager()
    })

    await test.step('pending-sync badge renders "Syncing…"', async () => {
      await patchBranchMetadata(branchName, { syncStatus: 'pending-sync' })
      await page.reload()
      await editorPage.waitForReady()
      await branchPage.openBranchManager()
      await branchPage.waitForBranchInList(branchName)
      const badge = branchPage.getPendingSyncBadge(branchName)
      await expect(badge).toBeVisible()
      await expect(badge).toContainText('Syncing…')
      await expect(branchPage.getSyncFailedBadge(branchName)).not.toBeVisible()
      await branchPage.closeBranchManager()
    })

    await test.step('sync-failed badge renders "Sync failed"', async () => {
      await patchBranchMetadata(branchName, { syncStatus: 'sync-failed' })
      await page.reload()
      await editorPage.waitForReady()
      await branchPage.openBranchManager()
      await branchPage.waitForBranchInList(branchName)
      const badge = branchPage.getSyncFailedBadge(branchName)
      await expect(badge).toBeVisible()
      await expect(badge).toContainText('Sync failed')
      await expect(branchPage.getPendingSyncBadge(branchName)).not.toBeVisible()
      await branchPage.closeBranchManager()
    })

    await test.step('badge is visible to a non-admin (the branch creator)', async () => {
      await switchUser(page, 'editor')
      await page.reload()
      await editorPage.waitForReady()
      await branchPage.openBranchManager()
      await branchPage.waitForBranchInList(branchName)
      await expect(branchPage.getSyncFailedBadge(branchName)).toBeVisible()
    })
  })

  test('conflicts badge in the branch list shows the conflict count (B3)', async () => {
    const branchName = `conflicts-badge-${Date.now()}`

    await test.step('create branch and seed a conflict flag', async () => {
      const res = await createBranchViaAPI(BASE_URL, branchName, 'admin')
      expect(res.ok).toBe(true)
      await patchBranchMetadata(branchName, {
        conflictStatus: 'conflicts-detected',
        // conflictFiles is ContentId[] (a branded 12-char-base58 id, not a
        // full filename) -- the badge only ever reads .length to render the
        // count, so the exact values don't need to resolve to real entries.
        conflictFiles: [
          HOME_ENTRY_FILE,
          'posts.abc123/post.post.def456.json',
        ] as unknown as ContentId[],
      })
    })

    await test.step('branch list shows Conflicts (2)', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await branchPage.openBranchManager()
      await branchPage.waitForBranchInList(branchName)
      const badge = branchPage.getConflictsBadge(branchName)
      await expect(badge).toBeVisible()
      await expect(badge).toContainText('Conflicts (2)')
    })
  })

  test('protected badge and submit/delete rails on the base branch (B4)', async () => {
    const protectedBranch = await findProtectedBranch(BASE_URL, 'admin')

    await test.step('UI: protected badge visible, submit and delete disabled', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await branchPage.openBranchManager()
      await branchPage.waitForBranchInList(protectedBranch.name)

      await expect(branchPage.getProtectedBadge(protectedBranch.name)).toBeVisible()

      const submitDisabled = await branchPage.isActionButtonDisabled(protectedBranch.name, 'submit')
      expect(submitDisabled).toBe(true)

      const deleteDisabled = await branchPage.isActionButtonDisabled(protectedBranch.name, 'delete')
      expect(deleteDisabled).toBe(true)
    })

    await test.step('API: submit is refused with 403 and the base-branch message', async () => {
      // Not submitBranchViaAPI(): it consumes the response body via .text()
      // for its own failure logging, which would leave nothing for us to
      // read here ("Body is unusable: Body has already been read").
      const res = await fetch(`${BASE_URL}/api/canopycms/${protectedBranch.name}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Test-User': 'admin' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as ApiErrorBody
      expect(body.error).toContain('base branch cannot be submitted for review')
    })

    await test.step('API: delete is refused with 400', async () => {
      const res = await deleteBranchViaAPI(BASE_URL, protectedBranch.name, 'admin')
      expect(res.status).toBe(400)
      const body = (await res.json()) as ApiErrorBody
      expect(body.error).toBe('Cannot delete the base branch')
    })
  })

  test('status lock: submitted branch shows locked banner + disabled save; server 403s writes; withdraw restores editing (B6/B7)', async ({
    page,
  }) => {
    const branchName = `status-lock-${Date.now()}`

    await test.step('create branch and switch to it', async () => {
      const res = await createBranchViaAPI(BASE_URL, branchName, 'admin')
      expect(res.ok).toBe(true)

      await editorPage.goto()
      await editorPage.waitForReady()
      await branchPage.openBranchManager()
      await branchPage.switchToBranch(branchName)
      await branchPage.closeBranchManager()
    })

    await test.step('submit via API and reload', async () => {
      const res = await submitBranchViaAPI(BASE_URL, branchName, 'admin')
      expect(res.ok).toBe(true)
      await page.reload()
      await editorPage.waitForReady()
    })

    await test.step('status-locked banner is visible and save is disabled', async () => {
      const banner = page.locator('[data-testid="status-locked-banner"]')
      await expect(banner).toBeVisible()
      await expect(banner).toContainText(
        `Branch "${branchName}" is submitted for review and locked for edits`,
      )
      await expect(editorPage.saveButton).toBeDisabled()
    })

    await test.step('server: a content write is refused with 403', async () => {
      // The content API takes a LOGICAL path ("home"), not the physical
      // on-disk filename with its embedded content id (HOME_ENTRY_FILE) --
      // the latter 400s with "Path appears to be a physical path".
      const res = await fetch(`${BASE_URL}/api/canopycms/${branchName}/content/home`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Test-User': 'admin' },
        body: JSON.stringify({ format: 'json', data: {} }),
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as ApiErrorBody
      expect(body.error).toContain('Withdraw it or request changes')
    })

    await test.step('withdraw restores editing', async () => {
      const res = await withdrawBranchViaAPI(BASE_URL, branchName, 'admin')
      expect(res.ok).toBe(true)
      await page.reload()
      await editorPage.waitForReady()

      await expect(page.locator('[data-testid="status-locked-banner"]')).not.toBeVisible()
      // NOTE: save-button stays disabled right after reload regardless of
      // the status lock -- it's also gated on `hasUnsavedChanges` and
      // `currentEntry`, neither of which survives a reload (see
      // EditorHeader.tsx's `disabled` expression). So "restored" isn't
      // provable from the button's disabled state alone; prove it by
      // actually editing and saving below.

      // Prove editing genuinely works again, not just that the banner is gone.
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Home Page')
      await editorPage.fillTextField('title', `Restored-${Date.now()}`)
      await editorPage.saveAndVerify()
    })
  })

  test('merged badge appears once the branch is archived with a mergedAt (B8)', async () => {
    const branchName = `merged-badge-${Date.now()}`

    await test.step('create, submit, approve, then mark merged', async () => {
      const createRes = await createBranchViaAPI(BASE_URL, branchName, 'admin')
      expect(createRes.ok).toBe(true)
      const submitRes = await submitBranchViaAPI(BASE_URL, branchName, 'admin')
      expect(submitRes.ok).toBe(true)
      const approveRes = await approveBranchViaAPI(BASE_URL, branchName, 'admin')
      expect(approveRes.ok).toBe(true)

      await patchBranchMetadata(branchName, {
        status: 'archived',
        mergedAt: new Date().toISOString(),
        pullRequestNumber: 7,
      })
    })

    await test.step('branch list shows the Merged badge', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await branchPage.openBranchManager()
      await branchPage.waitForBranchInList(branchName)
      const badge = branchPage.getMergedBadge(branchName)
      await expect(badge).toBeVisible()
      await expect(badge).toContainText('Merged')
    })
  })

  test('approve transition is reflected in the branch list status badge (B14)', async () => {
    const branchName = `approve-flow-${Date.now()}`

    await test.step('create, submit, approve via API', async () => {
      const createRes = await createBranchViaAPI(BASE_URL, branchName, 'admin')
      expect(createRes.ok).toBe(true)
      const submitRes = await submitBranchViaAPI(BASE_URL, branchName, 'admin')
      expect(submitRes.ok).toBe(true)
      const approveRes = await approveBranchViaAPI(BASE_URL, branchName, 'admin')
      expect(approveRes.ok).toBe(true)
    })

    await test.step('branch list reflects approved status', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await branchPage.openBranchManager()
      await branchPage.waitForBranchInList(branchName)
      await branchPage.verifyBranchStatus(branchName, 'approved')
    })
  })

  test('branch row renders a relative "Updated" timestamp with an absolute-time tooltip (B11)', async ({
    page,
  }) => {
    const branchName = `relative-time-${Date.now()}`
    const res = await createBranchViaAPI(BASE_URL, branchName, 'admin')
    expect(res.ok).toBe(true)

    await editorPage.goto()
    await editorPage.waitForReady()
    await branchPage.openBranchManager()
    await branchPage.waitForBranchInList(branchName)

    const updatedText = branchPage.getBranchUpdatedText(branchName)
    await expect(updatedText).toBeVisible()
    await expect(updatedText).toHaveText(/Updated .*(ago|now)/i)
    const relativeLabel = (await updatedText.textContent()) ?? ''

    // formatRelativeTime's Tooltip wraps the text in a Mantine Tooltip
    // showing `new Date(updatedAt).toLocaleString()` -- hover to reveal it.
    await updatedText.hover()
    const tooltip = page.getByRole('tooltip')
    await expect(tooltip).toBeVisible({ timeout: STANDARD_TIMEOUT })
    const tooltipText = (await tooltip.textContent()) ?? ''
    expect(tooltipText.length).toBeGreaterThan(0)
    expect(tooltipText).not.toBe(relativeLabel)
    // A locale date/time string always contains digits; the relative label
    // ("just now", "Xm ago") never does at the "just now" instant this test
    // runs at, so this also guards against the tooltip silently rendering
    // the same relative text instead of an absolute one.
    expect(tooltipText).toMatch(/\d/)
  })

  test('sanitized branch name is adopted after creating via the UI with an unsafe raw name (B12)', async () => {
    // A slash is a valid git branch-name character (git itself uses
    // "feature/x" style names) but not a valid filesystem directory-name
    // character, so the server sanitizes it to a hyphen for the on-disk
    // directory / persisted branch.name. NOTE: a space would NOT work here
    // -- branchNameSchema (api/validators.ts -> parseBranchName) rejects
    // spaces outright with a 400 ("Branch name cannot contain spaces")
    // before sanitization ever runs, confirmed against the running dev
    // server; only the create-branch REQUEST would fail, never reaching the
    // sanitize-and-adopt path this test exercises.
    const rawName = `feature/My-Branch-${Date.now()}`
    const sanitized = sanitizeBranchName(rawName)
    expect(sanitized).not.toBe(rawName)

    await editorPage.goto()
    await editorPage.waitForReady()
    await branchPage.openBranchManager()
    await branchPage.createBranch(rawName)

    await test.step('branch list shows the sanitized name, not the raw one', async () => {
      await branchPage.waitForBranchInList(sanitized)
      await expect(branchPage.getBranchListItem(rawName)).toHaveCount(0)
    })

    await test.step('switching to the sanitized branch works', async () => {
      await branchPage.switchToBranch(sanitized)
    })
  })
})
