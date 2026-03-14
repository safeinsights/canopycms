import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'

const BASE_URL = 'http://localhost:5174'

/**
 * E2E tests for the preview bridge — focus sync between preview iframe and editor form.
 */
test.describe('Preview Bridge', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      ;(window as any).__E2E_TEST__ = true
    })
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('click preview element scrolls and highlights editor field', async ({ page }) => {
    await test.step('open editor and select Home Page', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Home Page')
    })

    await test.step('wait for preview iframe to sync home content', async () => {
      // The preview iframe loads /?branch=main; after preview bridge sync,
      // the title element (with data-canopy-path="title") should show content.
      const previewFrame = page.frameLocator('[data-testid="preview-pane"] iframe')
      const titleEl = previewFrame.locator('[data-canopy-path="title"]')
      await titleEl.waitFor({ state: 'visible', timeout: 20000 })
      // Verify the preview content was synced (shows the actual title)
      await expect(titleEl).toContainText('Home Page', { timeout: 10000 })
    })

    await test.step('click title in preview pane', async () => {
      const previewFrame = page.frameLocator('[data-testid="preview-pane"] iframe')
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

  test('preview reflects live edits without saving', async ({ page }) => {
    const previewFrame = page.frameLocator('[data-testid="preview-pane"] iframe')
    const previewTitle = previewFrame.locator('[data-canopy-path="title"]')

    await test.step('open editor and select Home Page', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Home Page')
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
})
