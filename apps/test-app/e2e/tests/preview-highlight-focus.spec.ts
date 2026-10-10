import { BASE_URL } from '../fixtures/base-url'
import { test, expect, type FrameLocator, type Locator, type Page } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'

/**
 * The highlight toggle and click-to-focus, end to end, on both preview shapes: the home page runs
 * `useCanopyPreview` itself at `/`, and posts render through `createPreviewPage`'s route.
 */

const previewOf = (page: Page): FrameLocator =>
  page.frameLocator('[data-testid="preview-pane"] iframe')

const outlineStyle = (element: Locator) =>
  element.evaluate((node) => getComputedStyle(node).outlineStyle)

/** The editor marks the focused field with a box-shadow for 1200ms; poll inside that window. */
const expectFieldFocused = async (page: Page, field: string) => {
  await page.waitForFunction(
    (name) =>
      document
        .querySelector<HTMLElement>(`[data-canopy-field="${name}"]`)
        ?.style.boxShadow.includes('rgba(79, 70, 229'),
    field,
    { timeout: 2000 },
  )
  await expect(page.locator(`[data-canopy-field="${field}"]`).first()).toBeInViewport()
}

/** The mark counts the preview has reported to the editor window, oldest first. */
const recordMarkCounts = (page: Page) =>
  page.evaluate(() => {
    const counts: number[] = []
    Object.assign(window, { __markCounts: counts })
    window.addEventListener('message', (event) => {
      const data = event.data as { type?: string; count?: number }
      if (data?.type === 'canopycms:preview:marks' && typeof data.count === 'number') {
        counts.push(data.count)
      }
    })
  })

const markCounts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __markCounts: number[] }).__markCounts)

const expectHighlightToggles = async (page: Page, marked: Locator[]) => {
  const toggle = page.getByRole('button', { name: 'Toggle highlights' })
  for (const element of marked) expect(await outlineStyle(element)).toBe('none')
  await recordMarkCounts(page)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  for (const element of marked) await expect.poll(() => outlineStyle(element)).toBe('dashed')
  await expect
    .poll(async () => (await markCounts(page)).at(-1) ?? 0)
    .toBeGreaterThanOrEqual(marked.length)
  await expect(page.getByText(/marks no editable elements/)).toHaveCount(0)
  await expect(toggle).not.toHaveAttribute('aria-description')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  for (const element of marked) await expect.poll(() => outlineStyle(element)).toBe('none')
}

test.describe('Preview highlights and click-to-focus', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('a page running useCanopyPreview: highlights, and focus on a field inside an object', async ({
    page,
  }) => {
    const preview = previewOf(page)
    const title = preview.locator('[data-canopy-path="title"]')

    await test.step('create a post, then open Home Page', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.createPost('focus-target', 'Focus Target Post')
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Home Page')
      await page.keyboard.press('Escape')
      await expect(title).toContainText('Home Page', { timeout: 15000 })
    })

    await test.step('the toggle outlines marked elements, and removes the outline', async () => {
      await expectHighlightToggles(page, [title, preview.locator('[data-canopy-path="tagline"]')])
    })

    await test.step('clicking the title focuses its field', async () => {
      await title.click()
      await expectFieldFocused(page, 'title')
    })

    await test.step('clicking a reference inside an object focuses that field', async () => {
      await editorPage.selectReferenceOption('spotlight.post', 'Focus Target Post')
      const spotlight = preview.locator('[data-canopy-path="spotlight.post"]')
      await expect(spotlight).toHaveText('Spotlight: Focus Target Post', { timeout: 10000 })
      await spotlight.click()
      await expectFieldFocused(page, 'spotlight.post')
    })
  })

  test('a createPreviewPage view: highlights, and focus on a list item and an object field', async ({
    page,
  }) => {
    const preview = previewOf(page)
    const title = preview.locator('[data-canopy-path="title"]')

    await test.step('create a post with tags and a byline', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.createPost(`focus-${Date.now()}`, 'Preview Page Post')
      const tags = editorPage.getFieldInput('tags')
      await tags.click()
      await tags.fill('alpha')
      await page.keyboard.press('Enter')
      await tags.fill('beta')
      await page.keyboard.press('Enter')
      await editorPage.fillTextField('byline.name', 'Ada')
    })

    await test.step('the post renders on the createPreviewPage route', async () => {
      await expect(editorPage.previewPane.locator('iframe')).toHaveAttribute(
        'src',
        /\/preview\/posts\/focus-/,
      )
      await expect(title).toHaveText('Preview Page Post', { timeout: 15000 })
      await expect(preview.locator('[data-canopy-path="tags[1]"]')).toHaveText('beta')
    })

    await test.step('the toggle outlines marked elements, and removes the outline', async () => {
      await expectHighlightToggles(page, [title, preview.locator('[data-canopy-path="tags[0]"]')])
    })

    await test.step('clicking a list item focuses the list field', async () => {
      await preview.locator('[data-canopy-path="tags[1]"]').click()
      await expectFieldFocused(page, 'tags')
    })

    await test.step('clicking a field inside an object focuses that field', async () => {
      await preview.locator('[data-canopy-path="byline.name"]').click()
      await expectFieldFocused(page, 'byline.name')
    })

    await test.step('a mark naming no field is counted on the toggle and logged', async () => {
      const warnings: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'warning') warnings.push(message.text())
      })
      const toggle = page.getByRole('button', { name: 'Toggle highlights' })
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-pressed', 'true')
      await title.evaluate((node) => {
        const mark = document.createElement('span')
        mark.setAttribute('data-canopy-path', 'byline.nam')
        node.after(mark)
      })
      await expect(toggle).toHaveAttribute(
        'aria-description',
        /^1 preview mark doesn't match a field: byline\.nam\./,
      )
      await expect
        .poll(() => warnings)
        .toContainEqual(expect.stringContaining('"byline.nam", which names no field'))
    })
  })
})
