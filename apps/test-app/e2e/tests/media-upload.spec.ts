import { BASE_URL } from '../fixtures/base-url'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { MediaPage, type UploadedAsset } from '../fixtures/media-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'
import {
  listAssetHashes,
  assetOriginalExists,
  listTransformDirs,
  removeAssetOriginals,
} from '../fixtures/media-workspace'
import { SHORT_TIMEOUT, STANDARD_TIMEOUT } from '../fixtures/timeouts'

/** The `posts` collection's fixed directory suffix - stable across resets, shared with field-types.spec.ts/entry-links.spec.ts/reference-fields.spec.ts. */
const POSTS_DIR = 'posts.qrstuvwxyz12'

const POSTS_CONTENT_DIR = path.resolve(
  process.cwd(),
  'apps/test-app/.canopy-dev/content-branches/main/content',
  POSTS_DIR,
)

/** The `postSchema` shape relevant to these tests (see apps/test-app/app/schemas.ts). Entries are stored `format: 'json'` - the file's top level IS the data record, no `data` wrapper (see field-types.spec.ts). */
interface PostContent {
  title?: string
  heroImage?: {
    src: string
    alt: string
    width?: number
    height?: number
  }
}

/**
 * Find and read a post's content file by TITLE rather than by the slug
 * passed to `createPost()`.
 *
 * This works around a real race in `EntryCreateModal.tsx`: its slug
 * `<TextInput>` state is reset to the literal default `'untitled'` by a
 * `useEffect` keyed (in part) on the `entryTypes` array prop. If that prop
 * isn't referentially stable across the parent's renders, a stray parent
 * re-render landing between this fixture's `.fill(slug)` and its
 * `.click(submit)` silently reverts the field to `'untitled'` before create
 * fires. Confirmed directly during development: a run produced
 * `post.untitled.k1D7Z5pUE7FG.json` on disk after `createPost()` was called
 * with a custom slug, and repeating the same test in isolation never
 * reproduced it (undetectable without the surrounding suite's render
 * pressure) - see the task summary for the full write-up. It is not fixed
 * here (out of this spec's scope - `EntryCreateModal.tsx`/`editor-page.ts`
 * aren't ours to edit), only routed around: the entry's TITLE is filled and
 * saved in a separate step *after* the modal has already closed, so it is
 * never exposed to this race, making it a reliable lookup key regardless of
 * which slug the entry actually landed under.
 */
