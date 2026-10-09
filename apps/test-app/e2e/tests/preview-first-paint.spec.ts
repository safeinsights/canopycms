import { BASE_URL } from '../fixtures/base-url'
import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { expectAllLoaded } from '../fixtures/images'
import { MediaPage } from '../fixtures/media-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'
import { STANDARD_TIMEOUT } from '../fixtures/timeouts'

const RAW_ROUTE = '/api/canopycms/assets/raw/'
const PREVIEW_URL = '/preview/home?branch=main'
/** An HTML attribute holding a public `/assets/t/` URL, which the browser fetches while parsing. */
const PUBLIC_TRANSFORM_ATTRIBUTE = /="\/assets\/t\//

/**
 * The page's HTML with its RSC flight chunks rejoined: Next splits the payload into
 * `self.__next_f.push` scripts at arbitrary offsets, which can fall inside a URL.
 */
const joinFlightChunks = (html: string): string =>
  html.replace(/"\]\)<\/script><script>self\.__next_f\.push\(\[1,"/g, '')

const fetchAsAdmin = async (path: string): Promise<string> => {
  const response = await fetch(`${BASE_URL}${path}`, { headers: { 'X-Test-User': 'admin' } })
  expect(response.status).toBe(200)
  return joinFlightChunks(await response.text())
}

/**
 * The `createPreviewPage` route (`app/preview/[[...path]]`) renders Home with a fresh crop, which
 * no build made. Its view shows the hero, a memoized copy that never re-renders, and a thumbnail
 * the route's `load` server-renders. Every one of them, from the first request, must load through
 * the raw route.
 */
test.describe('A createPreviewPage view paints its images from the signed-in route', () => {
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

  test('a fresh crop never reaches the public path, and only preview requests are prefixed', async ({
    page,
  }) => {
    let hash32 = ''
    await test.step('save Home with a freshly cropped hero', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Home Page')
      const body = await mediaPage.uploadViaImageFieldDropzone('heroImage', 'test-image.png')
      expect(body.ok).toBe(true)
      hash32 = body.data!.asset.hash32
      const apply = page.getByTestId('crop-step-apply')
      await expect(apply).toBeEnabled({ timeout: STANDARD_TIMEOUT })
      await apply.click()
      await expect(mediaPage.imageFieldImg('heroImage')).toHaveAttribute(
        'src',
        new RegExp(`/assets/t/c=[0-9.:]+,w=320/${hash32}/`),
        { timeout: STANDARD_TIMEOUT },
      )
      await mediaPage.imageFieldAltInput('heroImage').fill('A cropped hero')
      await editorPage.saveAndVerify()
    })

    await test.step('the server HTML carries no public transform URL', async () => {
      const html = await fetchAsAdmin(PREVIEW_URL)
      expect(html).toContain(hash32)
      expect(html).not.toMatch(PUBLIC_TRANSFORM_ATTRIBUTE)
      expect(html).not.toContain('<img')
    })

    await test.step('every image request for the crop goes to the raw route and loads', async () => {
      const requests: string[] = []
      const failures: { path: string; status: number }[] = []
      page.on('request', (request) => {
        const { pathname } = new URL(request.url())
        if (pathname.includes(hash32)) requests.push(pathname)
      })
      page.on('response', (response) => {
        const { pathname } = new URL(response.url())
        if (pathname.includes(hash32) && response.status() !== 200) {
          failures.push({ path: pathname, status: response.status() })
        }
      })

      await page.goto(PREVIEW_URL)
      const view = page.getByTestId('home-preview')
      await expectAllLoaded(view.locator('img'), 3)

      for (const testId of ['preview-hero', 'still-hero', 'hero-thumb']) {
        await expect(view.getByTestId(testId)).toHaveAttribute(
          'src',
          new RegExp(`^${RAW_ROUTE}assets/t/c=[0-9.:]+,w=\\d+/${hash32}/`),
        )
      }
      expect(failures).toEqual([])
      expect(requests.filter((path) => !path.startsWith(RAW_ROUTE))).toEqual([])
      expect(new Set(requests).size).toBeGreaterThanOrEqual(3)

      // How long the view's area stays empty: compare first paint, which shows the layout, with
      // the first image request, which follows the view's render. An annotation, not asserted.
      const timing = await page.evaluate(() => {
        const [navigation] = performance.getEntriesByType(
          'navigation',
        ) as PerformanceNavigationTiming[]
        const firstPaint = performance.getEntriesByName('first-paint')[0]?.startTime ?? NaN
        const firstImage = Math.min(
          ...performance
            .getEntriesByType('resource')
            .filter((entry) => entry.name.includes('/assets/t/'))
            .map((entry) => entry.startTime),
        )
        const since = (t: number) => Math.round(t - navigation.responseStart)
        return `first byte → first paint ${since(firstPaint)} ms, DOMContentLoaded ${since(navigation.domContentLoadedEventEnd)} ms, first image request ${since(firstImage)} ms`
      })
      test.info().annotations.push({ type: 'preview-timing', description: timing })
    })

    await test.step('requests rendered alongside previews keep public URLs', async () => {
      // The thumbnail is the only `w=200` URL, and the server computes it on both pages.
      const thumb = (prefix: string) =>
        new RegExp(`"${prefix}/assets/t/c=[0-9.:]+,w=200/${hash32}/`)
      const responses = await Promise.all(
        Array.from({ length: 16 }, (_, i) => fetchAsAdmin(i % 2 ? '/hero' : PREVIEW_URL)),
      )
      const heroPages = responses.filter((_, i) => i % 2)
      const previews = responses.filter((_, i) => i % 2 === 0)
      for (const html of heroPages) {
        expect(html).toMatch(thumb(''))
        expect(html).not.toContain(RAW_ROUTE)
      }
      for (const html of previews) {
        expect(html).toMatch(thumb(RAW_ROUTE.slice(0, -1)))
        expect(html).not.toMatch(/\\"\/assets\/t\/[^"\\]*w=200/)
      }
    })
  })
})
