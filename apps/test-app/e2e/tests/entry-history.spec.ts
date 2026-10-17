import { BASE_URL } from '../fixtures/base-url'
import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'
import { STANDARD_TIMEOUT } from '../fixtures/timeouts'

/** Back and Forward against the Next.js router, which keeps a URL of its own for each page. */
test.describe('Back and Forward between entries', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('Back to an entry deleted since opens the home page, and the URL stays on it', async ({
    page,
  }) => {
    const urlEntry = () => new URL(page.url()).searchParams.get('entry')
    let homeEntry: string | null = null

    await test.step('open a post, then Home, then delete the post', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.createPost('gone-soon', 'Gone Soon Post')
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home')
      await expect.poll(urlEntry, { timeout: STANDARD_TIMEOUT }).not.toContain('gone-soon')
      homeEntry = urlEntry()
      await editorPage.deleteEntry('Gone Soon Post')
      await editorPage.closeContentNavigator()
    })

    await test.step('Back opens the home page, says why, and keeps its URL', async () => {
      await page.goBack()
      await expect(
        page.getByText('The entry you returned to is no longer on this branch'),
      ).toBeVisible({ timeout: STANDARD_TIMEOUT })
      await expect.poll(urlEntry, { timeout: STANDARD_TIMEOUT }).toBe(homeEntry)
      // Next.js's router commits its own update after the editor's; the URL must survive it.
      await page.waitForTimeout(1000)
      expect(urlEntry()).toBe(homeEntry)
    })
  })
})
