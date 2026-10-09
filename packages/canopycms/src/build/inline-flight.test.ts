import { describe, expect, it } from 'vitest'

import { extractInlineFlight } from './inline-flight'

const push = (segment: unknown[]) =>
  `<script>self.__next_f.push(${JSON.stringify(segment)})</script>`

describe('extractInlineFlight', () => {
  it('joins text and binary chunks as bytes, so a character split across them decodes whole', () => {
    // `é` is C3 A9 and `😀` is F0 9F 98 80: each is cut between two binary chunks. A text chunk
    // never ends mid-character (Next decodes it with a streaming decoder), but it can hold one.
    const bytes = Buffer.from('café \u{1F600}', 'utf8')
    const html =
      push([0]) +
      push([1, 'x:']) +
      push([3, bytes.subarray(0, 4).toString('base64')]) +
      push([3, bytes.subarray(4, 8).toString('base64')]) +
      push([3, bytes.subarray(8).toString('base64')]) +
      push([1, '! naïve'])
    expect(extractInlineFlight(html)).toEqual({
      markup: '      ',
      texts: ['x:café \u{1F600}! naïve'],
      problems: [],
    })
  })
})
