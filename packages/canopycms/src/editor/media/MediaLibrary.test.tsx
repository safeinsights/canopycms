import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MockApiClient } from '../../api/__test__/mock-client'
import { setupMockApiClient, createApiClientWrapper } from '../hooks/__test__/test-utils'
import { CanopyCMSProvider } from '../theme'
import { MediaLibraryBody } from './MediaLibraryBody'
import type { AssetRecord } from '../../api'

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

describe('MediaLibraryBody', () => {
  let mockClient: MockApiClient
  let wrapper: ReturnType<typeof createApiClientWrapper>

  beforeEach(async () => {
    mockClient = await setupMockApiClient()
    wrapper = createApiClientWrapper(mockClient)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  const renderBody = (props: Partial<React.ComponentProps<typeof MediaLibraryBody>> = {}) => {
    const Wrapper = wrapper
    return render(
      <CanopyCMSProvider>
        <Wrapper>
          <MediaLibraryBody opened mode="manage" {...props} />
        </Wrapper>
      </CanopyCMSProvider>,
    )
  }

  it('lists the first page of assets when opened', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset, dogAsset] },
    })

    renderBody()

    await waitFor(() => expect(screen.getByText('cat')).toBeTruthy())
    expect(screen.getByText('dog')).toBeTruthy()
    expect(mockClient.assets.list).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('media-library-load-more')).toBeNull()
  })

  it('shows Load more when a nextCursor is returned, and appends the next page', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [catAsset], nextCursor: 'cursor-1' },
    })

    renderBody()

    await waitFor(() => expect(screen.getByText('cat')).toBeTruthy())
    expect(screen.queryByText('dog')).toBeNull()
    const loadMore = await screen.findByTestId('media-library-load-more')

    mockClient.assets.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { assets: [dogAsset] },
    })

    fireEvent.click(loadMore)

    await waitFor(() => expect(screen.getByText('dog')).toBeTruthy())
    expect(mockClient.assets.list).toHaveBeenCalledTimes(2)
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
    await waitFor(() => expect(screen.getByText('cat')).toBeTruthy())

    const user = userEvent.setup()
    await user.type(screen.getByTestId('media-library-filter'), 'cat')

    expect(screen.getByText('cat')).toBeTruthy()
    expect(screen.queryByText('dog')).toBeNull()
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

    await waitFor(() => expect(screen.getByText('cat')).toBeTruthy())
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
    await waitFor(() => expect(screen.queryByText('cat')).toBeNull())
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

    await waitFor(() => expect(screen.getByText('cat')).toBeTruthy())
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

  it('shows a retryable error alert when listing fails', async () => {
    mockClient.assets.list.mockResolvedValueOnce({
      ok: false,
      status: 500,
      error: 'Internal error',
    })

    renderBody()

    await waitFor(() => expect(screen.getByTestId('media-library-error')).toBeTruthy())
    expect(screen.getByText('Internal error')).toBeTruthy()
  })
})
