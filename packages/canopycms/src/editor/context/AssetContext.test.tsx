import React from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AssetContextProvider, useAssetContext } from './AssetContext'

/**
 * The editor's asset mount point has two possible sources and they are ALTERNATIVES:
 * `media.publicBaseUrl` (absolute-only, another origin serving /assets at its own root) and the
 * deployment `basePath` (a same-origin path prefix). Without the `basePath` fallback the editor's
 * own thumbnails/previews stay root-relative on a basePath deployment where Next serves /assets,
 * and no config value can fix it — `publicBaseUrl` is Zod-validated as an absolute URL, so it
 * structurally cannot hold `/preview-123`.
 */
const Read: React.FC<{ onValue: (value: string | undefined) => void }> = ({ onValue }) => {
  onValue(useAssetContext().baseUrl)
  return null
}

describe('AssetContextProvider — mount point precedence', () => {
  const readBaseUrl = (props: { baseUrl?: string; basePath?: string }): string | undefined => {
    let value: string | undefined
    render(
      <AssetContextProvider {...props}>
        <Read onValue={(v) => (value = v)} />
      </AssetContextProvider>,
    )
    return value
  }

  it('falls back to basePath when no publicBaseUrl is configured', () => {
    expect(readBaseUrl({ basePath: '/preview-123' })).toBe('/preview-123')
  })

  it('prefers publicBaseUrl over basePath — they are alternatives, never composed', () => {
    expect(readBaseUrl({ baseUrl: 'https://assets.example.com', basePath: '/preview-123' })).toBe(
      'https://assets.example.com',
    )
  })

  it('is undefined when neither is set (root-relative, the common case)', () => {
    expect(readBaseUrl({})).toBeUndefined()
  })
})
