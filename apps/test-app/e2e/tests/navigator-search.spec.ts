import { BASE_URL } from '../fixtures/base-url'
import { test, expect, type Page } from '@playwright/test'
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

  for (const [route, open] of [
    [
      "the drawer's Quick open button",
      (page: Page) => page.getByTestId('quick-open-button').click(),
    ],
    ['Mod+P pressed inside the drawer', (page: Page) => page.keyboard.press('ControlOrMeta+P')],
  ] as const) {
    test(`closing the palette opened by ${route} returns focus to the navigator toggle`, async ({
      page,
    }) => {
      await editorPage.openContentNavigator()

      await open(page)
      await expect(page.getByTestId('quick-open-input')).toBeVisible({ timeout: STANDARD_TIMEOUT })
      await page.keyboard.press('Escape')

      await expect(page.getByTestId('quick-open-input')).not.toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
      await expect(page.getByTestId('file-dropdown-button')).toBeFocused({ timeout: SHORT_TIMEOUT })
    })
  }

  test('closing the palette opened from a breadcrumb-opened drawer returns focus to that breadcrumb and keeps it there', async ({
    page,
  }) => {
    await editorPage.openContentNavigator()
    await editorPage.selectEntry('Home Page')
    await editorPage.openContentNavigatorFromBreadcrumb()
    const breadcrumb = page.getByTestId('breadcrumb-segment').first()

    await page.getByTestId('quick-open-button').click()
    await expect(page.getByTestId('quick-open-input')).toBeVisible({ timeout: STANDARD_TIMEOUT })
    // Until the drawer has unmounted, its own focus return would answer for the palette's.
    await expect(page.locator('[data-testid="entry-navigator"]')).toHaveCount(0)
    await page.keyboard.press('Escape')

    await expect(page.getByTestId('quick-open-input')).not.toBeVisible({
      timeout: STANDARD_TIMEOUT,
    })
    await expect(breadcrumb).toBeFocused({ timeout: SHORT_TIMEOUT })
    // A second, late focus move would land after Mantine's own timers have run.
    await page.waitForTimeout(800)
    await expect(breadcrumb).toBeFocused()
  })

  test('picking an entry in the palette opened from the menu-opened drawer returns focus to the navigator toggle', async ({
    page,
  }) => {
    await editorPage.openContentNavigator()
    await page.keyboard.press('ControlOrMeta+P')
    const input = page.getByTestId('quick-open-input')
    await expect(input).toBeVisible({ timeout: STANDARD_TIMEOUT })
    // Until the drawer has unmounted, its own focus return would answer for the palette's.
    await expect(page.locator('[data-testid="entry-navigator"]')).toHaveCount(0)

    await input.fill('Test Site')
    await expect(page.getByTestId('quick-open-option').first()).toBeVisible({
      timeout: STANDARD_TIMEOUT,
    })
    await input.press('Enter')

    await expect(editorPage.currentEntryLabel()).toContainText('Test Site', {
      timeout: STANDARD_TIMEOUT,
    })
    await expect(page.getByTestId('file-dropdown-button')).toBeFocused({ timeout: SHORT_TIMEOUT })
  })

  test('closing the menu-opened drawer with Escape returns focus to the navigator toggle', async ({
    page,
  }) => {
    await editorPage.openContentNavigator()

    await editorPage.closeContentNavigator()

    await expect(page.getByTestId('file-dropdown-button')).toBeFocused({ timeout: SHORT_TIMEOUT })
  })
})
