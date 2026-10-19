import { describe, expect, it } from 'vitest'

import { autolinkLiteralAt } from './gfm-autolink-literal'

describe('autolinkLiteralAt', () => {
  it.each([
    ['www.example.org.', 'http://www.example.org', 15],
    ['https://example.org/a,', 'https://example.org/a', 21],
    ['https://example.org/a:', 'https://example.org/a', 21],
    ['https://example.org/a;', 'https://example.org/a', 21],
    ['https://example.org/a!', 'https://example.org/a', 21],
    ['https://example.org/a?', 'https://example.org/a', 21],
    ['https://example.org/a)', 'https://example.org/a', 21],
    ['https://example.org/a*', 'https://example.org/a', 21],
    ['https://example.org/a_', 'https://example.org/a', 21],
    ['https://example.org/a~', 'https://example.org/a', 21],
    ['https://example.org/(a)', 'https://example.org/(a)', 23],
    ['help@example.org.', 'mailto:help@example.org', 16],
  ])('leaves out the trailing punctuation GFM does: %s', (text, url, length) => {
    expect(autolinkLiteralAt(text, 0)).toEqual({ url, length })
  })

  it('reads a literal where it stands in its text', () => {
    const text = 'See (www.example.org/a). Done.'
    expect(autolinkLiteralAt(text, 5)).toEqual({ url: 'http://www.example.org/a', length: 17 })
    expect(autolinkLiteralAt(text, 6)).toBeUndefined()
  })

  it('finds nothing where GFM links nothing', () => {
    expect(autolinkLiteralAt('www.ex_ample.org', 0)).toBeUndefined()
    expect(autolinkLiteralAt('[www.example.org](https://example.org)', 1)).toBeUndefined()
    expect(autolinkLiteralAt('[a](https://example.org)', 0)).toBeUndefined()
    expect(autolinkLiteralAt('<https://example.org>', 0)).toBeUndefined()
  })
})
