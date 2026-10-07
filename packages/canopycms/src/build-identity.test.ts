import { describe, expect, it } from 'vitest'

import { getBuildIdentity } from './build-identity'
import { CANOPYCMS_VERSION } from './version'

const SOURCE_REVISION_ENV = 'CANOPY_SOURCE_SHA'

describe('getBuildIdentity', () => {
  it('reports the package version', () => {
    expect(getBuildIdentity({}).canopycmsVersion).toBe(CANOPYCMS_VERSION)
  })

  it('reports the source revision when the env var is set', () => {
    expect(getBuildIdentity({ [SOURCE_REVISION_ENV]: 'abc123' }).sourceRevision).toBe('abc123')
  })

  it('trims the env value', () => {
    expect(getBuildIdentity({ [SOURCE_REVISION_ENV]: '  abc123\n' }).sourceRevision).toBe('abc123')
  })

  it('omits the sourceRevision key when the env var is absent', () => {
    expect('sourceRevision' in getBuildIdentity({})).toBe(false)
  })

  it('treats an empty value as absent', () => {
    expect('sourceRevision' in getBuildIdentity({ [SOURCE_REVISION_ENV]: '' })).toBe(false)
  })

  it('treats a whitespace-only value as absent', () => {
    expect('sourceRevision' in getBuildIdentity({ [SOURCE_REVISION_ENV]: '   ' })).toBe(false)
  })

  it('reads process.env by default', () => {
    expect(getBuildIdentity().canopycmsVersion).toBe(CANOPYCMS_VERSION)
  })
})
