import { test, expect, type Page } from '@playwright/test'
import { DEV_ADMIN_USER_ID } from 'canopycms-auth-dev'
import { EditorPage } from '../fixtures/editor-page'
import { AdminPage } from '../fixtures/admin-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import {
  resetWorkspace,
  ensureMainBranch,
  createBranchViaAPI,
  submitBranchViaAPI,
  approveBranchViaAPI,
} from '../fixtures/test-workspace'
import {
  seedCorruptBranchDir,
  seedOrphanBranchDir,
  patchBranchMetadata,
  readBranchMetadata,
  findTrashDirFor,
  listBranchMetaFiles,
  TRASH_NAME_RE,
  CORRUPT_ARCHIVE_RE,
} from '../fixtures/admin-workspace'

const BASE_URL = 'http://localhost:5174'

/** Navigate to the editor, open System health, and land on the loaded Branches tab. */
async function openBranchesTab(page: Page): Promise<AdminPage> {
  const editorPage = new EditorPage(page)
  await editorPage.goto()
  await editorPage.waitForReady()
  const adminPage = new AdminPage(page)
  await adminPage.open()
  await adminPage.selectTab('Branches')
  await adminPage.waitForBranchHealth()
  return adminPage
}

/**
 * Force a full re-fetch of branch health mid-test. `useSystemHealth`'s data
 * lives outside the Modal (in SystemHealthPanel, which stays mounted while
 * the editor is open), so closing/reopening the panel re-runs its
 * load-on-open effect without a real page navigation -- the same mechanism
 * `AdminPage.refreshOverview` uses for the Overview tab, generalized here
 * since Tasks/Branches have no dedicated refresh button of their own.
 */
async function refreshBranchesTab(adminPage: AdminPage): Promise<void> {
  await adminPage.close()
  await adminPage.open()
  await adminPage.selectTab('Branches')
  await adminPage.waitForBranchHealth()
}

/**
 * The dirName the server currently considers `isBaseBranch`.
 *
 * NOT necessarily `'main'`: dev mode's effective base branch is
 * `config.defaultBaseBranch ?? 'main'`, and `defaultBaseBranch` is left unset
 * in the test app, so on a checkout whose git HEAD branch isn't literally
 * named `main` (true for this very worktree, e.g. `test/e2e-coverage-sweep`)
 * the server auto-provisions a SEPARATE sanitized-git-branch-named directory
 * and flags THAT one `isBaseBranch`, while the fixtures' own `main` content
 * branch (created explicitly by `ensureMainBranch`) stays a perfectly healthy
 * but non-base branch. Asserting the "base" badge must therefore look up
 * whichever entry the scan actually flagged, not assume the literal name.
 */
async function getBaseBranchDirName(page: Page): Promise<string> {
  const res = await page.request.get('/api/canopycms/admin/branch-health', {
    headers: { 'X-Test-User': 'admin' },
  })
  const body = (await res.json()) as {
    data: { entries: { dirName: string; isBaseBranch?: boolean }[] }
  }
  const baseEntry = body.data.entries.find((e) => e.isBaseBranch)
  if (!baseEntry) {
    throw new Error('branch-health scan reported no isBaseBranch entry')
  }
  return baseEntry.dirName
}

