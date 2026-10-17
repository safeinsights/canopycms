import { BASE_URL } from '../fixtures/base-url'
import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'
import { STANDARD_TIMEOUT } from '../fixtures/timeouts'

/**
 * Links clicked in the preview stay in the editor: one to an entry's page opens that entry, and
 * one to a page no entry has opens in a new tab.
 */
test.describe('Links in the preview', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test("an internal link opens the linked entry, and the preview follows to that entry's page", async ({
    page,
  }) => {
    const preview = editorPage.previewFrame()
    const iframe = editorPage.previewPane.locator('iframe')

    await test.step('link Home Page to a post', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.createPost('link-target', 'Link Target Post')
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home')
      await editorPage.closeContentNavigator()
      await editorPage.selectReferenceOption('spotlight.post', 'Link Target Post')
      await expect(preview.locator('[data-testid="spotlight"]')).toHaveText(
        'Spotlight: Link Target Post',
        { timeout: STANDARD_TIMEOUT },
      )
    })

    await test.step('clicking the link opens the post', async () => {
      await preview.getByRole('link', { name: 'Read the spotlight post' }).click()
      await expect(iframe).toHaveAttribute('src', /\/preview\/posts\/link-target(\/)?\?branch=/, {
        timeout: STANDARD_TIMEOUT,
      })
      await editorPage.verifyFieldValue('title', 'Link Target Post')
      await expect(preview.locator('[data-canopy-path="title"]')).toHaveText('Link Target Post', {
        timeout: STANDARD_TIMEOUT,
      })
    })

    await test.step("Home Page's unsaved spotlight is kept", async () => {
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home')
      await editorPage.closeContentNavigator()
      await expect(preview.locator('[data-testid="spotlight"]')).toHaveText(
        'Spotlight: Link Target Post',
        { timeout: STANDARD_TIMEOUT },
      )
    })

    await test.step('a link to a page no entry has opens in a new tab', async () => {
      const popup = page.waitForEvent('popup')
      await preview.getByRole('link', { name: 'Open Editor' }).click()
      const tab = await popup
      expect(new URL(tab.url()).pathname).toBe('/edit')
      await tab.close()
      await expect(
        page.getByText('/edit has no entry here, so it opened in a new tab.'),
      ).toBeVisible()
      await expect(preview.locator('[data-canopy-path="title"]')).toContainText('Home Page')
    })
  })

  test('Back returns from the entry a link opened to the one before, and Forward goes again', async ({
    page,
  }) => {
    const preview = editorPage.previewFrame()
    const iframe = editorPage.previewPane.locator('iframe')
    const postSrc = /\/preview\/posts\/link-target(\/)?\?branch=/

    await test.step('open Home Page, linked to a post', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.createPost('link-target', 'Link Target Post')
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home')
      await editorPage.closeContentNavigator()
      await editorPage.selectReferenceOption('spotlight.post', 'Link Target Post')
      await expect(preview.locator('[data-testid="spotlight"]')).toHaveText(
        'Spotlight: Link Target Post',
        { timeout: STANDARD_TIMEOUT },
      )
    })

    await test.step('follow the link to the post', async () => {
      await preview.getByRole('link', { name: 'Read the spotlight post' }).click()
      await expect(iframe).toHaveAttribute('src', postSrc, { timeout: STANDARD_TIMEOUT })
      await editorPage.verifyFieldValue('title', 'Link Target Post')
    })

    await test.step('Back opens Home Page again, in the same page load', async () => {
      await page.evaluate(() => {
        ;(window as unknown as { __sameLoad?: boolean }).__sameLoad = true
      })
      await page.goBack()
      await expect(preview.locator('[data-testid="spotlight"]')).toHaveText(
        'Spotlight: Link Target Post',
        { timeout: STANDARD_TIMEOUT },
      )
      await expect(iframe).not.toHaveAttribute('src', postSrc)
      expect(new URL(page.url()).searchParams.get('entry')).not.toContain('link-target')
      expect(
        await page.evaluate(() => (window as unknown as { __sameLoad?: boolean }).__sameLoad),
      ).toBe(true)
    })

    await test.step('Forward opens the post again', async () => {
      await page.goForward()
      await expect(iframe).toHaveAttribute('src', postSrc, { timeout: STANDARD_TIMEOUT })
      await editorPage.verifyFieldValue('title', 'Link Target Post')
    })
  })
})
