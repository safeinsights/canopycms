import { BASE_URL } from '../fixtures/base-url'
import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { EditorPage } from '../fixtures/editor-page'
import { AdminPage } from '../fixtures/admin-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'
import {
  seedTask,
  seedCorruptTaskFile,
  seedWorkerLock,
  seedWorkerStatus,
  seedUnparseableWorkerStatus,
} from '../fixtures/admin-workspace'

/**
 * Navigate to the editor and open the System health panel (Settings ->
 * System health). Shared by every test below since each needs its own fresh
 * navigation -- the panel's data-loading hook lives outside the Modal, so
 * closing/reopening (not a fresh page load) is the right way to force a
 * re-fetch mid-test; see `AdminPage.refreshOverview` for that path.
 */
async function openAdminPanel(page: Page): Promise<AdminPage> {
  const editorPage = new EditorPage(page)
  await editorPage.goto()
  await editorPage.waitForReady()
  const adminPage = new AdminPage(page)
  await adminPage.open()
  return adminPage
}

test.describe('Admin System Health Panel', () => {
  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('opens for an admin via Settings -> System health', async ({ page }) => {
    const adminPage = await openAdminPanel(page)
    await expect(adminPage.panel).toBeVisible()
    await expect(adminPage.workerBadge()).toBeVisible()
  })

  test('is inaccessible to non-admins: menu item absent, /admin/status 403s (A15)', async ({
    page,
  }) => {
    await test.step('switch to editor and reload', async () => {
      await switchUser(page, 'editor')
      const editorPage = new EditorPage(page)
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    await test.step('System health menu item is absent from the DOM entirely', async () => {
      const adminPage = new AdminPage(page)
      await adminPage.openSettingsMenu()
      await expect(adminPage.systemHealthMenuItem()).toHaveCount(0)
    })

    await test.step('the admin status endpoint 403s for an editor', async () => {
      const res = await page.request.get('/api/canopycms/admin/status', {
        headers: { 'X-Test-User': 'editor' },
      })
      expect(res.status()).toBe(403)
    })
  })

  test('worker liveness badge reflects heartbeat lock state', async ({ page }) => {
    const adminPage = await openAdminPanel(page)

    await test.step('no .worker-lock: absent', async () => {
      await expect(adminPage.workerBadge()).toHaveText('Worker: absent')
    })

    await test.step('fresh lock: alive', async () => {
      await seedWorkerLock(0)
      await adminPage.refreshOverview()
      await expect(adminPage.workerBadge()).toHaveText('Worker: alive')
    })

    await test.step('lock older than the 150s threshold (60s refresh + 90s EFS slack): stale', async () => {
      await seedWorkerLock(10 * 60_000)
      await adminPage.refreshOverview()
      await expect(adminPage.workerBadge()).toHaveText('Worker: stale')
    })
  })

  test('queue stat grid reflects seeded pending/failed/corrupt tasks', async ({ page }) => {
    await seedTask('pending', { id: randomUUID() })
    await seedTask('pending', { id: randomUUID() })
    await seedTask('failed', { id: randomUUID() })
    await seedCorruptTaskFile(`corrupt-${Date.now()}.json`, '{ not json')

    const adminPage = await openAdminPanel(page)

    // Anchored (not toContainText): "contains 2" would also pass for a tile
    // showing 12. The tile's text is the label immediately followed by the
    // count (capitalization is CSS-only, hence the /i).
    await expect(adminPage.queueStat('Pending')).toHaveText(/^Pending2$/i)
    await expect(adminPage.queueStat('Failed')).toHaveText(/^Failed1$/i)
    await expect(adminPage.queueStat('Corrupt')).toHaveText(/^Corrupt1$/i)
  })

  test('crash-loop alert respects the 30 minute window', async ({ page }) => {
    const recentAt = new Date().toISOString()
    await seedWorkerStatus({ lastFatalError: { message: 'boom', at: recentAt, phase: 'run' } })

    const adminPage = await openAdminPanel(page)

    await test.step('a fatal error inside the 30-min window shows the crash alert', async () => {
      await expect(adminPage.panel.getByText('Worker crash detected')).toBeVisible()
      await expect(adminPage.panel.getByText('boom')).toBeVisible()
    })

    await test.step('a fatal error 2 hours old is suppressed', async () => {
      const staleAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
      await seedWorkerStatus({ lastFatalError: { message: 'boom', at: staleAt, phase: 'run' } })
      await adminPage.refreshOverview()
      await expect(adminPage.panel.getByText('Worker crash detected')).toHaveCount(0)
    })
  })

  test('last-git-sync summary, failed-branch spoiler, and error-message display path', async ({
    page,
  }) => {
    const lastGitSyncAt = new Date().toISOString()
    // A17: redaction is enforced at the WRITE site, not the read/render path
    // -- the worker's recordRebaseFailure (worker/rebase.ts) and syncGit
    // (worker/git-sync.ts) run
    // `redactCredentials` on any git error message BEFORE it is persisted to
    // worker-status.json, and that transform is unit-tested there. This
    // fixture writes worker-status.json directly (no worker involved), so
    // seeding a raw credential-bearing string here would only prove "the
    // panel echoes whatever is on disk" -- not that redaction happened. To
    // keep this test honest we seed an ALREADY-redacted message and assert
    // only the display path: the panel renders it faithfully.
    const redactedMessage = 'https://***@github.com/o/r.git failed'
    await seedWorkerStatus({
      lastGitSyncAt,
      lastGitSyncError: { message: redactedMessage, at: lastGitSyncAt },
      lastGitSync: {
        durationMs: 1234,
        rebased: ['branch-a', 'branch-b'],
        skippedDirty: ['branch-c'],
        failed: [{ branch: 'feature-x', error: 'conflict in file.json' }],
      },
    })

    const adminPage = await openAdminPanel(page)

    await test.step('redacted git-sync error renders via the display path', async () => {
      await expect(adminPage.panel.getByText('Last git sync failed')).toBeVisible()
      await expect(adminPage.panel.getByText(redactedMessage)).toBeVisible()
    })

    await test.step('summary line reflects duration/rebased/skipped counts', async () => {
      await expect(adminPage.panel).toContainText('1234ms')
      await expect(adminPage.panel).toContainText('2 rebased')
      await expect(adminPage.panel).toContainText('1 skipped (dirty)')
    })

    await test.step('the failed-branch spoiler expands to show branch + error', async () => {
      await adminPage.panel.getByText('1 failed — show details').click()
      await expect(adminPage.panel.getByText('feature-x: conflict in file.json')).toBeVisible()
    })
  })

  test('unparseable worker-status.json shows a warning instead of erroring', async ({ page }) => {
    await seedUnparseableWorkerStatus()

    const adminPage = await openAdminPanel(page)

    await expect(adminPage.panel.getByText(/could not read worker status/)).toBeVisible()
    // The rest of the panel keeps working -- worker liveness comes from
    // .worker-lock, not worker-status.json, so it's unaffected.
    await expect(adminPage.workerBadge()).toBeVisible()
  })
})
