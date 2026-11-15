import { randomInt } from 'node:crypto'
import { BASE_URL } from '../fixtures/base-url'
import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { BranchPage, branchRef } from '../fixtures/branch-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { STANDARD_TIMEOUT, LONG_TIMEOUT } from '../fixtures/timeouts'
import {
  resetWorkspace,
  ensureMainBranch,
  createBranchViaAPI,
  branchBaseRef,
  commitBranchChanges,
  commitToBase,
  readBranchContentFile,
  writeBranchContentFile,
} from '../fixtures/test-workspace'

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/**
 * A post new to this run: its own content id, slug and title. The base a dev branch starts from is
 * the checkout's branch, which no reset rewinds, so a post an earlier run left there is never this
 * run's.
 */
const RUN = Date.now()
const CONTENT_ID = Array.from({ length: 12 }, () => BASE58[randomInt(58)]).join('')
const POST_FILE = `posts.qrstuvwxyz12/post.get-latest-${RUN}.${CONTENT_ID}.json`
const POST_TITLE = `Get latest demo ${RUN}`

const json = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`

const ancestor = {
  title: POST_TITLE,
  author: 'Ada',
  body: 'First paragraph.\n\nSecond paragraph stays.\n',
}
const yours = { ...ancestor, title: `${POST_TITLE}, yours` }
const latest = { ...ancestor, title: `${POST_TITLE}, latest`, author: 'Ada Lovelace' }

/**
 * "Get latest changes" in dev mode, end to end: the button asks, the request runs the worker's
 * merge for the open branch, and the toast and "Show changes" offer the conflict it left
 * (issue 1246). field-merge-conflicts.spec.ts covers the cards and choices themselves.
 */
test.describe('Get latest changes in dev mode', () => {
  let editorPage: EditorPage
  let branchPage: BranchPage
  let base: string | undefined

  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    branchPage = new BranchPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test.afterEach(async () => {
    if (base) await commitToBase(base, POST_FILE, null)
  })

  test('the button brings the base in, then leaves a conflict for "Show changes"', async ({
    page,
  }) => {
    test.setTimeout(150_000)
    const branchName = `get-latest-${Date.now()}`
    const ref = branchRef(branchName)
    const button = page.getByTestId('get-latest-changes-button')
    const toast = page.locator('.mantine-Notification-root')

    await test.step('create the branch and open it, which records its schema', async () => {
      const created = await createBranchViaAPI(BASE_URL, branchName, 'admin')
      expect(created.ok).toBe(true)
      base = await branchBaseRef(branchName)
      await editorPage.goto()
      await editorPage.waitForReady()
      await branchPage.openBranchManager()
      await branchPage.switchToBranch(ref)
      await branchPage.closeBranchManager()
    })

    await test.step('a post added on the base comes in through the button', async () => {
      await commitToBase(base!, POST_FILE, json(ancestor))
      await expect(button).toBeVisible({ timeout: STANDARD_TIMEOUT })
      await button.click()
      await expect(toast.filter({ hasText: 'Latest changes added' })).toBeVisible({
        timeout: LONG_TIMEOUT,
      })
      expect(JSON.parse(await readBranchContentFile(branchName, POST_FILE))).toEqual(ancestor)
    })

    await test.step('the branch and the base change the same title', async () => {
      await writeBranchContentFile(branchName, POST_FILE, json(yours))
      await commitBranchChanges(branchName)
      await commitToBase(base!, POST_FILE, json(latest))
    })

    await test.step('the button merges, keeping your title and taking the author', async () => {
      await button.click()
      const conflicts = toast.filter({
        hasText: 'Latest changes added. 1 field needs your choice.',
      })
      await expect(conflicts).toBeVisible({ timeout: LONG_TIMEOUT })
      const merged = JSON.parse(
        await readBranchContentFile(branchName, POST_FILE),
      ) as typeof ancestor
      expect(merged.title).toBe(yours.title)
      expect(merged.author).toBe('Ada Lovelace')
      await conflicts.getByRole('button', { name: 'Show changes' }).click()
    })

    await test.step('"Show changes" offers the conflict card', async () => {
      const drawer = page.getByRole('dialog', { name: /^Changes to / })
      await expect(drawer).toBeVisible({ timeout: LONG_TIMEOUT })
      const cards = drawer.getByTestId('conflict-card')
      await expect(cards).toHaveCount(1, { timeout: STANDARD_TIMEOUT })
      await expect(cards.first()).toContainText('Title was changed by you and by someone else')
      await expect(drawer.getByRole('button', { name: /^Use latest version: Title/ })).toBeVisible()
    })
  })
})
