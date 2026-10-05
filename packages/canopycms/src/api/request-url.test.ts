import { afterEach, describe, expect, it, vi } from 'vitest'
import { readApiTrailingSlashEnv } from './request-url'

describe('readApiTrailingSlashEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is true only for the exact value withCanopy sets', () => {
    vi.stubEnv('CANOPY_API_TRAILING_SLASH', 'true')
    expect(readApiTrailingSlashEnv()).toBe(true)
    vi.stubEnv('CANOPY_API_TRAILING_SLASH', '1')
    expect(readApiTrailingSlashEnv()).toBe(false)
    vi.stubEnv('CANOPY_API_TRAILING_SLASH', undefined)
    expect(readApiTrailingSlashEnv()).toBe(false)
  })

  it('is false, not a throw, where there is no process global', () => {
    vi.stubGlobal('process', undefined)
    try {
      expect(readApiTrailingSlashEnv()).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
