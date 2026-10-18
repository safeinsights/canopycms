import { BASE_URL } from '../fixtures/base-url'
import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'
import { SHORT_TIMEOUT, STANDARD_TIMEOUT } from '../fixtures/timeouts'

/**
 * E2E tests for finding an entry: the content panel's search field, and Mod+P, which opens a
 * closed panel at that field until Enter, Escape or focus leaves it.
 * The seeded entries are the single-entry types "Home" and "Settings", named by their types.
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

  const filter = () => editorPage.page.getByTestId('entry-nav-filter')

  /** Focus Home's title field with the panel closed, then press Mod+P there. */
  const modPFromForm = async () => {
    await editorPage.openContentNavigator()
    await editorPage.selectEntry('Home')
    await editorPage.closeContentNavigator()
    await editorPage.getFieldInput('title').click()
    await editorPage.page.keyboard.press('ControlOrMeta+P')
    await expect(filter()).toBeFocused({ timeout: STANDARD_TIMEOUT })
  }

  test('the filter keeps a matching entry and hides the others, and Escape clears it', async ({
    page,
  }) => {
    await editorPage.openContentNavigator()
    await expect(editorPage.navigatorItem('Settings')).toBeVisible({ timeout: STANDARD_TIMEOUT })

    await editorPage.filterNavigator('home')

    await expect(editorPage.navigatorItem('Home')).toBeVisible({ timeout: SHORT_TIMEOUT })
    await expect(editorPage.navigatorItem('Settings')).toHaveCount(0)

    await page.keyboard.press('Escape')

    await expect(page.locator('[data-testid="entry-nav-filter"]')).toHaveValue('')
    await expect(editorPage.navigatorItem('Settings')).toBeVisible({ timeout: SHORT_TIMEOUT })
    // The first Escape cleared the filter; the panel is still open.
    await expect(editorPage.contentNavigator).toBeVisible()
  })

  test('Mod+P from inside a form field opens an entry by title, then the panel closes and its form has focus', async ({
    page,
  }) => {
    await editorPage.openContentNavigator()
    await editorPage.selectEntry('Home')
    await editorPage.closeContentNavigator()
    await editorPage.getFieldInput('title').click()

    await editorPage.findEntry('Settings')

    await expect(editorPage.currentEntryLabel()).toContainText('Settings', {
      timeout: STANDARD_TIMEOUT,
    })
    await expect(page.locator('[data-testid="entry-navigator"]')).toHaveCount(0)
    await expect(editorPage.formPane.locator('[data-canopy-field] :focus')).toHaveCount(1, {
      timeout: STANDARD_TIMEOUT,
    })
    await expect(editorPage.contentPanelToggle).toHaveAttribute('aria-expanded', 'false')
  })

  test('Escape in the empty field closes the Mod+P panel and returns focus to the form field', async ({
    page,
  }) => {
    await modPFromForm()

    await page.keyboard.press('Escape')

    await expect(editorPage.contentNavigator).not.toBeVisible({ timeout: STANDARD_TIMEOUT })
    await expect(editorPage.getFieldInput('title')).toBeFocused({ timeout: SHORT_TIMEOUT })
  })

  test('the Mod+P panel closes when focus moves outside it', async () => {
    await modPFromForm()

    await editorPage.getFieldInput('title').click()

    await expect(editorPage.contentNavigator).not.toBeVisible({ timeout: STANDARD_TIMEOUT })
    await expect(editorPage.getFieldInput('title')).toBeFocused()
  })

  test('a held click that closes the Mod+P panel still lands where it was pressed', async ({
    page,
  }) => {
    await modPFromForm()
    const box = await page.getByTestId('file-dropdown-button').boundingBox()
    if (!box) throw new Error('the entry menu is not visible')

    // Closing the docked panel moves the entry header; a release before then would hide that.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(150)
    await page.mouse.up()

    await expect(editorPage.contentNavigator).not.toBeVisible({ timeout: STANDARD_TIMEOUT })
    await expect(page.getByTestId('entry-menu-rename')).toBeVisible({ timeout: SHORT_TIMEOUT })
  })

  test('the Content button keeps the Mod+P panel open for good', async () => {
    await modPFromForm()

    await editorPage.contentPanelToggle.click()
    await editorPage.getFieldInput('title').click()

    await expect(editorPage.contentNavigator).toBeVisible()
    await expect(editorPage.contentPanelToggle).toHaveAttribute('aria-expanded', 'true')
  })

  test('Mod+P in the open panel selects the text of its field', async ({ page }) => {
    await editorPage.openContentNavigator()
    await editorPage.filterNavigator('home')
    await filter().press('End')

    await page.keyboard.press('ControlOrMeta+P')

    await expect
      .poll(() =>
        filter().evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]),
      )
      .toEqual([0, 4])
    await expect(editorPage.contentNavigator).toBeVisible()
  })

  test("the form pane, when it takes focus, draws the theme's focus ring inset", async ({
    page,
  }) => {
    // The ring is for keyboard focus, which the last input decides.
    await page.keyboard.press('Tab')
    const ring = await editorPage.formPane.evaluate((pane) => {
      pane.focus()
      const probe = pane.appendChild(document.createElement('div'))
      probe.style.color = 'var(--canopy-focus-ring)'
      const theme = getComputedStyle(probe).color
      probe.remove()
      const style = getComputedStyle(pane)
      return {
        focusVisible: pane.matches(':focus-visible'),
        style: style.outlineStyle,
        color: style.outlineColor,
        theme,
        offset: style.outlineOffset,
      }
    })
    expect(ring.focusVisible).toBe(true)
    expect(ring).toMatchObject({ style: 'solid', color: ring.theme, offset: '-2px' })
  })

  test.describe('in a window too narrow to dock the panel', () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 800 })
    })

    test('the panel lays over the form only, leaving the preview in view', async () => {
      await editorPage.openContentNavigator()
      // How far the panel reaches past either side of the form, read afresh on each poll: it
      // slides in from the form's inline start.
      const overhang = async () => {
        const panel = await editorPage.contentNavigator.boundingBox()
        const form = await editorPage.formPane.boundingBox()
        if (!panel || !form) throw new Error('a region is not visible')
        return Math.max(form.x - panel.x, panel.x + panel.width - (form.x + form.width))
      }
      await expect.poll(overhang, { timeout: SHORT_TIMEOUT }).toBeLessThanOrEqual(1)
    })

    test('Escape from the breadcrumb-opened panel, after Mod+P there, returns focus to that breadcrumb and keeps it there', async ({
      page,
    }) => {
      // A post has a collection crumb; the root entries have none.
      await editorPage.createPost('crumb-post', 'Crumb Post')
      await editorPage.openContentNavigatorFromBreadcrumb()
      const breadcrumb = page.getByTestId('breadcrumb-segment').first()

      await page.keyboard.press('ControlOrMeta+P')
      await expect(filter()).toBeFocused({ timeout: STANDARD_TIMEOUT })
      await page.keyboard.press('Escape')

      await expect(editorPage.contentNavigator).not.toBeVisible({ timeout: STANDARD_TIMEOUT })
      await expect(breadcrumb).toBeFocused({ timeout: SHORT_TIMEOUT })
      // A second, late focus move would land after Mantine's own timers have run.
      await page.waitForTimeout(800)
      await expect(breadcrumb).toBeFocused()
    })

    test('Enter after Mod+P in the rail-opened panel returns focus to the Content button', async ({
      page,
    }) => {
      await editorPage.openContentNavigator()
      await page.keyboard.press('ControlOrMeta+P')
      await expect(filter()).toBeFocused({ timeout: STANDARD_TIMEOUT })

      await filter().fill('Settings')
      await filter().press('Enter')

      await expect(editorPage.currentEntryLabel()).toContainText('Settings', {
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
