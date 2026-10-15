import { BASE_URL } from '../fixtures/base-url'
import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'
import { SHORT_TIMEOUT } from '../fixtures/timeouts'

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

    await page.mouse.wheel(0, 800)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
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
})
