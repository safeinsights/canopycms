import { BASE_URL } from '../fixtures/base-url'
import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'

/**
 * E2E tests for the preview bridge — focus sync between preview iframe and editor form.
 */
test.describe('Preview Bridge', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('click preview element scrolls and highlights editor field', async ({ page }) => {
    await test.step('open editor and select Home Page', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home')
    })

    await test.step('wait for preview iframe to sync home content', async () => {
      // The preview iframe loads /?branch=main (the config's previewBase); after preview bridge sync,
      // the title element (with data-canopy-path="title") should show content.
      const previewFrame = editorPage.previewFrame()
      const titleEl = previewFrame.locator('[data-canopy-path="title"]')
      await titleEl.waitFor({ state: 'visible', timeout: 20000 })
      // Verify the preview content was synced (shows the actual title)
      await expect(titleEl).toContainText('Home Page', { timeout: 10000 })
    })

    await test.step('click title in preview pane', async () => {
      const previewFrame = editorPage.previewFrame()
      await previewFrame.locator('[data-canopy-path="title"]').click()
    })

    await test.step('verify editor title field is highlighted', async () => {
      // The focus handler finds the first [data-canopy-field="title"] element
      // (the FieldWrapper div) and applies a box-shadow for 1200ms.
      // Use waitForFunction to poll the DOM directly within that window.
      await page.waitForFunction(
        () => {
          const el = document.querySelector<HTMLElement>('[data-canopy-field="title"]')
          return el?.style.boxShadow?.includes('rgba(79, 70, 229')
        },
        { timeout: 2000 },
      )
    })
  })

  test('preview reflects live edits without saving', async () => {
    const previewFrame = editorPage.previewFrame()
    const previewTitle = previewFrame.locator('[data-canopy-path="title"]')

    await test.step('open editor and select Home Page', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home')
    })

    await test.step('verify preview shows original content before editing', async () => {
      await expect(previewTitle).toContainText('Home Page', { timeout: 15000 })
    })

    const liveTitle = `Live-Edit-${Date.now()}`

    await test.step('edit title field without saving', async () => {
      await editorPage.fillTextField('title', liveTitle)
    })

    await test.step('verify preview updates with new content without saving', async () => {
      await expect(previewTitle).toContainText(liveTitle, { timeout: 10000 })
    })

    await test.step('verify save button is enabled (changes not yet saved)', async () => {
      await expect(editorPage.saveButton).toBeEnabled()
    })
  })

  test('preview resolves a reference inside an object without saving', async () => {
    const previewFrame = editorPage.previewFrame()
    const spotlight = previewFrame.locator('[data-testid="spotlight"]')

    await test.step('create a post, then open Home Page', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.createPost('spotlight-target', 'Spotlight Target Post')
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home')
      await editorPage.closeContentNavigator()
      await expect(previewFrame.locator('[data-canopy-path="title"]')).toContainText('Home Page', {
        timeout: 15000,
      })
    })

    await test.step('pick the post in the nested reference field', async () => {
      await expect(spotlight).toHaveCount(0)
      await editorPage.selectReferenceOption('spotlight.post', 'Spotlight Target Post')
    })

    await test.step('preview shows the resolved post, unsaved', async () => {
      await expect(spotlight).toHaveText('Spotlight: Spotlight Target Post', { timeout: 10000 })
      await expect(editorPage.saveButton).toBeEnabled()
    })
  })

  test('an entry with no page shows no preview and frames nothing', async () => {
    await editorPage.goto()
    await editorPage.waitForReady()
    await editorPage.openContentNavigator()
    await editorPage.selectEntry('Settings')

    await expect(editorPage.previewPane).toContainText('No preview for this entry.')
    await expect(editorPage.previewPane.locator('iframe')).toHaveCount(0)
  })

  test('a maximized preview keeps its page and draft, and Esc restores the form', async ({
    page,
  }) => {
    const previewTitle = editorPage.previewFrame().locator('[data-canopy-path="title"]')
    const formPanel = page.getByTestId('form-pane').locator('..')
    const liveTitle = `Maximized-${Date.now()}`

    await editorPage.goto()
    await editorPage.waitForReady()
    await editorPage.openContentNavigator()
    await editorPage.selectEntry('Home')
    await editorPage.fillTextField('title', liveTitle)
    await expect(previewTitle).toContainText(liveTitle, { timeout: 10000 })
    // Survives only if the frame is never reloaded.
    await previewTitle.evaluate(() => Object.assign(window, { __sameFrame: true }))

    await test.step('Maximize covers the form, not the entry header, and focuses Restore', async () => {
      await editorPage.maximizePreviewButton().click()
      await expect(editorPage.restorePreviewButton()).toBeFocused()
      await expect(formPanel).toHaveAttribute('inert', '')
      const main = await page.locator('[data-canopy-region="main"]').boundingBox()
      const header = await editorPage.entryHeader().boundingBox()
      const preview = await page.getByTestId('preview-pane').boundingBox()
      expect(main && header && preview).toBeTruthy()
      if (!main || !header || !preview) return
      // `main` minus the entry header, which stays on top with Save in reach.
      const covered = {
        x: main.x,
        y: header.y + header.height,
        width: main.width,
        height: main.y + main.height - (header.y + header.height),
      }
      expect(header.height).toBeGreaterThan(0)
      expect(Math.abs(header.y - main.y)).toBeLessThanOrEqual(1)
      for (const side of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(preview[side] - covered[side])).toBeLessThanOrEqual(1)
      }
      await expect(editorPage.saveButton).toBeVisible()
      await expect(previewTitle).toContainText(liveTitle)
    })

    await test.step('Esc restores it and returns focus to Maximize', async () => {
      await page.keyboard.press('Escape')
      await expect(editorPage.restorePreviewButton()).toHaveCount(0)
      await expect(editorPage.maximizePreviewButton()).toBeFocused()
      await expect(formPanel).not.toHaveAttribute('inert', '')
      expect(await previewTitle.evaluate(() => '__sameFrame' in window)).toBe(true)
    })

    await test.step('drafts still reach the same frame', async () => {
      await editorPage.fillTextField('title', `${liveTitle}-again`)
      await expect(previewTitle).toContainText(`${liveTitle}-again`, { timeout: 10000 })
      expect(await previewTitle.evaluate(() => '__sameFrame' in window)).toBe(true)
    })
  })
})
