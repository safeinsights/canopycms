import { describe, expect, it } from 'vitest'

import { hiddenPickSentences } from './reference-noindex'

describe('hiddenPickSentences', () => {
  it('lists three picks with a final "and"', () => {
    const picks = ['A', 'B', 'C'].map((label) => ({ label, fieldLabel: 'Hide' }))
    expect(hiddenPickSentences(picks)).toEqual([
      "‘A’, ‘B’ and ‘C’ have “Hide” turned on, so pages that list only visible entries won't show them.",
    ])
  })

  it('writes one sentence per field label', () => {
    const sentences = hiddenPickSentences([
      { label: 'A', fieldLabel: 'Hide' },
      { label: 'B', fieldLabel: 'Keep off search' },
      { label: 'C', fieldLabel: 'Hide' },
    ])
    expect(sentences).toEqual([
      "‘A’ and ‘C’ have “Hide” turned on, so pages that list only visible entries won't show them.",
      "‘B’ has “Keep off search” turned on, so pages that list only visible entries won't show it.",
    ])
  })
})
