import { afterEach, describe, expect, it, vi } from 'vitest'
import { modKeyLabel } from './platform'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('modKeyLabel', () => {
  it('is ⌘ on a Mac, from navigator.platform', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    expect(modKeyLabel()).toBe('⌘')
  })

  it('is ⌘ on iPad and iPhone', () => {
    vi.stubGlobal('navigator', { platform: 'iPad' })
    expect(modKeyLabel()).toBe('⌘')
  })

  it('is Ctrl on Windows and Linux', () => {
    vi.stubGlobal('navigator', { platform: 'Win32' })
    expect(modKeyLabel()).toBe('Ctrl')
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
    expect(modKeyLabel()).toBe('Ctrl')
  })

  it('prefers userAgentData.platform when present', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgentData: { platform: 'macOS' } })
    expect(modKeyLabel()).toBe('⌘')
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgentData: { platform: 'Windows' } })
    expect(modKeyLabel()).toBe('Ctrl')
  })

  it('is Ctrl when there is no navigator', () => {
    vi.stubGlobal('navigator', undefined)
    expect(modKeyLabel()).toBe('Ctrl')
  })
})
