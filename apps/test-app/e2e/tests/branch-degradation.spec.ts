import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { BranchPage, findProtectedBranch } from '../fixtures/branch-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch, createBranchViaAPI } from '../fixtures/test-workspace'
import {
  seedCorruptBranchDir,
  getBranchesDir,
  bumpBranchRegistry,
} from '../fixtures/admin-workspace'

const BASE_URL = 'http://localhost:5174'

interface BranchListBody {
  data: { branches: { name: string; isProtected?: boolean }[] }
}

/**
 * Branch Degradation E2E Tests.
 *
 * Verifies the editor stays usable when the branch-clone filesystem is in a
 * partially-broken state -- a corrupt directory in the registry scan, or
 * corrupt metadata on the protected BASE branch itself. In production there
 * is no shell to fix this by hand, so these paths must degrade gracefully
 * (quarantine the bad directory / skip internal-groups loading) rather than
 * take down the whole editor. See branch-registry.ts's scanBranchDirectories
 * and http/handler.ts's BranchMetadataCorruptError handling.
 */
test.describe('Branch Degradation', () => {
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

  test('registry quarantine keeps the editor branch list working despite a corrupt directory (B9, UI angle)', async () => {
    const brokenDir = `broken-${Date.now()}`
    await seedCorruptBranchDir(brokenDir)

    await editorPage.goto()
    await editorPage.waitForReady()
    await branchPage.openBranchManager()

    await test.step('healthy branches still render', async () => {
      await branchPage.waitForBranchInList('main')
    })

    await test.step('the corrupt directory is quarantined out of the list, not crashing it', async () => {
      await expect(branchPage.getBranchListItem(brokenDir)).toHaveCount(0)
    })
  })

  test('editor stays usable for an editor-role user while a corrupt directory exists', async ({
    page,
  }) => {
    const brokenDir = `broken-editor-${Date.now()}`
    await seedCorruptBranchDir(brokenDir)

    await switchUser(page, 'editor')
    await editorPage.goto()
    await editorPage.waitForReady()

    // waitForReady() already proves form-pane + preview-pane rendered (it
    // waits on both locators) -- this is a belt-and-suspenders check that no
    // generic crash surface (error boundary / framework error page) leaked
    // through instead.
    await expect(page.getByText(/internal server error/i)).toHaveCount(0)
    await expect(page.getByText(/application error/i)).toHaveCount(0)
  })

  test('corrupt BASE branch metadata degrades instead of 503ing; other branches keep working (B10)', async ({
    page,
  }) => {
    test.setTimeout(60000)

    const protectedBranch = await findProtectedBranch(BASE_URL, 'admin')

    // A branch guaranteed healthy and DISTINCT from whatever this
    // environment's base branch happens to be. Locally the base branch is a
    // separate sanitized-git-branch-named directory (never the fixtures'
    // own `main`), but on CI (detached HEAD) the fallback base branch is
    // literally `main` -- so asserting against a freshly created branch
    // here, instead of hardcoding `main`, keeps this test meaningful and
    // deterministic in both environments rather than accidentally
    // corrupting -- and then asserting against -- the one branch every
    // other spec's fixtures depend on.
    const healthyBranchName = `b10-healthy-${Date.now()}`
    const createRes = await createBranchViaAPI(BASE_URL, healthyBranchName, 'admin')
    expect(createRes.ok).toBe(true)

    const metaPath = path.join(
      getBranchesDir(),
      protectedBranch.name,
      '.canopy-meta',
      'branch.json',
    )
    const originalBytes = await fs.readFile(metaPath, 'utf8')

    try {
      await test.step('corrupt the base branch metadata', async () => {
        await fs.writeFile(metaPath, '{ this is not valid json', 'utf8')
        await bumpBranchRegistry()
      })

      await test.step('GET /branches still 200s (not 503) despite corrupt base metadata', async () => {
        const res = await fetch(`${BASE_URL}/api/canopycms/branches`, {
          headers: { 'X-Test-User': 'admin' },
        })
        expect(res.status).toBe(200)
        const body = (await res.json()) as BranchListBody
        const names = body.data.branches.map((b) => b.name)
        // The corrupt directory is quarantined out of the registry scan...
        expect(names).not.toContain(protectedBranch.name)
        // ...but the rest of the registry keeps serving.
        expect(names).toContain(healthyBranchName)
      })

      await test.step('the editor still loads a healthy branch', async () => {
        await page.goto(`/edit?branch=${healthyBranchName}`)
        await editorPage.waitForReady()
      })
    } finally {
      // MANDATORY: this corrupts a shared workspace directory other specs
      // (and the next run of this one) depend on -- must always restore,
      // pass or fail.
      await test.step('restore original base branch metadata', async () => {
        await fs.writeFile(metaPath, originalBytes, 'utf8')
        await bumpBranchRegistry()
      })
    }

    await test.step('confirm the restore worked: base branch is healthy again', async () => {
      const res = await fetch(`${BASE_URL}/api/canopycms/branches`, {
        headers: { 'X-Test-User': 'admin' },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as BranchListBody
      const restored = body.data.branches.find((b) => b.name === protectedBranch.name)
      expect(restored?.isProtected).toBe(true)
    })
  })
})
