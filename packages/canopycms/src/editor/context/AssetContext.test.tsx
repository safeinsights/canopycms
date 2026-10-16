import React from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { assetUrl } from '../../assets/asset-url'
import { AssetContextProvider, authenticatedAssetBase, useAssetContext } from './AssetContext'

const Read: React.FC<{ onValue: (value: string) => void }> = ({ onValue }) => {
  onValue(useAssetContext().baseUrl)
  return null
}

const readBaseUrl = (provider: { basePath?: string } | null): string => {
  let value = ''
  const reader = <Read onValue={(v) => (value = v)} />
  render(provider ? <AssetContextProvider {...provider}>{reader}</AssetContextProvider> : reader)
  return value
}

describe('AssetContextProvider - the editor loads assets through the authenticated raw route', () => {
  it('mounts the raw route at the origin root without a basePath', () => {
    expect(readBaseUrl({})).toBe('/api/canopycms/assets/raw')
  })

  it('puts the raw route under the deployment basePath', () => {
    expect(readBaseUrl({ basePath: '/preview-123' })).toBe('/preview-123/api/canopycms/assets/raw')
  })

  it('uses the authenticated route outside a provider too', () => {
    expect(readBaseUrl(null)).toBe('/api/canopycms/assets/raw')
  })

  it('builds URLs whose key is the stored src, which is what the raw route reads', () => {
    const src = `/assets/t/orig/${'a'.repeat(32)}/photo.png`
    expect(assetUrl({ src }, { width: 160, baseUrl: authenticatedAssetBase('/p') })).toBe(
      `/p/api/canopycms/assets/raw/assets/t/w=160/${'a'.repeat(32)}/photo.png`,
    )
  })
})
