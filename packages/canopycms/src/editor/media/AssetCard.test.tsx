import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MantineProvider } from '@mantine/core'

import type { AssetRecord } from '../../api'
import { AssetCard } from './AssetCard'

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

    expect(screen.getByText('cat')).toBeTruthy()
    expect(screen.getByText(new Date(catAsset.uploadedAt).toLocaleDateString())).toBeTruthy()
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
})
