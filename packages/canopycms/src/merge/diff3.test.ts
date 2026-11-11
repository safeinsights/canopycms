import { describe, expect, it } from 'vitest'

import { diff3Regions, type Diff3Region } from './diff3'
import { mergeText } from './text-merge'

const chars = (s: string) => s.split('')

/** The regions with each run as text, so a case reads at a glance. */
const regions = (o: string, a: string, b: string) => {
  const versions = { ancestor: chars(o), base: chars(a), branch: chars(b) }
  return diff3Regions(versions.ancestor, versions.base, versions.branch)?.map((r: Diff3Region) =>
    r.stable
      ? { stable: r.side, text: versions[r.side].slice(...r.span).join('') }
      : {
          ancestor: versions.ancestor.slice(...r.ancestor).join(''),
          base: versions.base.slice(...r.base).join(''),
          branch: versions.branch.slice(...r.branch).join(''),
        },
  )
}

describe('diff3Regions', () => {
  it('passes a change on one side through as that side', () => {
    expect(regions('abcd', 'aXcd', 'abcd')).toEqual([
      { stable: 'ancestor', text: 'a' },
      { stable: 'base', text: 'X' },
      { stable: 'ancestor', text: 'cd' },
    ])
    expect(regions('abcd', 'abcd', 'abcY')).toEqual([
      { stable: 'ancestor', text: 'abc' },
      { stable: 'branch', text: 'Y' },
    ])
  })

  it('keeps changes on each side apart where unchanged elements separate them', () => {
    expect(regions('abcde', 'Xbcde', 'abcdY')).toEqual([
      { stable: 'base', text: 'X' },
      { stable: 'ancestor', text: 'bcd' },
      { stable: 'branch', text: 'Y' },
    ])
    expect(regions('abc', 'Xbc', 'abY')).toEqual([
      { stable: 'base', text: 'X' },
      { stable: 'ancestor', text: 'b' },
      { stable: 'branch', text: 'Y' },
    ])
  })

  it('makes one unstable region of overlapping hunks', () => {
    expect(regions('abcd', 'aXYd', 'abZd')).toEqual([
      { stable: 'ancestor', text: 'a' },
      { ancestor: 'bc', base: 'XY', branch: 'bZ' },
      { stable: 'ancestor', text: 'd' },
    ])
  })

  it('makes one unstable region of adjacent hunks, as GNU diff3 and git do', () => {
    expect(regions('abcd', 'aXcd', 'abYd')).toEqual([
      { stable: 'ancestor', text: 'a' },
      { ancestor: 'bc', base: 'Xc', branch: 'bY' },
      { stable: 'ancestor', text: 'd' },
    ])
  })

  it('reports the same change on both sides as a region whose sides are equal', () => {
    expect(regions('abc', 'aXc', 'aXc')).toEqual([
      { stable: 'ancestor', text: 'a' },
      { ancestor: 'b', base: 'X', branch: 'X' },
      { stable: 'ancestor', text: 'c' },
    ])
  })

  it('handles inserts at the start and the end', () => {
    expect(regions('ab', 'Sab', 'abE')).toEqual([
      { stable: 'base', text: 'S' },
      { stable: 'ancestor', text: 'ab' },
      { stable: 'branch', text: 'E' },
    ])
    expect(regions('ab', 'Sab', 'Tab')).toEqual([
      { ancestor: '', base: 'S', branch: 'T' },
      { stable: 'ancestor', text: 'ab' },
    ])
  })

  it('handles empty versions', () => {
    expect(regions('', '', '')).toEqual([])
    expect(regions('', 'ab', '')).toEqual([{ stable: 'base', text: 'ab' }])
    expect(regions('ab', '', 'ab')).toEqual([])
    expect(regions('', 'a', 'b')).toEqual([{ ancestor: '', base: 'a', branch: 'b' }])
  })
})

describe('the line merge stays fast on long input with many equal lines', () => {
  it('merges an 8,000-line paragraph body with sparse edits on both sides', () => {
    const body = (mark: (i: number) => string) =>
      `${Array.from({ length: 8000 }, (_, i) => (i % 2 ? '' : `Paragraph ${i}${mark(i)}`)).join('\n')}\n`
    const o = body(() => '')
    const a = body((i) => (i % 200 === 0 ? ' (base)' : ''))
    const b = body((i) => (i % 182 === 2 ? ' (mine)' : ''))
    const started = performance.now()
    const merged = mergeText(o, a, b)
    expect(performance.now() - started).toBeLessThan(3000)
    expect(merged?.regions).toEqual([])
    expect(merged?.text).toContain('Paragraph 200 (base)')
    expect(merged?.text).toContain('Paragraph 184 (mine)')
  })
})
