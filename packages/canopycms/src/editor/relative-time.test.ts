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

  const daysAgo = (days: number) =>
    new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()

  it('returns weeks ago from a week old, up to four weeks', () => {
    expect(formatRelativeTime(daysAgo(7))).toBe('1w ago')
    expect(formatRelativeTime(daysAgo(10))).toBe('1w ago')
    expect(formatRelativeTime(daysAgo(15))).toBe('2w ago')
    expect(formatRelativeTime(daysAgo(34))).toBe('4w ago')
  })

  it('returns months ago from five weeks old, up to eleven months', () => {
    expect(formatRelativeTime(daysAgo(35))).toBe('1mo ago')
    expect(formatRelativeTime(daysAgo(95))).toBe('3mo ago')
    expect(formatRelativeTime(daysAgo(364))).toBe('11mo ago')
  })

  it('returns years ago from a year old', () => {
    expect(formatRelativeTime(daysAgo(365))).toBe('1y ago')
    expect(formatRelativeTime(daysAgo(800))).toBe('2y ago')
  })

  it('returns "just now" for a timestamp in the future', () => {
    expect(formatRelativeTime(new Date(now.getTime() + 5 * 60 * 1000).toISOString())).toBe(
      'just now',
    )
  })
})
