import { describe, expect, it } from 'vitest'

import { formatBytes } from './format-bytes'

describe('formatBytes', () => {
  it('prints bytes without a decimal', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('uses one decimal below 10 and whole numbers from 10 up', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(14 * 1024)).toBe('14 KB')
    expect(formatBytes(Math.round(2.3 * 1024 * 1024))).toBe('2.3 MB')
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB')
  })

  it('promotes a value that rounds up to 1024 to the next unit', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB')
    expect(formatBytes(1024 * 1024 * 1024 - 1)).toBe('1.0 GB')
  })

  it('keeps GB as the largest unit', () => {
    expect(formatBytes(2048 * 1024 * 1024 * 1024)).toBe('2048 GB')
  })

  it('treats empty and invalid sizes as 0 B', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})
