import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MantineProvider } from '@mantine/core'

import type { AssetRecord } from '../../api'
import { EDITOR_THUMBNAIL_WIDTHS } from '../../assets/editor-thumbnail-widths'
import { AssetCard } from './AssetCard'
import { formatRelativeTime } from '../relative-time'

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <MantineProvider>{children}</MantineProvider>
)

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

describe('AssetCard', () => {
  afterEach(() => {
    cleanup()
  })

  it('requests the card editor thumbnail width, which finalize stores ahead of the first view', () => {
    render(<AssetCard asset={catAsset} baseUrl="/api/canopycms/assets/raw" />, { wrapper: Wrapper })

    expect(screen.getByRole('img', { hidden: true }).getAttribute('src')).toBe(
      `/api/canopycms/assets/raw/assets/t/w=${EDITOR_THUMBNAIL_WIDTHS.card}/${catAsset.hash32}/cat.png`,
    )
  })

  it('renders the thumbnail image by default', () => {
    render(<AssetCard asset={catAsset} />, { wrapper: Wrapper })

    expect(screen.getByRole('img')).toBeTruthy()
    expect(screen.queryByTestId(`asset-card-thumbnail-fallback-${catAsset.hash32}`)).toBeNull()
  })

  it('shows a placeholder with "Preview unavailable" when the thumbnail fails to load', () => {
    render(<AssetCard asset={catAsset} />, { wrapper: Wrapper })

    const img = screen.getByRole('img')
    fireEvent.error(img)

    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByTestId(`asset-card-thumbnail-fallback-${catAsset.hash32}`)).toBeTruthy()
    expect(screen.getByText('Preview unavailable')).toBeTruthy()
  })

  it('still shows the filename and upload date footer when the thumbnail fails', () => {
    render(<AssetCard asset={catAsset} />, { wrapper: Wrapper })

    fireEvent.error(screen.getByRole('img'))

    expect(screen.getByText('cat.png')).toBeTruthy()
    expect(screen.getByText(formatRelativeTime(catAsset.uploadedAt))).toBeTruthy()
  })

  it('resets the error state when the asset src changes', () => {
    const { rerender } = render(<AssetCard asset={catAsset} />, { wrapper: Wrapper })
    fireEvent.error(screen.getByRole('img'))
    expect(screen.getByTestId(`asset-card-thumbnail-fallback-${catAsset.hash32}`)).toBeTruthy()

    const otherAsset: AssetRecord = {
      ...catAsset,
      hash32: 'b'.repeat(32),
      src: '/assets/t/orig/other.png',
    }
    rerender(
      <Wrapper>
        <AssetCard asset={otherAsset} />
      </Wrapper>,
    )

    expect(screen.getByRole('img')).toBeTruthy()
    expect(screen.queryByTestId(`asset-card-thumbnail-fallback-${otherAsset.hash32}`)).toBeNull()
  })

  it('shows the filename, not the slug, on the card', () => {
    render(<AssetCard asset={{ ...catAsset, slug: 'cat-2' }} />, { wrapper: Wrapper })

    expect(screen.getByText('cat.png')).toBeTruthy()
    expect(screen.queryByText('cat-2')).toBeNull()
  })

  it('puts the full filename and the slug in the name tooltip', async () => {
    render(<AssetCard asset={{ ...catAsset, slug: 'cat-2' }} />, { wrapper: Wrapper })

    await userEvent.setup().hover(screen.getByText('cat.png'))

    expect(await screen.findByText('Slug: cat-2')).toBeTruthy()
  })

  it('shows a relative upload date with the absolute date in a tooltip', async () => {
    const uploadedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    render(<AssetCard asset={{ ...catAsset, uploadedAt }} />, { wrapper: Wrapper })

    await userEvent.setup().hover(screen.getByText('5m ago'))

    expect(await screen.findByText(new Date(uploadedAt).toLocaleString())).toBeTruthy()
  })

  it('names the remove control for the asset, with a matching tooltip', async () => {
    const onRemove = vi.fn()
    render(<AssetCard asset={catAsset} onRemove={onRemove} onRestore={vi.fn()} />, {
      wrapper: Wrapper,
    })

    const remove = screen.getByRole('button', { name: 'Remove cat.png from library' })
    await userEvent.setup().hover(remove)
    expect(await screen.findByText('Remove from library')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Restore cat.png to library' })).toBeNull()

    fireEvent.click(remove)
    expect(onRemove).toHaveBeenCalledWith(catAsset)
  })

  it('shows removal as hiding, not destroying: an eye-off icon in the default colour', () => {
    render(<AssetCard asset={catAsset} onRemove={vi.fn()} />, { wrapper: Wrapper })

    const remove = screen.getByRole('button', { name: 'Remove cat.png from library' })
    expect(remove.querySelector('.tabler-icon-eye-off')).toBeTruthy()
    expect(remove.querySelector('.tabler-icon-trash')).toBeNull()
    expect(remove.getAttribute('style') ?? '').not.toContain('danger')
  })

  it('badges a removed file and offers Restore instead of Remove', async () => {
    const onRestore = vi.fn()
    const removed: AssetRecord = { ...catAsset, hidden: true }
    render(<AssetCard asset={removed} onRemove={vi.fn()} onRestore={onRestore} />, {
      wrapper: Wrapper,
    })

    expect(screen.getByTestId(`asset-card-removed-${catAsset.hash32}`).textContent).toBe('Removed')
    expect(screen.queryByRole('button', { name: 'Remove cat.png from library' })).toBeNull()
    const restore = screen.getByRole('button', { name: 'Restore cat.png to library' })
    await userEvent.setup().hover(restore)
    expect(await screen.findByText('Restore to library')).toBeTruthy()

    fireEvent.click(restore)
    expect(onRestore).toHaveBeenCalledWith(removed)
  })

  it('drops the date line and shrinks the thumbnail in the compact density', () => {
    const { rerender } = render(<AssetCard asset={catAsset} />, { wrapper: Wrapper })
    const date = formatRelativeTime(catAsset.uploadedAt)
    expect(screen.getByText(date)).toBeTruthy()
    expect(screen.getByRole('img').style.height).toBe('100px')

    rerender(
      <Wrapper>
        <AssetCard asset={catAsset} density="compact" />
      </Wrapper>,
    )

    expect(screen.queryByText(date)).toBeNull()
    expect(screen.getByText('cat.png')).toBeTruthy()
    expect(screen.getByRole('img').style.height).toBe('64px')
  })

  it('is a named, focus-ringed button when it can select', () => {
    render(<AssetCard asset={catAsset} onSelect={vi.fn()} />, { wrapper: Wrapper })

    const card = screen.getByTestId(`asset-card-${catAsset.hash32}`)
    expect(card.getAttribute('aria-label')).toBe('Select cat.png')
    expect(screen.getByRole('button', { name: 'Select cat.png' })).toBe(card)
    expect(card.classList.contains('mantine-focus-auto')).toBe(true)
  })

  it('has no button name or focus ring when it cannot select', () => {
    render(<AssetCard asset={catAsset} />, { wrapper: Wrapper })

    const card = screen.getByTestId(`asset-card-${catAsset.hash32}`)
    expect(card.getAttribute('aria-label')).toBeNull()
    expect(card.classList.contains('mantine-focus-auto')).toBe(false)
  })
})
