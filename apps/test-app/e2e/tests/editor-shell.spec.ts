import { BASE_URL } from '../fixtures/base-url'
import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'
import { LONG_TIMEOUT, SHORT_TIMEOUT } from '../fixtures/timeouts'

/** The editor owns the window: it fills the viewport, the page never scrolls, and the split persists. */
test.describe('Editor shell', () => {
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

  test('fills the viewport and keeps the page from scrolling', async ({ page }) => {
    const viewport = page.viewportSize()
    const shell = await page.locator('[data-canopy-shell]').boundingBox()
    expect(shell).toEqual({ x: 0, y: 0, width: viewport?.width, height: viewport?.height })

    const separator = await editorPage.paneSplitter.boundingBox()
    expect(separator?.width).toBeCloseTo(4, 0)

    await page.mouse.wheel(0, 800)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  })

  test('the rail runs Content, Comments, Media, a divider and the layout toggle', async () => {
    expect(await editorPage.railItems()).toEqual([
      'Content',
      'Comments',
      'Media library',
      'separator',
      'Switch to stacked layout (now side by side)',
      'Settings',
    ])
  })

  test('Content carries an unsaved dot while its panel is closed', async () => {
    await editorPage.openContentNavigator()
    await editorPage.selectEntry('Home')
    await editorPage.fillTextField('title', 'Home, edited')
    await editorPage.closeContentNavigator()
    await expect(editorPage.contentPanelToggle).toHaveAccessibleName('Content, 1 unsaved')
    await expect(editorPage.railUnsavedMark()).toBeVisible()

    await editorPage.openContentNavigator()
    await expect(editorPage.contentPanelToggle).toHaveAccessibleName('Content')
    await expect(editorPage.railUnsavedMark()).toHaveCount(0)
  })

  test('a drag across the preview resizes the split, and the size survives a reload', async ({
    page,
  }) => {
    const before = await editorPage.paneSplitPercent()
    await editorPage.dragPaneSplit(-200)
    await expect
      .poll(() => editorPage.paneSplitPercent(), { timeout: SHORT_TIMEOUT })
      .toBeLessThan(before - 5)
    const dragged = await editorPage.paneSplitPercent()

    await page.reload()
    await editorPage.waitForReady()
    await expect
      .poll(() => editorPage.paneSplitPercent(), { timeout: SHORT_TIMEOUT })
      .toBeCloseTo(dragged, 0)
  })

  test('the layout, preview width and highlights survive a reload', async ({ page }) => {
    await editorPage.openContentNavigator()
    await editorPage.selectEntry('Home')
    await expect(editorPage.layoutButton()).toHaveAttribute('data-layout', 'side')
    await editorPage.layoutButton().click()
    await editorPage.previewWidthSelect().click()
    await page.getByRole('option', { name: /Tablet/ }).click()
    await editorPage.toggleHighlights()

    await page.reload()
    await editorPage.waitForReady()
    await expect(editorPage.layoutButton()).toHaveAttribute('data-layout', 'stacked')
    await expect(editorPage.previewWidthSelect()).toHaveValue('Tablet')
    await expect(editorPage.highlightToggle()).toHaveAttribute('aria-pressed', 'true')
  })

  test("the rich-text editor's popups paint above the shell and below its drawers", async ({
    page,
  }) => {
    await editorPage.createPost('popup-layer-post', 'Popup Layer Post')
    const body = editorPage.richTextField('Body')
    await body.waitFor({ state: 'visible', timeout: LONG_TIMEOUT })
    await body.click()

    await page.getByRole('combobox', { name: 'Block type' }).click()
    const listbox = page.getByRole('listbox')
    await expect(listbox).toBeVisible({ timeout: SHORT_TIMEOUT })
    // Both are stacking contexts at the root, so their z-indexes decide which paints on top. A hit
    // test cannot: the open select turns pointer events off everywhere else.
    const [popupLayer, shellLayer, modalLayer] = await listbox.evaluate((list) => {
      const zOf = (el: Element | null) => Number(el ? getComputedStyle(el).zIndex : NaN)
      return [
        zOf(list.closest('.mdxeditor-popup-container')),
        zOf(document.querySelector('[data-canopy-shell]')),
        Number(
          getComputedStyle(document.documentElement).getPropertyValue('--mantine-z-index-modal'),
        ),
      ]
    })
    expect(popupLayer).toBeGreaterThan(shellLayer)
    // A drawer or modal opened over the form still covers them.
    expect(popupLayer).toBeLessThan(modalLayer)
  })
})