test.describe('Admin Branch Health', () => {
  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('lists the base branch and a healthy created branch', async ({ page }) => {
    const branchName = `healthy-${Date.now()}`
    await createBranchViaAPI(BASE_URL, branchName, 'admin')

    const adminPage = await openBranchesTab(page)

    const mainRow = adminPage.branchRow('main')
    await expect(mainRow).toBeVisible()
    await expect(mainRow).toContainText('editing')

    const baseDirName = await getBaseBranchDirName(page)
    const baseRow = adminPage.branchRow(baseDirName)
    await expect(baseRow).toBeVisible()
    await expect(baseRow.getByText('base')).toBeVisible()

    const branchRow = adminPage.branchRow(branchName)
    await expect(branchRow).toBeVisible()
    await expect(branchRow).toContainText('editing')
  })

  test('corrupt metadata repairs to editing/current-admin; registry quarantines it in the meantime (B9)', async ({
    page,
  }) => {
    const dirName = `broken-${Date.now()}`
    await seedCorruptBranchDir(dirName)

    const adminPage = await openBranchesTab(page)
    await expect(adminPage.branchRow(dirName)).toContainText('corrupt metadata')

    await test.step('B9: GET /branches still 200s and lists main despite the corrupt dir', async () => {
      const res = await page.request.get('/api/canopycms/branches', {
        headers: { 'X-Test-User': 'admin' },
      })
      expect(res.status()).toBe(200)
      const body = (await res.json()) as { data: { branches: { name: string }[] } }
      expect(body.data.branches.map((b) => b.name)).toContain('main')
    })

    await adminPage.repairDirButton(dirName).click()
    await adminPage.confirmDialog('Repair metadata', 'Repair')

    await expect
      .poll(async () =>
        (await listBranchMetaFiles(dirName)).some((f) => CORRUPT_ARCHIVE_RE.test(f)),
      )
      .toBe(true)

    const meta = await readBranchMetadata(dirName)
    expect(meta.status).toBe('editing')
    // NOT the fixture's 'test-admin' label from test-users.ts (TEST_USERS is
    // decorative there) -- the dev auth plugin actually maps the 'admin' test
    // key to DEV_ADMIN_USER_ID ('dev_admin_3xY6zW1qR5'), and that's the id
    // repairBranchDirHandler stamps as createdBy (req.user.userId).
    expect(meta.createdBy).toBe(DEV_ADMIN_USER_ID)
  })

  test('orphan directory purges to trash; retention is keyed off the NAME stamp, not mtime', async ({
    page,
  }) => {
    const dirName = `orphan-${Date.now()}`
    // Older than the 15-min young-orphan rail so purge is actually allowed.
    await seedOrphanBranchDir(dirName, 20 * 60_000)

    const adminPage = await openBranchesTab(page)
    await expect(adminPage.branchRow(dirName)).toContainText('orphan')

    await adminPage.purgeDirButton(dirName).click()
    await adminPage.confirmDialog('Purge directory', 'Purge')

    await expect.poll(() => findTrashDirFor(dirName)).not.toBeNull()
    const trashName = await findTrashDirFor(dirName)

    // CRITICAL INVARIANT: retention is computed by parsing the STAMP IN THE
    // NAME, never from the directory's mtime. rename() preserves the original
    // mtime -- this directory's mtime was backdated 20 minutes above, so an
    // mtime-based sweep would already see this trash as 20 minutes into its
    // life the instant it's created (or read it as pre-dating the purge
    // entirely). The name's stamp must instead read as "now".
    const match = TRASH_NAME_RE.exec(trashName as string)
    expect(match).not.toBeNull()
    const stamp = match![2] // YYYYMMDDTHHMMSSZ
    const parsed = new Date(
      `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T` +
        `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
    )
    expect(Math.abs(Date.now() - parsed.getTime())).toBeLessThan(5 * 60_000)
  })

  test('a fresh orphan cannot be purged yet (young-orphan rail)', async ({ page }) => {
    const dirName = `orphan-fresh-${Date.now()}`
    await seedOrphanBranchDir(dirName, 0)

    const adminPage = await openBranchesTab(page)
    const purgeButton = adminPage.purgeDirButton(dirName)
    await expect(purgeButton).toBeDisabled()

    await purgeButton.hover()
    await expect(page.getByText('May be a clone in progress')).toBeVisible()
  })

  test('the base branch row never offers an enabled Purge control', async ({ page }) => {
    const adminPage = await openBranchesTab(page)
    const baseDirName = await getBaseBranchDirName(page)
    await expect(adminPage.branchRow(baseDirName)).toContainText('base')
    // A healthy row (which the base branch is, absent injected corruption)
    // renders no Purge control at all -- purgeGateFor's isBaseBranch rail
    // only fires for corrupt-metadata/orphan rows. Either way, the base
    // branch can never be purged from this UI, which is what this asserts
    // without corrupting a shared workspace other specs depend on.
    await expect(adminPage.purgeDirButton(baseDirName)).toHaveCount(0)
  })

  test('rebase-failure indicator shows while editing, suppressed once submitted (A13)', async ({
    page,
  }) => {
    const branchName = `rebase-fail-${Date.now()}`
    await createBranchViaAPI(BASE_URL, branchName, 'admin')

    const now = new Date().toISOString()
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    await patchBranchMetadata(branchName, {
      rebaseFailure: { message: 'could not apply abc123', firstAt: twoHoursAgo, lastAt: now },
    })

    const adminPage = await openBranchesTab(page)
    await expect(adminPage.rebaseFailureIcon(branchName)).toBeVisible()

    await test.step('suppressed once the branch is submitted', async () => {
      await patchBranchMetadata(branchName, { status: 'submitted' })
      await refreshBranchesTab(adminPage)
      await expect(adminPage.rebaseFailureIcon(branchName)).toHaveCount(0)
    })
  })

  test('mark-merged is offered and works from approved, not just submitted (A14)', async ({
    page,
  }) => {
    const branchName = `merge-approved-${Date.now()}`
    await createBranchViaAPI(BASE_URL, branchName, 'admin')
    const submitRes = await submitBranchViaAPI(BASE_URL, branchName, 'admin')
    expect(submitRes.ok).toBe(true)
    const approveRes = await approveBranchViaAPI(BASE_URL, branchName, 'admin')
    expect(approveRes.ok).toBe(true)
    await patchBranchMetadata(branchName, { pullRequestNumber: 42 })

    const adminPage = await openBranchesTab(page)
    const markMergedButton = adminPage.markMergedButton(branchName)
    await expect(markMergedButton).toBeEnabled()

    await markMergedButton.click()
    await adminPage.confirmDialog('Mark branch as merged', 'Mark merged')

    // Before commit c101cde this button rendered for 'approved' branches too,
    // but the server only accepted 'submitted' and 400'd -- this is that
    // regression, end to end.
    await expect.poll(async () => (await readBranchMetadata(branchName)).status).toBe('archived')
  })
})
