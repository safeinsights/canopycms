import { test, expect, type Page } from '@playwright/test'
import { BASE_URL } from '../fixtures/base-url'
import { EditorPage } from '../fixtures/editor-page'
import { BranchPage, branchRef, branchShort } from '../fixtures/branch-page'
import { installE2EFlag, switchUser } from '../fixtures/test-users'
import { ensureMainBranch, resetWorkspace } from '../fixtures/test-workspace'
import { LONG_TIMEOUT, STANDARD_TIMEOUT } from '../fixtures/timeouts'

/**
 * Sharing a branch: its owner shares it from the top bar, a member adds a third person, and the
 * owner's removal of the member closes the branch to them. The dev auth plugin's users stand in:
 * `editor` is User One, `viewer` User Two, and User Three goes by their dev user id. Each is added
 * by their full email address. While the test app's settings hold no rules or groups, none of them
 * works in this CMS, so the add must go by that address: this test fails if it goes by id.
 */
const USER_THREE = 'dev_user3_5vS1pM8kJ4'

async function actAs(page: Page, user: 'editor' | 'viewer' | typeof USER_THREE): Promise<void> {
  if (user === USER_THREE) await page.setExtraHTTPHeaders({ 'X-Test-User': USER_THREE })
  else await switchUser(page, user)
}

/** The top bar's sharing control, by the name it starts with. */
const shareControl = (page: Page, name: RegExp = /^Share…/) =>
  page.getByTestId('branch-share-control').and(page.getByRole('button', { name }))

/** Opens the Share dialog from the top bar, adds `email`, and sends the change. */
async function addByEmail(page: Page, short: string, email: string, name: string) {
  await shareControl(page).click()
  const dialog = page.getByRole('dialog', { name: `Share “${short}”` })
  await dialog.getByRole('textbox', { name: 'Add people or groups' }).fill(email)
  await dialog.getByRole('option', { name: `Add ${email}` }).click()
  await expect(dialog.getByText(name, { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Update access' }).click()
  await expect(dialog).toBeHidden({ timeout: STANDARD_TIMEOUT })
}

test.describe('Branch sharing', () => {
  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
  })

  test('owner shares from the top bar, a member adds someone, and a removal closes it', async ({
    page,
  }) => {
    test.setTimeout(150_000)
    const editorPage = new EditorPage(page)
    const branchPage = new BranchPage(page)
    const typed = `share-${Date.now()}`
    const ref = branchRef(typed)
    const short = branchShort(typed)

    await test.step('the owner creates a branch, which opens', async () => {
      await actAs(page, 'editor')
      await editorPage.goto()
      await editorPage.waitForReady()
      await branchPage.openBranchManager()
      await branchPage.createBranch(typed)
      await expect(page.getByTestId('branch-created-status')).toContainText(
        `Branch “${short}” created`,
        { timeout: LONG_TIMEOUT },
      )
      await expect(page.getByTestId('branch-dropdown-button')).toHaveText(short)
      await branchPage.closeBranchManager()
      await expect(shareControl(page, /^Share…, 1 person has access$/)).toBeVisible()
    })

    await test.step('and shares it from the top bar with User Two', async () => {
      await addByEmail(page, short, 'user2@localhost.dev', 'User Two')
      await expect(shareControl(page, /^Share…, 2 people have access$/)).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
    })

    await test.step('User Two sees the branch, opens it and adds User Three', async () => {
      await actAs(page, 'viewer')
      await editorPage.goto()
      await editorPage.waitForReady()
      await branchPage.openBranchManager()
      await branchPage.waitForBranchInList(ref)
      await branchPage.switchToBranch(ref)
      await expect(page.getByTestId('form-branch-not-available')).toHaveCount(0)
      await addByEmail(page, short, 'user3@localhost.dev', 'User Three')
      await expect(shareControl(page, /^Share…, 3 people have access$/)).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
    })

    await test.step('User Three opens the branch', async () => {
      await actAs(page, USER_THREE)
      await editorPage.goto()
      await editorPage.waitForReady()
      await branchPage.openBranchManager()
      await branchPage.waitForBranchInList(ref)
      await branchPage.switchToBranch(ref)
      await expect(page.getByTestId('form-branch-not-available')).toHaveCount(0)
      await expect(shareControl(page, /^Share…, 3 people have access$/)).toBeVisible()
    })

    await test.step('the owner removes User Two', async () => {
      await actAs(page, 'editor')
      await page.goto(`/edit?branch=${short}`)
      await editorPage.waitForReady()
      await shareControl(page, /^Share…, 3 people have access$/).click()
      const dialog = page.getByRole('dialog', { name: `Share “${short}”` })
      await dialog.getByRole('button', { name: 'Remove User Two' }).click()
      await dialog.getByRole('button', { name: 'Update access' }).click()
      await expect(dialog).toBeHidden({ timeout: STANDARD_TIMEOUT })
      await expect(shareControl(page, /^Share…, 2 people have access$/)).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
    })

    await test.step('User Two finds the branch no longer available', async () => {
      await actAs(page, 'viewer')
      await page.goto(`/edit?branch=${short}`)
      await expect(page.getByTestId('form-branch-not-available')).toBeVisible({
        timeout: LONG_TIMEOUT,
      })
      await expect(page.getByTestId('branch-share-control')).toHaveCount(0)
    })
  })
})
