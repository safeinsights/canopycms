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
  commitBranchChanges,
  pushConflictingChangeToMain,
  readBranchContentFile,
  removeFileFromMain,
  triggerRebase,
  writeBranchContentFile,
} from '../fixtures/test-workspace'

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/**
 * A post new to this run: its own content id, slug and title. A dev branch starts from the
 * checkout's branch, which a sync also brings main into and no reset rewinds, so a post an earlier
 * run left there must never be this run's.
 */
const RUN = Date.now()
const CONTENT_ID = Array.from({ length: 12 }, () => BASE58[randomInt(58)]).join('')
const POST_FILE = `posts.qrstuvwxyz12/post.field-merge-${RUN}.${CONTENT_ID}.json`
const POST_TITLE = `Field merge demo ${RUN}`

const json = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`

/** The post as both sides started from it. */
const ancestor = {
  title: POST_TITLE,
  author: 'Ada',
  links: [
    { _key: 'lk1', label: 'Docs' },
    { _key: 'lk2', label: 'Forum' },
  ],
  body: 'First paragraph.\n\nSecond paragraph stays.\n\nThird paragraph.\n',
}

/** The branch's edits: the title, the second link, the first paragraph. */
const yours = {
  ...ancestor,
  title: `${POST_TITLE}, yours`,
  links: [
    { _key: 'lk1', label: 'Docs' },
    { _key: 'lk2', label: 'Community forum' },
  ],
  body: 'First paragraph, as you wrote it.\n\nSecond paragraph stays.\n\nThird paragraph.\n',
}

/**
 * The latest version: the same title and first paragraph changed differently, the second link
 * removed, and the author and third paragraph changed where the branch left them alone.
 */
const latest = {
  ...ancestor,
  title: `${POST_TITLE}, latest`,
  author: 'Ada Lovelace',
  links: [{ _key: 'lk1', label: 'Docs' }],
  body: 'First paragraph, from the site.\n\nSecond paragraph stays.\n\nThird paragraph, from the site.\n',
}

/**
 * Field-level merge, end to end (plan rows 1, 4, 43, 45): the worker's real merge brings the
 * latest version into a branch, the entry and Submit say what waits, "Show changes" offers a card
 * per conflict (a field, a list item and a body region), and once each is chosen and saved,
 * Submit for review is allowed. The merge is started through the test-only rebase endpoint, as
 * conflict-management.spec.ts starts it; get-latest-changes.spec.ts drives the button instead.
 */
test.describe('Field-level conflicts', () => {
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

  test.afterEach(async () => {
    await removeFileFromMain(POST_FILE)
  })

  test('merges what it can, then each conflict is chosen in "Show changes" before Submit', async ({
    page,
  }) => {
    test.setTimeout(150_000)
    const branchName = `field-merge-${Date.now()}`
    const ref = branchRef(branchName)

    await test.step('the post exists on main, and the branch takes it in', async () => {
      await pushConflictingChangeToMain(POST_FILE, json(ancestor))
      const created = await createBranchViaAPI(BASE_URL, branchName, 'admin')
      expect(created.ok).toBe(true)
      // A dev branch starts from the checkout's branch, not from main, so a first sync brings the
      // post in and makes it the version both sides start from.
      await triggerRebase(BASE_URL)
      expect(JSON.parse(await readBranchContentFile(branchName, POST_FILE))).toEqual(ancestor)
    })

    // An author has the branch open before the merge, which is what records the schema the
    // worker names fields by; without it every conflict would be a whole field.
    await test.step('open the post on the branch', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await branchPage.openBranchManager()
      await branchPage.switchToBranch(ref)
      await branchPage.closeBranchManager()
      await editorPage.findEntry(POST_TITLE)
      await expect(editorPage.currentEntryLabel()).toContainText(POST_TITLE, {
        timeout: STANDARD_TIMEOUT,
      })
    })

    await test.step('the branch edits the post; the latest version changes it too', async () => {
      await writeBranchContentFile(branchName, POST_FILE, json(yours))
      await commitBranchChanges(branchName)
      await pushConflictingChangeToMain(POST_FILE, json(latest))
      await triggerRebase(BASE_URL)
    })

    await test.step('fields only one side changed merged by themselves (row 1)', async () => {
      const merged = JSON.parse(
        await readBranchContentFile(branchName, POST_FILE),
      ) as typeof ancestor
      expect(merged.author).toBe('Ada Lovelace')
      expect(merged.body).toContain('Third paragraph, from the site.')
      // Each conflict holds your value until you choose (row 4).
      expect(merged.title).toBe(yours.title)
      expect(merged.body).toContain('First paragraph, as you wrote it.')
      expect(merged.links).toEqual(yours.links)
    })

    await test.step('read the branch again', async () => {
      await page.reload()
      await editorPage.waitForReady()
      await editorPage.findEntry(POST_TITLE)
      await expect(editorPage.currentEntryLabel()).toContainText(POST_TITLE, {
        timeout: STANDARD_TIMEOUT,
      })
    })

    const notice = page.getByTestId('conflict-alert')
    const submit = page.getByTestId('submit-button')

    await test.step('the entry and Submit say what waits (row 45)', async () => {
      await expect(notice).toContainText(
        '3 fields were changed by you and by someone else. Choose what to keep in "Show changes".',
        { timeout: LONG_TIMEOUT },
      )
      await expect(submit).toHaveAttribute('aria-disabled', 'true')
      await submit.focus()
      await expect(page.getByRole('tooltip')).toContainText(
        '3 fields need your choice before this branch can be submitted.',
      )
      await expect(page.getByTestId('branch-hold-status')).toHaveText('Needs action (3)')
    })

    const drawer = page.getByRole('dialog', { name: /^Changes to / })
    const cards = drawer.getByTestId('conflict-card')

    await test.step('"Show changes" shows one card per conflict', async () => {
      await page.getByTestId('conflict-alert-show-changes').click()
      await expect(drawer).toBeVisible({ timeout: STANDARD_TIMEOUT })
      await expect(cards).toHaveCount(3, { timeout: STANDARD_TIMEOUT })
      await expect(drawer.locator('[data-conflict-kind="changed"]')).toContainText(
        'Title was changed by you and by someone else',
      )
      await expect(drawer.locator('[data-conflict-kind="item"]')).toContainText(
        'was removed from the latest version, but you changed it',
      )
      await expect(drawer.locator('[data-conflict-kind="region"]')).toContainText(
        'Body was changed by you and by someone else',
      )
      // An admin's "Latest version" Tooltip names the branch the latest version comes from, which
      // in dev is the checkout's branch. Its opening on focus is pinned by the component tests:
      // a script's focus after a click isn't :focus-visible, which the Tooltip waits for.
      await drawer
        .getByTestId('conflict-version-label')
        .filter({ hasText: 'Latest version' })
        .first()
        .hover()
      await expect(page.getByRole('tooltip')).toContainText(/It comes from \S+\.$/)
    })

    await test.step('choose for each, then save (row 43)', async () => {
      await drawer.getByRole('button', { name: /^Use latest version: Title/ }).click()
      await drawer.getByRole('button', { name: /^Keep it: / }).click()
      await drawer.getByRole('button', { name: /^Use latest version: Body/ }).click()
      await expect(drawer.getByTestId('conflict-choice-note')).toHaveCount(3)
      await expect(drawer.getByTestId('conflicts-left')).toHaveText(
        'All chosen. Save to keep your choices.',
      )
      await page.keyboard.press('Escape')
      await expect(drawer).toBeHidden({ timeout: STANDARD_TIMEOUT })
      await editorPage.saveAndVerify()
    })

    await test.step('the choices are saved and the conflicts cleared', async () => {
      const saved = JSON.parse(
        await readBranchContentFile(branchName, POST_FILE),
      ) as typeof ancestor
      expect(saved.title).toBe(latest.title)
      expect(saved.links.map((l) => l.label)).toEqual(['Docs', 'Community forum'])
      expect(saved.body).toContain('First paragraph, from the site.')
      expect(saved.body).not.toContain('as you wrote it')
      expect(saved.author).toBe('Ada Lovelace')
      await expect(notice).toBeHidden({ timeout: LONG_TIMEOUT })
    })

    await test.step('Submit for review is allowed (row 45)', async () => {
      await expect(submit).not.toHaveAttribute('aria-disabled', 'true', { timeout: LONG_TIMEOUT })
      await expect(page.getByTestId('branch-hold-status')).toHaveCount(0)
    })
  })
})
