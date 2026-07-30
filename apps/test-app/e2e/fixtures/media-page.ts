import path from 'node:path'
import { type Page, type Locator, type Response, expect } from '@playwright/test'
import { SHORT_TIMEOUT, STANDARD_TIMEOUT, LONG_TIMEOUT } from './timeouts'

const FIXTURES_ASSETS_DIR = path.resolve(process.cwd(), 'apps/test-app/e2e/fixtures/assets')

/** Absolute path to a fixture image under e2e/fixtures/assets/. */
export function fixtureImagePath(fileName: string): string {
  return path.join(FIXTURES_ASSETS_DIR, fileName)
}

/** The `AssetRecord` shape returned by finalize/upload (see api/assets.ts). */
export interface UploadedAsset {
  hash32: string
  filename: string
  slug: string
  ext: string
  mime: string
  size: number
  width?: number
  height?: number
  kind: string
  uploadedAt: string
  src: string
}

/** Wire shape of `FinalizeAssetResponse` (api/types.ts's `ApiResponse` envelope). */
export interface FinalizeAssetResponseBody {
  ok: boolean
  status: number
  data?: { asset: UploadedAsset }
  error?: string
}

/**
 * Page object for the assets/media pipeline: a single structured `image`
 * field (ImageField's dropzone/alt/replace/remove/browse-library controls)
 * plus the shared MediaLibrary presentation -- the picker Modal ("Browse
 * library"/"Replace") and the manage Drawer (sidebar Settings -> "Media
 * library"). Both presentations share the same grid/upload/filter core
 * (MediaLibraryBody), so the grid-level helpers below take a `container`
 * locator (`pickerModal` or `manageDrawer`) rather than duplicating a method
 * per presentation.
 */
export class MediaPage {
  readonly page: Page

  readonly pickerModal: Locator
  readonly manageDrawer: Locator
  readonly settingsButton: Locator
  readonly mediaLibraryMenuItem: Locator

  constructor(page: Page) {
    this.page = page
    this.pickerModal = page.locator('[data-testid="media-library-picker"]')
    this.manageDrawer = page.locator('[data-testid="media-library-manage"]')
    this.settingsButton = page.getByRole('button', { name: 'Settings' })
    this.mediaLibraryMenuItem = page.getByRole('menuitem', { name: 'Media library' })
  }

  // ---- ImageField: a single structured `image` field, e.g. `heroImage` ----

  imageFieldContainer(field: string): Locator {
    return this.page.locator(`[data-testid="image-field-${field}"]`)
  }

  imageFieldDropzoneInput(field: string): Locator {
    return this.page.locator(`[data-testid="image-field-dropzone-${field}"] input[type="file"]`)
  }

  imageFieldImg(field: string): Locator {
    return this.imageFieldContainer(field).locator('img')
  }

  imageFieldAltInput(field: string): Locator {
    return this.page.locator(`[data-testid="image-field-alt-${field}"]`)
  }

  imageFieldReplaceButton(field: string): Locator {
    return this.page.locator(`[data-testid="image-field-replace-${field}"]`)
  }

  imageFieldRemoveButton(field: string): Locator {
    return this.page.locator(`[data-testid="image-field-remove-${field}"]`)
  }

  imageFieldBrowseLibraryButton(field: string): Locator {
    return this.page.locator(`[data-testid="image-field-browse-library-${field}"]`)
  }

  /**
   * Upload `fixtureFileName` through an ImageField's empty-state dropzone
   * (the proxied `POST .../assets/upload` path -- LocalAssetStore has no
   * direct-upload capability, see media-upload.spec.ts's header comment) and
   * wait for its response. Returns the parsed body so callers can read
   * `data.asset.hash32`/`.src` for later disk/URL assertions.
   */
  async uploadViaImageFieldDropzone(
    field: string,
    fixtureFileName: string,
  ): Promise<FinalizeAssetResponseBody> {
    const response = await this.uploadAndWait(() =>
      this.imageFieldDropzoneInput(field).setInputFiles(fixtureImagePath(fixtureFileName)),
    )
    return response.json()
  }

  /** Wait for the field to reach its filled state (alt input visible). */
  async waitForImageFieldFilled(field: string): Promise<void> {
    await expect(this.imageFieldAltInput(field)).toBeVisible({ timeout: STANDARD_TIMEOUT })
  }

