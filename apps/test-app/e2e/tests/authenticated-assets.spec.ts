import { BASE_URL } from '../fixtures/base-url'
import { test, expect, type Locator } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { MediaPage } from '../fixtures/media-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'
import { STANDARD_TIMEOUT, LONG_TIMEOUT } from '../fixtures/timeouts'

const RAW_ROUTE = '/api/canopycms/assets/raw/'

/** Resolves once every image in `images` has loaded real pixels. */
async function expectAllLoaded(images: Locator, count: number): Promise<void> {
  await expect(images).toHaveCount(count, { timeout: STANDARD_TIMEOUT })
  await expect
    .poll(
      () =>
        images.evaluateAll((els) =>
          els.every(
            (el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0,
          ),
        ),
      { timeout: LONG_TIMEOUT },
    )
    .toBe(true)
}

/**
 * The editor and its live preview load every image through the authenticated raw route, never
 * the public `/assets` path: Home's `heroImage` has an `aspect`, so an upload opens the crop
 * step, and HomeView renders the committed image at 24 widths, each a transform no build made.
 */
test.describe('Editor and preview images use the authenticated asset route', () => {
  let editorPage: EditorPage
  let mediaPage: MediaPage

  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    mediaPage = new MediaPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('a fresh crop and a 24-image preview load through the raw route, unthrottled', async ({
    page,
  }) => {
    const assetResponses: { path: string; status: number }[] = []
    page.on('response', (response) => {
      const { pathname } = new URL(response.url())
      if (pathname.startsWith('/assets/') || pathname.startsWith(RAW_ROUTE)) {
        assetResponses.push({ path: pathname, status: response.status() })
      }
    })

    await test.step('open Home Page', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Home Page')
    })

    let hash32 = ''
    await test.step('upload opens the crop step on the original, through the raw route', async () => {
      const cropSource = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.startsWith(`${RAW_ROUTE}assets/t/orig/`) &&
          response.request().resourceType() === 'image',
      )
      const body = await mediaPage.uploadViaImageFieldDropzone('heroImage', 'test-image.png')
      expect(body.ok).toBe(true)
      hash32 = body.data!.asset.hash32
      expect((await cropSource).status()).toBe(200)
    })

    await test.step('applying the crop shows the cropped derivative, through the raw route', async () => {
      const apply = page.getByTestId('crop-step-apply')
      await expect(apply).toBeEnabled({ timeout: STANDARD_TIMEOUT })
      await apply.click()

      const preview = mediaPage.imageFieldImg('heroImage')
      await expect(preview).toHaveAttribute(
        'src',
        new RegExp(`^${RAW_ROUTE}assets/t/c=[0-9.:]+,w=320/${hash32}/`),
        { timeout: STANDARD_TIMEOUT },
      )
      await expectAllLoaded(preview, 1)
    })

    await test.step('the preview renders all 24 widths through the raw route', async () => {
      const images = page
        .frameLocator('[data-testid="preview-pane"] iframe')
        .locator('[data-testid="hero-widths"] img')
      await expectAllLoaded(images, 24)
      const srcs = await images.evaluateAll((els) => els.map((el) => el.getAttribute('src')))
      for (const src of srcs) {
        expect(src).toMatch(new RegExp(`^${RAW_ROUTE}assets/t/c=[0-9.:]+,w=\\d+/${hash32}/`))
      }
      expect(new Set(srcs).size).toBe(24)
    })

    // The dev server has no concurrency cap, so throttling is covered by the unit tests, not here.
    await test.step('nothing failed or was fetched from the public path', () => {
      expect(assetResponses.filter((r) => r.status !== 200)).toEqual([])
      expect(assetResponses.filter((r) => r.path.startsWith('/assets/'))).toEqual([])
      expect(assetResponses.length).toBeGreaterThanOrEqual(26)
    })
  })
})
