import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatRelativeTime } from './relative-time'

describe('formatRelativeTime', () => {
  const now = new Date('2024-06-15T12:00:00.000Z')

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the input unchanged for an invalid date', () => {
    expect(formatRelativeTime('not-a-date')).toBe('not-a-date')
  })

  it('returns "just now" for timestamps under a minute old', () => {
    const iso = new Date(now.getTime() - 30 * 1000).toISOString()
    expect(formatRelativeTime(iso)).toBe('just now')
  })

  it('returns minutes ago for timestamps under an hour old', () => {
    const iso = new Date(now.getTime() - 5 * 60 * 1000).toISOString()
    expect(formatRelativeTime(iso)).toBe('5m ago')
  })

  it('returns hours ago for timestamps under a day old', () => {
    const iso = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(iso)).toBe('3h ago')
  })

  it('returns days ago for timestamps under a week old', () => {
    const iso = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(iso)).toBe('2d ago')
  })

  it('falls back to a locale date string for timestamps a week or older', () => {
    const date = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000)
    expect(formatRelativeTime(date.toISOString())).toBe(date.toLocaleDateString())
  })
})