  /** Wait for the field to reach its empty state (dropzone visible again). */
  async waitForImageFieldEmpty(field: string): Promise<void> {
    await expect(this.imageFieldDropzoneInput(field)).toBeAttached({ timeout: STANDARD_TIMEOUT })
  }

  // ---- MediaLibrary: shared picker Modal / manage Drawer ----

  dropzoneInput(container: Locator): Locator {
    return container.locator('[data-testid="media-library-dropzone"] input[type="file"]')
  }

  filterInput(container: Locator): Locator {
    return container.locator('[data-testid="media-library-filter"]')
  }

  assetCard(container: Locator, hash32: string): Locator {
    return container.locator(`[data-testid="asset-card-${hash32}"]`)
  }

  /**
   * Upload `fixtureFileName` through a MediaLibrary grid's own dropzone
   * (picker or manage). Unlike ImageField's dropzone, this only adds the
   * asset to the grid -- it does NOT select it (MediaLibraryBody.handleDrop
   * never calls `onSelect`); picker flows must still click the resulting
   * `assetCard()` to select it.
   */
  async uploadViaDropzone(
    container: Locator,
    fixtureFileName: string,
  ): Promise<FinalizeAssetResponseBody> {
    const response = await this.uploadAndWait(() =>
      this.dropzoneInput(container).setInputFiles(fixtureImagePath(fixtureFileName)),
    )
    return response.json()
  }

  /**
   * Open the manage Drawer via the sidebar's Settings menu -> "Media
   * library", and wait for its body to be interactive.
   *
   * Waits on `filterInput()`, not `manageDrawer` itself: Mantine's Drawer
   * "root" (where the `data-testid` prop lands) is a `position: static` box
   * with no in-flow content -- its actual dialog is a `position: fixed`
   * descendant, so the root's own bounding box is always 0x0 even while
   * genuinely open (confirmed via a live DOM inspection: `childCount`/rect
   * only become non-zero once open, but height stays 0 throughout). It's
   * still a real ancestor of the dialog content (`.contains()` is true), so
   * scoping `dropzoneInput()`/`filterInput()`/`assetCard()` off it for
   * actions works fine -- only a direct `toBeVisible()` on the root itself
   * is unusable.
   */
  async openMediaLibraryManage(): Promise<void> {
    await this.settingsButton.click()
    await expect(this.mediaLibraryMenuItem).toBeVisible({ timeout: SHORT_TIMEOUT })
    await this.mediaLibraryMenuItem.click()
    await expect(this.filterInput(this.manageDrawer)).toBeVisible({ timeout: STANDARD_TIMEOUT })
  }

  /**
   * Open the picker Modal via an ImageField's "Browse library" button (empty
   * state). See {@link openMediaLibraryManage}'s doc comment for why this
   * waits on `filterInput()` rather than `pickerModal` itself.
   */
  async openPickerViaBrowseLibrary(field: string): Promise<void> {
    await this.imageFieldBrowseLibraryButton(field).click()
    await expect(this.filterInput(this.pickerModal)).toBeVisible({ timeout: STANDARD_TIMEOUT })
  }

  /** Open the picker Modal via an ImageField's "Replace" button (filled state). */
  async openPickerViaReplace(field: string): Promise<void> {
    await this.imageFieldReplaceButton(field).click()
    await expect(this.filterInput(this.pickerModal)).toBeVisible({ timeout: STANDARD_TIMEOUT })
  }

  /** Click an asset card in an open picker Modal, which selects it and closes the modal. */
  async selectAssetCardInPicker(hash32: string): Promise<void> {
    await this.assetCard(this.pickerModal, hash32).click()
    await expect(this.filterInput(this.pickerModal)).not.toBeVisible({ timeout: STANDARD_TIMEOUT })
  }

  /** Race a page action against the upload response it triggers; asserts 200. */
  private async uploadAndWait(action: () => Promise<void>): Promise<Response> {
    const [response] = await Promise.all([
      this.page.waitForResponse(
        (resp) => resp.url().includes('/assets/upload') && resp.request().method() === 'POST',
        { timeout: LONG_TIMEOUT },
      ),
      action(),
    ])
    expect(response.status()).toBe(200)
    return response
  }
}
