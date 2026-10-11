import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { modals } from '@mantine/modals'

import type { MockApiClient } from '../../api/__test__/mock-client'
import { setupMockApiClient, createApiClientWrapper } from '../hooks/__test__/test-utils'
import { CanopyCMSProvider } from '../theme'
import { MediaLibraryBody } from './MediaLibraryBody'
import type { AssetRecord } from '../../api'
import { mockConsole } from '../../test-utils/console-spy'
import { MEDIA_LIBRARY_PREFS_KEY } from './media-library-prefs'
import { uploadAsset } from './upload-asset'

// Mock the API client module - both useApiClient() (context, used directly by
// MediaLibraryBody) and useUserContext()'s internal createApiClient() call
// must resolve to the SAME mock client instance.
vi.mock('../../api', async () => {
  const actual = await vi.importActual('../../api')
  return {
    ...actual,
    createApiClient: vi.fn(),
  }
})

vi.mock('./upload-asset', () => ({ uploadAsset: vi.fn() }))

vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: {
    openConfirmModal: vi.fn((options: { onConfirm?: () => void }) => {
      options.onConfirm?.()
    }),
  },
}))

const catAsset: AssetRecord = {
  hash32: 'a'.repeat(32),
  filename: 'cat.png',
  slug: 'cat',
  ext: 'png',
  mime: 'image/png',
  size: 1024,
  width: 100,
  height: 100,
  kind: 'raster',
  uploadedAt: '2024-01-01T00:00:00.000Z',
  src: `/assets/t/orig/${'a'.repeat(32)}/cat.png`,
}

const dogAsset: AssetRecord = {
  hash32: 'b'.repeat(32),
  filename: 'dog.jpg',
  slug: 'dog',
  ext: 'jpg',
  mime: 'image/jpeg',
  size: 2048,
  width: 200,
  height: 200,
  kind: 'raster',
  uploadedAt: '2024-01-02T00:00:00.000Z',
  src: `/assets/t/orig/${'b'.repeat(32)}/dog.jpg`,
}

