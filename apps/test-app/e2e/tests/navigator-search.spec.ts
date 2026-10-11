import { BASE_URL } from '../fixtures/base-url'
import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'
import { SHORT_TIMEOUT, STANDARD_TIMEOUT } from '../fixtures/timeouts'

/**
 * E2E tests for finding an entry: the navigator's filter box and the Mod+P quick-open palette.
 * The seeded entries are "Home Page" and "Test Site".
 */
test.describe('Navigator search', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
    await editorPage.goto()
    await editorPage.waitForReady()
  })

  test('the filter keeps a matching entry and hides the others, and Escape clears it', async ({
    page,
  }) => {
    await editorPage.openContentNavigator()
    await expect(editorPage.navigatorItem('Test Site')).toBeVisible({ timeout: STANDARD_TIMEOUT })

    await editorPage.filterNavigator('home')

    await expect(editorPage.navigatorItem('Home Page')).toBeVisible({ timeout: SHORT_TIMEOUT })
    await expect(editorPage.navigatorItem('Test Site')).toHaveCount(0)

    await page.keyboard.press('Escape')

    await expect(page.locator('[data-testid="entry-nav-filter"]')).toHaveValue('')
    await expect(editorPage.navigatorItem('Test Site')).toBeVisible({ timeout: SHORT_TIMEOUT })
    // The first Escape cleared the filter; the drawer is still open.
    await expect(editorPage.contentNavigator).toBeVisible()
  })

  test('Mod+P from inside a form field opens an entry by title, with the navigator closed', async ({
    page,
  }) => {
    await editorPage.openContentNavigator()
    await editorPage.selectEntry('Home Page')

    await test.step('focus a text field in the form', async () => {
      await editorPage.getFieldInput('title').click()
    })

    await editorPage.quickOpen('Test Site')

    await expect(editorPage.currentEntryLabel()).toContainText('Test Site', {
      timeout: STANDARD_TIMEOUT,
    })
    await expect(page.locator('[data-testid="entry-navigator"]')).toHaveCount(0)
  })
})
