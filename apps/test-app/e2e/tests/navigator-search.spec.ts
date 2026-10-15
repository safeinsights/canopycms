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
    // The first Escape cleared the filter; the panel is still open.
    await expect(editorPage.contentNavigator).toBeVisible()
  })

  test('Mod+P from inside a form field opens an entry by title, with the panel closed', async ({
    page,
  }) => {
    await editorPage.openContentNavigator()
    await editorPage.selectEntry('Home Page')
    await editorPage.closeContentNavigator()

    await test.step('focus a text field in the form', async () => {
      await editorPage.getFieldInput('title').click()
    })

    await editorPage.quickOpen('Test Site')

    await expect(editorPage.currentEntryLabel()).toContainText('Test Site', {
      timeout: STANDARD_TIMEOUT,
    })
    await expect(page.locator('[data-testid="entry-navigator"]')).toHaveCount(0)
  })

  for (const [route, open, opener] of [
    [
      "the panel's Quick open button",
      (page: Page) => page.getByTestId('quick-open-button').click(),
      (page: Page) => page.getByTestId('quick-open-button'),
    ],
    [
      'Mod+P pressed inside the panel',
      (page: Page) => page.keyboard.press('ControlOrMeta+P'),
      (page: Page) => page.getByTestId('entry-nav-filter'),
    ],
  ] as const) {
    test(`the docked panel stays open under the palette opened by ${route}, and takes focus back`, async ({
      page,
    }) => {
      await editorPage.openContentNavigator()

      await open(page)
      await expect(page.getByTestId('quick-open-input')).toBeVisible({ timeout: STANDARD_TIMEOUT })
      await expect(editorPage.contentNavigator).toBeVisible()
      await page.keyboard.press('Escape')

      await expect(page.getByTestId('quick-open-input')).not.toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
      await expect(opener(page)).toBeFocused({ timeout: SHORT_TIMEOUT })
      await expect(editorPage.contentNavigator).toBeVisible()
    })
  }

  test.describe('in a window too narrow to dock the panel', () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 800 })
    })

    test('the panel lays over the form only, leaving the preview in view', async () => {
      await editorPage.openContentNavigator()
      const panel = await editorPage.contentNavigator.boundingBox()
      const preview = await editorPage.previewPane.boundingBox()
      const form = await editorPage.formPane.boundingBox()
      if (!panel || !preview || !form) throw new Error('a region is not visible')
      expect(panel.x).toBeGreaterThanOrEqual(form.x - 1)
      expect(panel.x + panel.width).toBeLessThanOrEqual(form.x + form.width + 1)
    })

    test('closing the palette opened from a breadcrumb-opened panel returns focus to that breadcrumb and keeps it there', async ({
      page,
    }) => {
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home Page')
      await editorPage.openContentNavigatorFromBreadcrumb()
      const breadcrumb = page.getByTestId('breadcrumb-segment').first()

      await page.getByTestId('quick-open-button').click()
      await expect(page.getByTestId('quick-open-input')).toBeVisible({ timeout: STANDARD_TIMEOUT })
      // The palette replaces the overlay.
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

    test('picking an entry in the palette opened from the rail-opened panel returns focus to the Content button', async ({
      page,
    }) => {
      await editorPage.openContentNavigator()
      await page.keyboard.press('ControlOrMeta+P')
      const input = page.getByTestId('quick-open-input')
      await expect(input).toBeVisible({ timeout: STANDARD_TIMEOUT })
      await expect(page.locator('[data-testid="entry-navigator"]')).toHaveCount(0)

      await input.fill('Test Site')
      await expect(page.getByTestId('quick-open-option').first()).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
      await input.press('Enter')

      await expect(editorPage.currentEntryLabel()).toContainText('Test Site', {
        timeout: STANDARD_TIMEOUT,
      })
      await expect(editorPage.contentPanelToggle).toBeFocused({ timeout: SHORT_TIMEOUT })
    })

    test('closing the rail-opened panel with Escape returns focus to the Content button', async ({
      page,
    }) => {
      await editorPage.openContentNavigator()

      await page.keyboard.press('Escape')

      await expect(editorPage.contentNavigator).not.toBeVisible({ timeout: STANDARD_TIMEOUT })
      await expect(editorPage.contentPanelToggle).toBeFocused({ timeout: SHORT_TIMEOUT })
    })
  })
})