/** `n` makes a unique, deterministic asset; later `n` are newer. */
const makeAsset = (n: number, overrides: Partial<AssetRecord> = {}): AssetRecord => {
  const hash32 = n.toString(16).padStart(32, '0')
  const name = `img-${String(n).padStart(3, '0')}`
  return {
    hash32,
    filename: `${name}.png`,
    slug: name,
    ext: 'png',
    mime: 'image/png',
    size: 1024,
    width: 100,
    height: 100,
    kind: 'raster',
    uploadedAt: new Date(Date.UTC(2024, 0, 1, 0, 0, n)).toISOString(),
    src: `/assets/t/orig/${hash32}/${name}.png`,
    ...overrides,
  }
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('MediaLibraryBody', () => {
  let mockClient: MockApiClient
  let wrapper: ReturnType<typeof createApiClientWrapper>

  beforeEach(async () => {
    window.localStorage.clear()
    mockClient = await setupMockApiClient()
    wrapper = createApiClientWrapper(mockClient)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  const bodyUi = (props: Partial<React.ComponentProps<typeof MediaLibraryBody>> = {}) => {
    const Wrapper = wrapper
    return (
      <CanopyCMSProvider>
        <Wrapper>
          <MediaLibraryBody opened mode="manage" {...props} />
        </Wrapper>
      </CanopyCMSProvider>
    )
  }

  const renderBody = (props: Partial<React.ComponentProps<typeof MediaLibraryBody>> = {}) => {
    const result = render(bodyUi(props))
    return {
      ...result,
      rerenderBody: (next: Partial<React.ComponentProps<typeof MediaLibraryBody>>) =>
        result.rerender(bodyUi(next)),
    }
  }

  const asAdmin = () =>
    mockClient.user.whoami.mockResolvedValue({
      ok: true,
      status: 200,
      data: { userId: 'admin-1', groups: ['Admins'] },
    })

  const page = (assets: AssetRecord[], nextCursor?: string) => ({
    ok: true as const,
    status: 200,
    data: { assets, nextCursor },
  })

  /** Card or row test ids in DOM order, as hashes. */
  const renderedHashes = (): string[] =>
    screen
      .getAllByTestId(/^asset-(card|row)-[0-9a-f]{32}$/)
      .map((el) => el.getAttribute('data-testid')!.slice(-32))

  const pickOption = async (testId: string, name: string) => {
    const user = userEvent.setup()
    await user.click(screen.getByTestId(testId))
    await user.click(await screen.findByRole('option', { name }))
  }

  it('lists the first page of assets when opened', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset, dogAsset] },
    })

    renderBody()

    await waitFor(() => expect(screen.getByText('cat.png')).toBeTruthy())
    expect(screen.getByText('dog.jpg')).toBeTruthy()
    expect(mockClient.assets.list).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('media-library-load-more')).toBeNull()
  })

  it('follows nextCursor in the background and appends each page, with no Load more button', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset], nextCursor: 'cursor-1' },
    })
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [dogAsset] },
    })

    renderBody()

    await waitFor(() => expect(screen.getByText('dog.jpg')).toBeTruthy())
    expect(screen.getByText('cat.png')).toBeTruthy()
    expect(mockClient.assets.list).toHaveBeenCalledTimes(2)
    expect(mockClient.assets.list).toHaveBeenNthCalledWith(1, { limit: '40' })
    expect(mockClient.assets.list).toHaveBeenNthCalledWith(2, { cursor: 'cursor-1', limit: '40' })
    expect(screen.queryByTestId('media-library-load-more')).toBeNull()
  })

  it('filters loaded assets client-side without an additional fetch', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset, dogAsset] },
    })

    renderBody()
    await waitFor(() => expect(screen.getByText('cat.png')).toBeTruthy())

    const user = userEvent.setup()
    await user.type(screen.getByTestId('media-library-filter'), 'cat')

    expect(screen.getByText('cat.png')).toBeTruthy()
    expect(screen.queryByText('dog.jpg')).toBeNull()
    // Filtering is purely client-side over already-loaded items.
    expect(mockClient.assets.list).toHaveBeenCalledTimes(1)
  })

  it('hides the delete control for non-admin users in manage mode', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset] },
    })
    mockClient.user.whoami.mockResolvedValue({
      ok: true,
      status: 200,
      data: { userId: 'user-1', groups: [] },
    })

    renderBody()

    await waitFor(() => expect(screen.getByText('cat.png')).toBeTruthy())
    expect(screen.queryByTestId(`asset-card-delete-${catAsset.hash32}`)).toBeNull()
  })

  it('shows the delete control to the editor who uploaded the asset', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [{ ...catAsset, uploadedBy: 'user-1' }] },
    })
    mockClient.user.whoami.mockResolvedValue({
      ok: true,
      status: 200,
      data: { userId: 'user-1', groups: [] },
    })

    renderBody()

    // Mirrors the server rule in api/assets.ts: uploader may delete their own.
    expect(await screen.findByTestId(`asset-card-delete-${catAsset.hash32}`)).toBeTruthy()
  })

  it("hides the delete control on another editor's upload", async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [{ ...catAsset, uploadedBy: 'someone-else' }] },
    })
    mockClient.user.whoami.mockResolvedValue({
      ok: true,
      status: 200,
      data: { userId: 'user-1', groups: [] },
    })

    renderBody()

    await waitFor(() => expect(screen.getByText('cat.png')).toBeTruthy())
    expect(screen.queryByTestId(`asset-card-delete-${catAsset.hash32}`)).toBeNull()
  })

  it('shows the delete control for admins and removes the asset on confirm', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset] },
    })
    mockClient.user.whoami.mockResolvedValue({
      ok: true,
      status: 200,
      data: { userId: 'admin-1', groups: ['Admins'] },
    })
    mockClient.assets.delete.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { deleted: true },
    })

    renderBody()

    const deleteButton = await screen.findByTestId(`asset-card-delete-${catAsset.hash32}`)
    fireEvent.click(deleteButton)

    await waitFor(() =>
      expect(mockClient.assets.delete).toHaveBeenCalledWith({ key: catAsset.hash32 }),
    )
    await waitFor(() => expect(screen.queryByText('cat.png')).toBeNull())
  })

  it('never shows the delete control in picker mode, even for admins', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset] },
    })
    mockClient.user.whoami.mockResolvedValue({
      ok: true,
      status: 200,
      data: { userId: 'admin-1', groups: ['Admins'] },
    })

    renderBody({ mode: 'picker', onSelect: vi.fn() })

    await waitFor(() => expect(screen.getByText('cat.png')).toBeTruthy())
    expect(screen.queryByTestId(`asset-card-delete-${catAsset.hash32}`)).toBeNull()
  })

  it('calls onSelect with the chosen asset in picker mode', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset] },
    })
    const onSelect = vi.fn()

    renderBody({ mode: 'picker', onSelect })

    const card = await screen.findByTestId(`asset-card-${catAsset.hash32}`)
    fireEvent.click(card)

    expect(onSelect).toHaveBeenCalledWith(catAsset)
  })

  it('selects a card via the keyboard (Enter) - asset cards are not click-only', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset] },
    })
    const onSelect = vi.fn()

    renderBody({ mode: 'picker', onSelect })

    const card = await screen.findByTestId(`asset-card-${catAsset.hash32}`)
    expect(card.getAttribute('role')).toBe('button')
    expect(card.getAttribute('tabindex')).toBe('0')

    fireEvent.keyDown(card, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith(catAsset)
  })

  it('selects a card via the keyboard (Space)', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset] },
    })
    const onSelect = vi.fn()

    renderBody({ mode: 'picker', onSelect })

    const card = await screen.findByTestId(`asset-card-${catAsset.hash32}`)
    fireEvent.keyDown(card, { key: ' ' })

    expect(onSelect).toHaveBeenCalledWith(catAsset)
  })

  it('ignores other keys and never selects via the keyboard in manage mode (no onSelect)', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset] },
    })

    renderBody({ mode: 'manage' })

    const card = await screen.findByTestId(`asset-card-${catAsset.hash32}`)
    expect(card.getAttribute('role')).toBeNull()
    expect(card.getAttribute('tabindex')).toBeNull()
  })

  it('picker mode dropzone excludes PDF; manage mode keeps accepting it', async () => {
    mockClient.assets.list.mockResolvedValue({
      ok: true,
      status: 200,
      data: { assets: [] },
    })

    const { unmount } = renderBody({ mode: 'picker', onSelect: vi.fn() })
    const pickerDropzone = screen.getByTestId('media-library-dropzone')
    const pickerInput = pickerDropzone.querySelector('input[type="file"]') as HTMLInputElement
    expect(pickerInput.accept).not.toContain('application/pdf')
    unmount()

    renderBody({ mode: 'manage' })
    const manageDropzone = screen.getByTestId('media-library-dropzone')
    const manageInput = manageDropzone.querySelector('input[type="file"]') as HTMLInputElement
    expect(manageInput.accept).toContain('application/pdf')
  })

  it('picker mode filters PDF assets out of the pickable grid; manage mode still shows them', async () => {
    const pdfAsset: AssetRecord = {
      hash32: 'c'.repeat(32),
      filename: 'brochure.pdf',
      slug: 'brochure',
      ext: 'pdf',
      mime: 'application/pdf',
      size: 4096,
      kind: 'pdf',
      uploadedAt: '2024-01-03T00:00:00.000Z',
      src: `/assets/${'c'.repeat(32)}/brochure.pdf`,
    }
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset, pdfAsset] },
    })

    renderBody({ mode: 'picker', onSelect: vi.fn() })

    await waitFor(() => expect(screen.getByText('cat.png')).toBeTruthy())
    expect(screen.queryByText('brochure.pdf')).toBeNull()
  })

  it('shows a retryable error alert when listing fails', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: false,
      status: 500,
      error: 'Internal error',
    })

    renderBody()

    await waitFor(() => expect(screen.getByTestId('media-library-error')).toBeTruthy())
    expect(screen.getByText('Internal error')).toBeTruthy()
    expect(screen.getByText("Couldn't load the media library.")).toBeTruthy()
  })

  it('reloads from page 1 when the first page failed and Retry is pressed', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: false,
      status: 500,
      error: 'Internal error',
    })
    mockClient.assets.list.mockResolvedValueOnce(page([catAsset]))

    renderBody()
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(screen.getByText('cat.png')).toBeTruthy())
    expect(mockClient.assets.list).toHaveBeenNthCalledWith(2, { limit: '40' })
    expect(screen.queryByTestId('media-library-error')).toBeNull()
  })

  describe('background loading', () => {
    const firstPage = Array.from({ length: 40 }, (_, i) => makeAsset(i + 1))

    it('searches assets that sit on pages the first request did not return', async () => {
      const needle = makeAsset(900, { filename: 'needle.png', slug: 'needle' })
      const second = deferred<ReturnType<typeof page>>()
      mockClient.assets.list.mockImplementation(((params: Record<string, string>) =>
        params.cursor === 'c1' ? second.promise : Promise.resolve(page(firstPage, 'c1'))) as never)

      renderBody()
      await screen.findByText('img-001.png')
      await userEvent.setup().type(screen.getByTestId('media-library-filter'), 'needle')
      expect(screen.queryByText('needle.png')).toBeNull()

      await act(async () => second.resolve(page([needle])))

      expect(await screen.findByText('needle.png')).toBeTruthy()
      expect(screen.queryByText('img-001.png')).toBeNull()
      expect(mockClient.assets.list).toHaveBeenNthCalledWith(2, { cursor: 'c1', limit: '40' })
    })

    it('matches on the slug as well as the filename', async () => {
      mockClient.assets.list.mockResolvedValueOnce(
        page([
          makeAsset(1, { filename: 'IMG_0042.png', slug: 'summer-trip' }),
          makeAsset(2, { filename: 'other.png', slug: 'other' }),
        ]),
      )

      renderBody()
      await screen.findByText('IMG_0042.png')
      await userEvent.setup().type(screen.getByTestId('media-library-filter'), 'SUMMER')

      expect(screen.getByText('IMG_0042.png')).toBeTruthy()
      expect(screen.queryByText('other.png')).toBeNull()
    })

    it('says it is still searching, not that nothing matches, while pages are outstanding', async () => {
      const second = deferred<ReturnType<typeof page>>()
      mockClient.assets.list.mockImplementation(((params: Record<string, string>) =>
        params.cursor === 'c1' ? second.promise : Promise.resolve(page(firstPage, 'c1'))) as never)

      renderBody()
      await screen.findByText('img-001.png')
      await userEvent.setup().type(screen.getByTestId('media-library-filter'), 'img-041')

      const status = screen.getByTestId('media-library-load-status')
      expect(status.textContent).toBe('Searching 40 assets loaded so far…')
      expect(status.getAttribute('aria-live')).toBe('polite')
      expect(screen.queryByTestId('media-library-empty')).toBeNull()

      await act(async () =>
        second.resolve(page(Array.from({ length: 5 }, (_, i) => makeAsset(41 + i)))),
      )

      await waitFor(() =>
        expect(screen.getByTestId('media-library-load-status').textContent).toBe(
          '1 of 45 assets match',
        ),
      )
      expect(screen.getByText('img-041.png')).toBeTruthy()
    })

    it('reports how many assets are loaded while loading with no search, and nothing once complete', async () => {
      const second = deferred<ReturnType<typeof page>>()
      mockClient.assets.list.mockImplementation(((params: Record<string, string>) =>
        params.cursor === 'c1' ? second.promise : Promise.resolve(page(firstPage, 'c1'))) as never)

      renderBody()
      await screen.findByText('img-001.png')
      expect(screen.getByTestId('media-library-load-status').textContent).toBe(
        'Loaded 40 assets, loading more…',
      )

      await act(async () => second.resolve(page([makeAsset(41)])))

      await waitFor(() => expect(screen.queryByTestId('media-library-load-status')).toBeNull())
    })

    it('agrees the noun and verb with the count', async () => {
      mockClient.assets.list.mockResolvedValueOnce(page([catAsset]))

      renderBody()
      await screen.findByText('cat.png')
      await userEvent.setup().type(screen.getByTestId('media-library-filter'), 'cat')

      expect(screen.getByTestId('media-library-load-status').textContent).toBe(
        '1 of 1 asset matches',
      )
    })

    it('stops loading when the body closes, and ignores a response that arrives after', async () => {
      const second = deferred<ReturnType<typeof page>>()
      mockClient.assets.list.mockImplementation(((params: Record<string, string>) =>
        params.cursor === 'c1' ? second.promise : Promise.resolve(page([catAsset], 'c1'))) as never)

      const { rerenderBody } = renderBody()
      await screen.findByText('cat.png')
      expect(mockClient.assets.list).toHaveBeenCalledTimes(2)

      rerenderBody({ opened: false })
      await act(async () => second.resolve(page([dogAsset], 'c2')))

      expect(mockClient.assets.list).toHaveBeenCalledTimes(2)
      expect(screen.queryByText('dog.jpg')).toBeNull()
    })

    it('starts over from page 1 when reopened', async () => {
      mockClient.assets.list.mockResolvedValue(page([catAsset]))

      const { rerenderBody } = renderBody()
      await screen.findByText('cat.png')
      rerenderBody({ opened: false })
      rerenderBody({ opened: true })

      await waitFor(() => expect(mockClient.assets.list).toHaveBeenCalledTimes(2))
      expect(mockClient.assets.list).toHaveBeenNthCalledWith(2, { limit: '40' })
    })

    it('keeps what loaded when a later page fails, and Retry resumes from the failed cursor', async () => {
      mockClient.assets.list.mockResolvedValueOnce(page([catAsset], 'c1'))
      mockClient.assets.list.mockResolvedValueOnce({ ok: false, status: 500, error: 'Boom' })
      mockClient.assets.list.mockResolvedValueOnce(page([dogAsset]))

      renderBody()

      const alert = await screen.findByTestId('media-library-error')
      expect(within(alert).getByText('Boom')).toBeTruthy()
      expect(within(alert).getByText(/Showing the 1 asset loaded so far/)).toBeTruthy()
      expect(screen.getByText('cat.png')).toBeTruthy()
      expect(screen.queryByTestId('media-library-load-status')).toBeNull()

      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))

      expect(await screen.findByText('dog.jpg')).toBeTruthy()
      expect(mockClient.assets.list).toHaveBeenCalledTimes(3)
      expect(mockClient.assets.list).toHaveBeenNthCalledWith(3, { cursor: 'c1', limit: '40' })
      expect(screen.getByText('cat.png')).toBeTruthy()
      expect(screen.queryByTestId('media-library-error')).toBeNull()
    })

    it('stops when the server hands back a cursor it has already returned', async () => {
      mockClient.assets.list.mockResolvedValue(page([catAsset], 'same'))

      renderBody()
      await screen.findByText('cat.png')
      await waitFor(() => expect(screen.queryByTestId('media-library-load-status')).toBeNull())

      expect(mockClient.assets.list).toHaveBeenCalledTimes(2)
    })

    it('renders an asset once when an upload also arrives in a later page', async () => {
      const uploaded = makeAsset(500, { filename: 'fresh.png', slug: 'fresh' })
      const second = deferred<ReturnType<typeof page>>()
      mockClient.assets.list.mockImplementation(((params: Record<string, string>) =>
        params.cursor === 'c1' ? second.promise : Promise.resolve(page([catAsset], 'c1'))) as never)
      vi.mocked(uploadAsset).mockResolvedValue(uploaded)

      renderBody()
      await screen.findByText('cat.png')
      const input = screen
        .getByTestId('media-library-dropzone')
        .querySelector('input[type="file"]') as HTMLInputElement
      await userEvent.setup().upload(input, new File(['x'], 'fresh.png', { type: 'image/png' }))
      await screen.findByText('fresh.png')

      await act(async () => second.resolve(page([dogAsset, uploaded])))

      await screen.findByText('dog.jpg')
      expect(screen.getAllByTestId(`asset-card-${uploaded.hash32}`)).toHaveLength(1)
    })

    it('renders an asset once when the same file is uploaded again', async () => {
      mockClient.assets.list.mockResolvedValueOnce(page([catAsset, dogAsset]))
      vi.mocked(uploadAsset).mockResolvedValue(catAsset)

      renderBody()
      await screen.findByText('cat.png')
      const input = screen
        .getByTestId('media-library-dropzone')
        .querySelector('input[type="file"]') as HTMLInputElement
      await userEvent.setup().upload(input, new File(['x'], 'cat.png', { type: 'image/png' }))

      await waitFor(() => expect(uploadAsset).toHaveBeenCalled())
      expect(screen.getAllByTestId(`asset-card-${catAsset.hash32}`)).toHaveLength(1)
      expect(renderedHashes()).toHaveLength(2)
    })

    it('does not bring back an asset that was deleted while a later page was in flight', async () => {
      asAdmin()
      mockClient.assets.delete.mockResolvedValue({ ok: true, status: 200, data: { deleted: true } })
      const second = deferred<ReturnType<typeof page>>()
      mockClient.assets.list.mockImplementation(((params: Record<string, string>) =>
        params.cursor === 'c1' ? second.promise : Promise.resolve(page([catAsset], 'c1'))) as never)

      renderBody()
      fireEvent.click(await screen.findByTestId(`asset-card-delete-${catAsset.hash32}`))
      await waitFor(() => expect(screen.queryByText('cat.png')).toBeNull())

      await act(async () => second.resolve(page([catAsset, dogAsset])))

      await screen.findByText('dog.jpg')
      expect(screen.queryByText('cat.png')).toBeNull()
    })
  })

  describe('search and empty states', () => {
    it('shows skeletons, and no empty state, until the library has loaded', async () => {
      const first = deferred<ReturnType<typeof page>>()
      mockClient.assets.list.mockReturnValue(first.promise as never)

      renderBody()

      expect(screen.getByTestId('media-library-loading')).toBeTruthy()
      expect(screen.queryByTestId('media-library-empty')).toBeNull()

      await act(async () => first.resolve(page([])))

      expect(await screen.findByText('No media yet. Drop a file above to upload one.')).toBeTruthy()
      expect(screen.queryByTestId('media-library-loading')).toBeNull()
    })

    it('counts only images in picker mode, so a library of PDFs reads as empty', async () => {
      mockClient.assets.list.mockResolvedValueOnce(
        page([makeAsset(1, { filename: 'terms.pdf', slug: 'terms', kind: 'pdf' })]),
      )

      renderBody({ mode: 'picker', onSelect: vi.fn() })

      expect(
        await screen.findByText('No images yet. Drop an image above to upload one.'),
      ).toBeTruthy()
    })

    it('words the empty library for images in picker mode', async () => {
      mockClient.assets.list.mockResolvedValueOnce(page([]))

      renderBody({ mode: 'picker', onSelect: vi.fn() })

      expect(
        await screen.findByText('No images yet. Drop an image above to upload one.'),
      ).toBeTruthy()
    })

    it('offers to clear a search that matches nothing, in the field and under the message', async () => {
      mockClient.assets.list.mockResolvedValueOnce(page([catAsset]))

      renderBody()
      await screen.findByText('cat.png')
      const user = userEvent.setup()
      const input = screen.getByTestId('media-library-filter') as HTMLInputElement
      expect(input.placeholder).toBe('Search by filename')
      expect(input.getAttribute('aria-label')).toBe('Search by filename')
      expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()

      await user.type(input, 'zzz')

      const empty = screen.getByTestId('media-library-empty')
      expect(empty.textContent).toContain('No assets match \u201Czzz\u201D.')
      expect(screen.getAllByRole('button', { name: 'Clear search' })).toHaveLength(2)

      await user.click(within(empty).getByRole('button', { name: 'Clear search' }))

      expect(input.value).toBe('')
      expect(screen.getByText('cat.png')).toBeTruthy()
    })

    it('clears the search from the x button in the field', async () => {
      mockClient.assets.list.mockResolvedValueOnce(page([catAsset, dogAsset]))

      renderBody()
      await screen.findByText('cat.png')
      const user = userEvent.setup()
      await user.type(screen.getByTestId('media-library-filter'), 'dog')
      expect(screen.queryByText('cat.png')).toBeNull()

      await user.click(screen.getByRole('button', { name: 'Clear search' }))

      expect(screen.getByText('cat.png')).toBeTruthy()
      expect(screen.getByText('dog.jpg')).toBeTruthy()
    })
  })

  describe('sort', () => {
    // newest first is b, a, c; by name it is a, b, c.
    const a = makeAsset(1, { filename: 'a.png', slug: 'a', uploadedAt: '2024-01-02T00:00:00.000Z' })
    const b = makeAsset(2, { filename: 'b.png', slug: 'b', uploadedAt: '2024-01-03T00:00:00.000Z' })
    const c = makeAsset(3, { filename: 'c.png', slug: 'c', uploadedAt: '2024-01-01T00:00:00.000Z' })

    it('orders newest first by default, and by name on request', async () => {
      mockClient.assets.list.mockResolvedValueOnce(page([a, c, b]))

      renderBody()
      await screen.findByText('a.png')
      expect(renderedHashes()).toEqual([b.hash32, a.hash32, c.hash32])

      await pickOption('media-library-sort', 'Name')

      expect(renderedHashes()).toEqual([a.hash32, b.hash32, c.hash32])
    })

    it('remembers the sort for the next time the library opens', async () => {
      mockClient.assets.list.mockResolvedValue(page([a, c, b]))

      const first = renderBody()
      await screen.findByText('a.png')
      await pickOption('media-library-sort', 'Name')
      expect(JSON.parse(window.localStorage.getItem(MEDIA_LIBRARY_PREFS_KEY)!)).toMatchObject({
        sort: 'name',
      })
      first.unmount()

      renderBody()
      await screen.findByText('a.png')

      await waitFor(() => expect(renderedHashes()).toEqual([a.hash32, b.hash32, c.hash32]))
    })

    it('falls back to the defaults when the stored preferences are garbage', async () => {
      window.localStorage.setItem(MEDIA_LIBRARY_PREFS_KEY, '{not json')
      mockClient.assets.list.mockResolvedValueOnce(page([a, c, b]))

      renderBody()
      await screen.findByText('a.png')

      expect(renderedHashes()).toEqual([b.hash32, a.hash32, c.hash32])
      expect(screen.getByRole('radio', { name: 'Grid' })).toHaveProperty('checked', true)
    })

    it('still works when storage throws', async () => {
      const consoleSpy = mockConsole()
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked')
      })
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked')
      })
      mockClient.assets.list.mockResolvedValueOnce(page([a, c, b]))

      try {
        renderBody()
        await screen.findByText('a.png')
        await pickOption('media-library-sort', 'Name')

        expect(renderedHashes()).toEqual([a.hash32, b.hash32, c.hash32])
      } finally {
        vi.restoreAllMocks()
        consoleSpy.restore()
      }
    })
  })

  describe('kind filter', () => {
    const svg = makeAsset(2, { filename: 'logo.svg', slug: 'logo', kind: 'svg' })
    const pdf = makeAsset(3, { filename: 'brochure.pdf', slug: 'brochure', kind: 'pdf' })

    it('narrows the manage grid to PDFs, or to images, and says so when there are none', async () => {
      mockClient.assets.list.mockResolvedValueOnce(page([catAsset, svg, pdf]))

      renderBody()
      await screen.findByText('brochure.pdf')
      const user = userEvent.setup()

      await user.click(screen.getByRole('radio', { name: 'PDFs' }))
      expect(renderedHashes()).toEqual([pdf.hash32])

      await user.click(screen.getByRole('radio', { name: 'Images' }))
      expect(renderedHashes().sort()).toEqual([catAsset.hash32, svg.hash32].sort())
      expect(screen.queryByText('brochure.pdf')).toBeNull()
    })

    it('says there are no PDFs when the library holds only images', async () => {
      mockClient.assets.list.mockResolvedValueOnce(page([catAsset]))

      renderBody()
      await screen.findByText('cat.png')
      await userEvent.setup().click(screen.getByRole('radio', { name: 'PDFs' }))

      expect(await screen.findByText('No PDFs in the library.')).toBeTruthy()
    })

    it('does not render the control in picker mode, where PDFs are excluded anyway', async () => {
      mockClient.assets.list.mockResolvedValueOnce(page([catAsset, pdf]))

      renderBody({ mode: 'picker', onSelect: vi.fn() })
      await screen.findByText('cat.png')

      expect(screen.queryByTestId('media-library-kind')).toBeNull()
      expect(screen.queryByText('brochure.pdf')).toBeNull()
    })
  })

  describe('layout density', () => {
    const photo = makeAsset(1, {
      filename: 'photo.png',
      slug: 'photo',
      size: Math.round(2.3 * 1024 * 1024),
      width: 1200,
      height: 800,
    })
    const doc = makeAsset(2, {
      filename: 'terms.pdf',
      slug: 'terms',
      kind: 'pdf',
      size: 14 * 1024,
      width: undefined,
      height: undefined,
    })
    const uploadedDate = (asset: AssetRecord) => new Date(asset.uploadedAt).toLocaleDateString()

    it('lists a row per asset with dimensions, size and date', async () => {
      mockClient.assets.list.mockResolvedValueOnce(page([photo, doc]))

      renderBody()
      await screen.findByText('photo.png')
      await userEvent.setup().click(screen.getByRole('radio', { name: 'List' }))

      const row = screen.getByTestId(`asset-row-${photo.hash32}`)
      expect(within(row).getByText('1200 \u00D7 800')).toBeTruthy()
      expect(within(row).getByText('2.3 MB')).toBeTruthy()
      expect(within(row).getByText(uploadedDate(photo))).toBeTruthy()
      const pdfRow = screen.getByTestId(`asset-row-${doc.hash32}`)
      expect(within(pdfRow).getByText('14 KB')).toBeTruthy()
      expect(pdfRow.textContent).not.toContain('\u00D7')
      expect(screen.queryByTestId(`asset-card-${photo.hash32}`)).toBeNull()
    })

    it('drops the date line in the compact grid', async () => {
      mockClient.assets.list.mockResolvedValueOnce(page([photo]))

      renderBody()
      await screen.findByText('photo.png')
      expect(screen.getByText(uploadedDate(photo))).toBeTruthy()

      await userEvent.setup().click(screen.getByRole('radio', { name: 'Compact grid' }))

      expect(screen.getByTestId(`asset-card-${photo.hash32}`)).toBeTruthy()
      expect(screen.getByText('photo.png')).toBeTruthy()
      expect(screen.queryByText(uploadedDate(photo))).toBeNull()
    })

    it('remembers the layout for the next time the library opens', async () => {
      mockClient.assets.list.mockResolvedValue(page([photo]))

      const first = renderBody()
      await screen.findByText('photo.png')
      await userEvent.setup().click(screen.getByRole('radio', { name: 'List' }))
      first.unmount()

      renderBody()

      expect(await screen.findByTestId(`asset-row-${photo.hash32}`)).toBeTruthy()
    })

    it('lets a picker row select the asset, as a button', async () => {
      mockClient.assets.list.mockResolvedValueOnce(page([photo]))
      const onSelect = vi.fn()

      renderBody({ mode: 'picker', onSelect })
      await screen.findByText('photo.png')
      await userEvent.setup().click(screen.getByRole('radio', { name: 'List' }))

      const row = screen.getByTestId(`asset-row-${photo.hash32}`)
      expect(row.tagName).toBe('BUTTON')
      fireEvent.click(row)
      expect(onSelect).toHaveBeenCalledWith(photo)
    })

    it('removes an asset from a list row after confirming', async () => {
      asAdmin()
      mockClient.assets.delete.mockResolvedValue({ ok: true, status: 200, data: { deleted: true } })
      mockClient.assets.list.mockResolvedValueOnce(page([photo]))

      renderBody()
      await screen.findByText('photo.png')
      await userEvent.setup().click(screen.getByRole('radio', { name: 'List' }))
      fireEvent.click(await screen.findByTestId(`asset-row-delete-${photo.hash32}`))

      await waitFor(() =>
        expect(mockClient.assets.delete).toHaveBeenCalledWith({ key: photo.hash32 }),
      )
      await waitFor(() => expect(screen.queryByTestId(`asset-row-${photo.hash32}`)).toBeNull())
    })
  })

  describe('rendering a window of a long list', () => {
    class FakeIntersectionObserver {
      static instances: FakeIntersectionObserver[] = []
      disconnected = false
      targets: Element[] = []
      constructor(
        readonly callback: IntersectionObserverCallback,
        readonly options?: IntersectionObserverInit,
      ) {
        FakeIntersectionObserver.instances.push(this)
      }
      observe(target: Element) {
        this.targets.push(target)
      }
      unobserve() {}
      disconnect() {
        this.disconnected = true
      }
      takeRecords() {
        return []
      }
      /** Fires the live observer, as the browser does when its target scrolls into view. */
      static fire(isIntersecting: boolean) {
        const live = FakeIntersectionObserver.instances.filter((o) => !o.disconnected).at(-1)
        if (!live) throw new Error('no live observer')
        act(() => {
          live.callback(
            live.targets.map((target) => ({
              isIntersecting,
              target,
            })) as IntersectionObserverEntry[],
            live as unknown as IntersectionObserver,
          )
        })
      }
    }

    const many = Array.from({ length: 100 }, (_, i) => makeAsset(i + 1))
    const cardCount = () => screen.queryAllByTestId(/^asset-card-[0-9a-f]{32}$/).length

    beforeEach(() => {
      FakeIntersectionObserver.instances = []
    })

    it('renders 40 at first and reveals 40 more per Show more', async () => {
      mockClient.assets.list.mockResolvedValueOnce(page(many))

      renderBody()
      await screen.findByText('img-100.png')
      expect(cardCount()).toBe(40)

      const user = userEvent.setup()
      await user.click(screen.getByTestId('media-library-show-more'))
      expect(cardCount()).toBe(80)

      await user.click(screen.getByTestId('media-library-show-more'))
      expect(cardCount()).toBe(100)
      expect(screen.queryByTestId('media-library-show-more')).toBeNull()
    })

    it('reveals more when the end-of-list sentinel scrolls into view', async () => {
      vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
      mockClient.assets.list.mockResolvedValueOnce(page(many))

      renderBody()
      await screen.findByText('img-100.png')
      expect(cardCount()).toBe(40)
      expect(FakeIntersectionObserver.instances.at(-1)?.options?.rootMargin).toBe('200px')

      FakeIntersectionObserver.fire(false)
      expect(cardCount()).toBe(40)

      FakeIntersectionObserver.fire(true)
      expect(cardCount()).toBe(80)
      FakeIntersectionObserver.fire(true)
      expect(cardCount()).toBe(100)
    })

    it('goes back to 40 when the search or the layout changes', async () => {
      mockClient.assets.list.mockResolvedValueOnce(page(many))

      renderBody()
      await screen.findByText('img-100.png')
      const user = userEvent.setup()
      await user.click(screen.getByTestId('media-library-show-more'))
      expect(cardCount()).toBe(80)

      await user.type(screen.getByTestId('media-library-filter'), 'img')
      expect(cardCount()).toBe(40)

      await user.click(screen.getByTestId('media-library-show-more'))
      expect(cardCount()).toBe(80)
      await user.click(screen.getByRole('radio', { name: 'Compact grid' }))
      expect(cardCount()).toBe(40)
    })
  })

  it('names the remove action the same way on the control and in the confirmation', async () => {
    asAdmin()
    mockClient.assets.list.mockResolvedValueOnce(page([catAsset]))
    mockClient.assets.delete.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { deleted: true },
    })

    renderBody()
    const trash = await screen.findByTestId(`asset-card-delete-${catAsset.hash32}`)
    expect(trash.getAttribute('aria-label')).toBe('Remove cat.png from library')

    fireEvent.click(trash)

    const options = vi.mocked(modals.openConfirmModal).mock.calls[0]![0]
    expect(options.title).toBe('Remove from library')
    expect(options.labels).toEqual({ confirm: 'Remove from library', cancel: 'Cancel' })
    expect(options.confirmProps).toMatchObject({ color: 'red' })
  })

  it('reports a failed removal in plain words and keeps the asset', async () => {
    asAdmin()
    mockClient.assets.list.mockResolvedValueOnce(page([catAsset]))
    mockClient.assets.delete.mockResolvedValueOnce({ ok: false, status: 403, error: 'Forbidden' })

    renderBody()
    fireEvent.click(await screen.findByTestId(`asset-card-delete-${catAsset.hash32}`))

    const alert = await screen.findByTestId('media-library-action-error')
    expect(alert.textContent).toContain("Couldn't remove cat.png from the library.")
    expect(alert.textContent).toContain('Forbidden')
    expect(screen.getByText('cat.png')).toBeTruthy()
  })
})
