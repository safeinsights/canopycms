import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MantineProvider } from '@mantine/core'

import type { AssetRecord } from '../../api'
import { AssetListRow } from './AssetListRow'

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

describe('AssetListRow', () => {
  afterEach(() => {
    cleanup()
  })

  it('offers Remove with an eye-off icon, not a trash can', () => {
    const onRemove = vi.fn()
    render(<AssetListRow asset={catAsset} onRemove={onRemove} onRestore={vi.fn()} />, {
      wrapper: Wrapper,
    })

    const remove = screen.getByRole('button', { name: 'Remove cat.png from library' })
    expect(remove.querySelector('.tabler-icon-eye-off')).toBeTruthy()
    expect(remove.querySelector('.tabler-icon-trash')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restore cat.png to library' })).toBeNull()

    fireEvent.click(remove)
    expect(onRemove).toHaveBeenCalledWith(catAsset)
  })

  it('badges a removed file and offers Restore instead of Remove', () => {
    const onRestore = vi.fn()
    const removed: AssetRecord = { ...catAsset, hidden: true }
    render(<AssetListRow asset={removed} onRemove={vi.fn()} onRestore={onRestore} />, {
      wrapper: Wrapper,
    })

    expect(screen.getByTestId(`asset-row-removed-${catAsset.hash32}`).textContent).toBe('Removed')
    expect(screen.queryByRole('button', { name: 'Remove cat.png from library' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Restore cat.png to library' }))
    expect(onRestore).toHaveBeenCalledWith(removed)
  })
})
