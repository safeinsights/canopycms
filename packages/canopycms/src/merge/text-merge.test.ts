import { describe, expect, it } from 'vitest'

import { mergeText } from './text-merge'

describe('mergeText', () => {
  it('applies both sides where they changed different lines', () => {
    expect(mergeText('a\nb\nc\nd\n', 'A\nb\nc\nd\n', 'a\nb\nc\nD\n')).toEqual({
      text: 'A\nb\nc\nD\n',
      regions: [],
    })
  })

  it('keeps an insertion on each side at different places', () => {
    expect(mergeText('a\nb\nc', 'a\nnew\nb\nc', 'a\nb\nc\nend')).toEqual({
      text: 'a\nnew\nb\nc\nend',
      regions: [],
    })
  })

  it('makes two different insertions at one place a region, the branch lines in the text', () => {
    expect(mergeText('a\nz', 'a\nbase\nz', 'a\nmine\nmore\nz')).toEqual({
      text: 'a\nmine\nmore\nz',
      regions: [
        { ancestor: '', base: 'base', branch: 'mine\nmore', line: 1, lines: 2, baseLines: 1 },
      ],
    })
  })

  it('records a region where the branch deleted lines the base changed: no lines held', () => {
    expect(mergeText('a\nb\nc\n', 'a\nB\nc\n', 'a\nc\n')).toEqual({
      text: 'a\nc\n',
      regions: [{ ancestor: 'b', base: 'B', branch: '', line: 1, lines: 0, baseLines: 1 }],
    })
  })

  it('merges from and to empty text', () => {
    expect(mergeText('', 'base\n', '')).toEqual({ text: 'base\n', regions: [] })
    expect(mergeText('only\n', '', 'only\n')).toEqual({ text: '', regions: [] })
    expect(mergeText('', 'x', 'y')?.regions).toHaveLength(1)
  })

  it('merges the end line break on its own: the side that changed it wins', () => {
    expect(mergeText('a\nb\n', 'a\nb', 'A\nb\n')).toEqual({ text: 'A\nb', regions: [] })
    expect(mergeText('a\nb', 'A\nb', 'a\nb\n')).toEqual({ text: 'A\nb\n', regions: [] })
    expect(mergeText('\n', '\n\n', '\n')).toEqual({ text: '\n\n', regions: [] })
  })

  it('keeps carriage returns inside lines as they are', () => {
    expect(mergeText('a\r\nb\r\nc\r\n', 'A\r\nb\r\nc\r\n', 'a\r\nb\r\nC\r\n')).toEqual({
      text: 'A\r\nb\r\nC\r\n',
      regions: [],
    })
  })
})