async function readPostContentByTitle(title: string): Promise<PostContent> {
  const deadline = Date.now() + SHORT_TIMEOUT
  while (Date.now() < deadline) {
    const files = await fs.readdir(POSTS_CONTENT_DIR).catch(() => [] as string[])
    for (const file of files) {
      if (!file.startsWith('post.') || !file.endsWith('.json')) continue
      const raw = await fs.readFile(path.join(POSTS_CONTENT_DIR, file), 'utf8').catch(() => null)
      if (raw === null) continue
      try {
        const parsed = JSON.parse(raw) as PostContent
        if (parsed.title === title) return parsed
      } catch {
        // A file mid-write can briefly fail to parse; the retry loop below picks it up.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`content file with title "${title}" not found under ${POSTS_CONTENT_DIR}`)
}

/**
 * E2E coverage for the assets/media pipeline: upload -> finalize -> transform
 * -> MediaLibrary, exercised through `postSchema`'s `heroImage` field (a
 * structured `image` field with no `aspect`, so picking/uploading commits
 * immediately instead of opening the crop step - see schemas.ts's comment).
 *
 * The test app has no `media` config, so `createAssetStore` falls back to a
 * LocalAssetStore rooted at `apps/test-app/.canopy-dev/assets`.
 * `LocalAssetStore.capabilities.directUpload` is `false`, so every upload
 * here takes the PROXIED path (`POST .../assets/upload`, multipart) rather
 * than a presigned-S3 round trip - there is no real progress fraction for
 * this path (`useAssetUpload`'s `progress` stays `null`), so these tests
 * never assert on a numeric upload progress value.
 *
 * The asset store is a separate, branch-agnostic global store untouched by
 * `resetWorkspace()`'s content-branches reset - `resetAssetStore()`
 * (media-workspace.ts) is wired into `resetWorkspace()` itself so every test
 * here (and every other spec) gets a clean `.canopy-dev/assets` per test.
 */
test.describe('Assets / Media pipeline', () => {
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

  test('C1: upload round trip persists the asset and fills the field', async () => {
    const slug = `media-c1-${Date.now()}`

    await test.step('open editor', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    await test.step('create post', () => editorPage.createPost(slug, `Media C1 ${Date.now()}`))

    let asset!: UploadedAsset
    await test.step('upload hero image via the field dropzone', async () => {
      const body = await mediaPage.uploadViaImageFieldDropzone('heroImage', 'test-image.png')
      expect(body.ok).toBe(true)
      asset = body.data!.asset
      expect(asset.hash32).toMatch(/^[a-f0-9]{32}$/)
    })

    await test.step('field shows the uploaded image', async () => {
      await mediaPage.waitForImageFieldFilled('heroImage')
      const src = await mediaPage.imageFieldImg('heroImage').getAttribute('src')
      expect(src).toContain(asset.hash32)
    })

    await test.step('original + meta persisted on disk', async () => {
      expect(await assetOriginalExists(asset.hash32)).toBe(true)
      expect(await listAssetHashes()).toContain(asset.hash32)
    })
  })

  test('C5: structured value with real dimensions is persisted on save', async () => {
    const slug = `media-c5-${Date.now()}`
    const title = `Media C5 ${Date.now()}`
    const altText = `Hero alt ${Date.now()}`

    await test.step('open editor', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    await test.step('create post and upload hero image', async () => {
      await editorPage.createPost(slug, title)
      await mediaPage.uploadViaImageFieldDropzone('heroImage', 'test-image.png')
      await mediaPage.waitForImageFieldFilled('heroImage')
    })

    await test.step('fill alt text and save', async () => {
      await mediaPage.imageFieldAltInput('heroImage').fill(altText)
      await editorPage.saveAndVerify()
    })

    await test.step('persisted heroImage is an object with real dimensions', async () => {
      const content = await readPostContentByTitle(title)
      expect(typeof content.heroImage).toBe('object')
      expect(content.heroImage?.src).toMatch(/\/assets\//)
      expect(content.heroImage?.alt).toBe(altText)
      expect(content.heroImage?.width).toBe(640)
      expect(content.heroImage?.height).toBe(480)
    })
  })

  test('C6: saving with an image but no alt text is rejected client-side', async ({ page }) => {
    const slug = `media-c6-${Date.now()}`
    const title = `Media C6 ${Date.now()}`

    await test.step('open editor', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    await test.step('create post and upload hero image, leaving alt empty', async () => {
      await editorPage.createPost(slug, title)
      await mediaPage.uploadViaImageFieldDropzone('heroImage', 'test-image.png')
      await mediaPage.waitForImageFieldFilled('heroImage')
    })

    // ED-H1 (useDraftManager.ts): the editor runs the same pure schema rules
    // the server enforces at the write boundary BEFORE ever calling save, so
    // this never reaches the network - there is no 422 to wait for here.
    let putRequestCount = 0
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes('/api/canopycms/')) putRequestCount++
    })

    await test.step('attempt to save is blocked client-side', async () => {
      await editorPage.save()
      await expect(
        page.locator('.mantine-Notification-root', { hasText: 'Cannot save yet' }),
      ).toBeVisible({ timeout: STANDARD_TIMEOUT })
      // Scoped to the field: the same message also appears in FormRenderer's
      // form-level error summary ("heroImage.alt: Image alt text is
      // required"), which would otherwise make this a strict-mode violation.
      await expect(
        mediaPage.imageFieldContainer('heroImage').getByText('Image alt text is required'),
      ).toBeVisible()
    })

    await test.step('no request was sent and disk is unchanged', async () => {
      expect(putRequestCount).toBe(0)
      const content = await readPostContentByTitle(title)
      expect(content.heroImage).toBeUndefined()
    })
  })

  test('C3: replace via the picker preserves alt text (regression e2dddae)', async () => {
    const slug = `media-c3-${Date.now()}`
    const title = `Media C3 ${Date.now()}`
    const altText = `Alt text ${Date.now()}`

    await test.step('open editor', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    let firstHash = ''
    await test.step('create post, upload, set alt, and save', async () => {
      await editorPage.createPost(slug, title)
      const body = await mediaPage.uploadViaImageFieldDropzone('heroImage', 'test-image.png')
      firstHash = body.data!.asset.hash32
      await mediaPage.waitForImageFieldFilled('heroImage')
      await mediaPage.imageFieldAltInput('heroImage').fill(altText)
      await editorPage.saveAndVerify()
    })

    let secondHash = ''
    await test.step('replace with a different image via the picker', async () => {
      await mediaPage.openPickerViaReplace('heroImage')
      const body = await mediaPage.uploadViaDropzone(
        mediaPage.pickerModal,
        'test-image-replacement.png',
      )
      secondHash = body.data!.asset.hash32
      await expect(mediaPage.assetCard(mediaPage.pickerModal, secondHash)).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
      await mediaPage.selectAssetCardInPicker(secondHash)
    })

    await test.step('alt is unchanged, src changed, in the form', async () => {
      await expect(mediaPage.imageFieldAltInput('heroImage')).toHaveValue(altText)
      const src = await mediaPage.imageFieldImg('heroImage').getAttribute('src')
      expect(src).toContain(secondHash)
      expect(src).not.toContain(firstHash)
    })

    await test.step('save and verify persisted', async () => {
      await editorPage.saveAndVerify()
      const content = await readPostContentByTitle(title)
      expect(content.heroImage?.alt).toBe(altText)
      expect(content.heroImage?.src).toContain(secondHash)
      expect(content.heroImage?.src).not.toContain(firstHash)
    })
  })

  test('C4: remove clears the field and the persisted value', async () => {
    const slug = `media-c4-${Date.now()}`
    const title = `Media C4 ${Date.now()}`

    await test.step('open editor', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    await test.step('create post, upload, set alt, and save', async () => {
      await editorPage.createPost(slug, title)
      await mediaPage.uploadViaImageFieldDropzone('heroImage', 'test-image.png')
      await mediaPage.waitForImageFieldFilled('heroImage')
      await mediaPage.imageFieldAltInput('heroImage').fill('temporary alt')
      await editorPage.saveAndVerify()
    })

    await test.step('remove the image and save', async () => {
      await mediaPage.imageFieldRemoveButton('heroImage').click()
      await mediaPage.waitForImageFieldEmpty('heroImage')
      await editorPage.saveAndVerify()
    })

    await test.step('heroImage is gone from disk', async () => {
      const content = await readPostContentByTitle(title)
      expect(content.heroImage).toBeUndefined()
    })
  })

  test('C2: browse library adopts an existing asset without re-uploading', async ({ page }) => {
    const slugA = `media-c2a-${Date.now()}`
    const slugB = `media-c2b-${Date.now()}`

    await test.step('open editor', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    let sharedHash = ''
    await test.step('create post A and upload an image', async () => {
      await editorPage.createPost(slugA, `Media C2 A ${Date.now()}`)
      const body = await mediaPage.uploadViaImageFieldDropzone('heroImage', 'test-image.png')
      sharedHash = body.data!.asset.hash32
      await mediaPage.waitForImageFieldFilled('heroImage')
    })

    let uploadRequestCount = 0
    await test.step('create post B and open the browse-library picker', async () => {
      await editorPage.createPost(slugB, `Media C2 B ${Date.now()}`)
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().includes('/assets/upload')) uploadRequestCount++
      })
      await mediaPage.openPickerViaBrowseLibrary('heroImage')
      await expect(mediaPage.assetCard(mediaPage.pickerModal, sharedHash)).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
    })

    await test.step('pick the existing asset', async () => {
      await mediaPage.selectAssetCardInPicker(sharedHash)
      await mediaPage.waitForImageFieldFilled('heroImage')
      const src = await mediaPage.imageFieldImg('heroImage').getAttribute('src')
      expect(src).toContain(sharedHash)
    })

    await test.step('no second upload request fired', () => {
      expect(uploadRequestCount).toBe(0)
    })
  })

  test('C7: media library manage drawer lists and filters assets', async () => {
    await test.step('open editor', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    await test.step('open the manage drawer', () => mediaPage.openMediaLibraryManage())

    let hash1 = ''
    let hash2 = ''
    await test.step('upload two distinct assets', async () => {
      const body1 = await mediaPage.uploadViaDropzone(mediaPage.manageDrawer, 'test-image.png')
      hash1 = body1.data!.asset.hash32
      await expect(mediaPage.assetCard(mediaPage.manageDrawer, hash1)).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })

      const body2 = await mediaPage.uploadViaDropzone(
        mediaPage.manageDrawer,
        'test-image-replacement.png',
      )
      hash2 = body2.data!.asset.hash32
      await expect(mediaPage.assetCard(mediaPage.manageDrawer, hash2)).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
    })

    await test.step('both asset cards render', async () => {
      await expect(mediaPage.assetCard(mediaPage.manageDrawer, hash1)).toBeVisible()
      await expect(mediaPage.assetCard(mediaPage.manageDrawer, hash2)).toBeVisible()
    })

    await test.step('filter narrows to the matching filename', async () => {
      // Only 'test-image-replacement.png' contains 'replacement'.
      await mediaPage.filterInput(mediaPage.manageDrawer).fill('replacement')
      await expect(mediaPage.assetCard(mediaPage.manageDrawer, hash2)).toBeVisible()
      await expect(mediaPage.assetCard(mediaPage.manageDrawer, hash1)).not.toBeVisible()
    })
  })

  test('C8: a transform is served, cached on disk, and served again from cache', async ({
    page,
  }) => {
    await test.step('open editor', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    await test.step('open manage drawer', () => mediaPage.openMediaLibraryManage())

    let src = ''
    let hash32 = ''
    await test.step('upload an asset', async () => {
      const body = await mediaPage.uploadViaDropzone(mediaPage.manageDrawer, 'test-image.png')
      src = body.data!.asset.src
      hash32 = body.data!.asset.hash32
      expect(src).toMatch(/^\/assets\/t\/orig\//)
    })

    // Width must be on the allowlist (multiple of 160, [160,4096] - see
    // transform-directives.ts) - 320 is the smallest valid step above 160.
    const derivedUrl = src.replace('/orig/', '/w=320/')

    await test.step('first request computes and serves the transform', async () => {
      const response = await page.request.get(derivedUrl)
      expect(response.status()).toBe(200)
      expect(response.headers()['content-type']).toMatch(/^image\//)
      const body = await response.body()
      expect(body.byteLength).toBeGreaterThan(0)
    })

    await test.step('transform output is cached on disk under assets/t/', async () => {
      const dirs = await listTransformDirs(hash32)
      expect(dirs).toContain('w=320')
    })

    await test.step('second request is served FROM the cache: delete the original first, so a recompute is impossible', async () => {
      // The raw-asset route checks the public object store before ever
      // falling through to serveLazyTransform (which needs the original).
      // With the original gone, a 200 here can only come from the cached
      // output — a broken cache lookup would recompute, fail to read the
      // original, and 404. Without this deletion the step could not fail:
      // a recompute also returns 200.
      await removeAssetOriginals(hash32)
      const response = await page.request.get(derivedUrl)
      expect(response.status()).toBe(200)
      expect(response.headers()['content-type']).toMatch(/^image\//)
    })
  })
})
