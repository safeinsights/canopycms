import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { FieldConfig } from '../../config'
import { mockConsole, type MockConsole } from '../../test-utils/console-spy'
import { usePreviewMarks } from './usePreviewMarks'

const fields: FieldConfig[] = [
  {
    type: 'block',
    name: 'sections',
    templates: [
      { name: 'hero', fields: [{ type: 'string', name: 'headline' }] },
      { name: 'cta', fields: [{ type: 'string', name: 'label' }] },
    ],
  },
]
const hero = { sections: [{ template: 'hero', value: { headline: 'Hi' } }] }
const cta = { sections: [{ template: 'cta', value: { label: 'Go' } }] }

describe('usePreviewMarks', () => {
  let consoleSpy: MockConsole
  beforeEach(() => {
    consoleSpy = mockConsole()
  })
  afterEach(() => consoleSpy.restore())

  const render = () =>
    renderHook(
      ({ data }: { data: unknown }) =>
        usePreviewMarks({ src: '/page', highlightEnabled: true, fields, data }),
      { initialProps: { data: hero as unknown } },
    )

  it('checks marks against the draft they were reported for, not a later one', () => {
    const { result, rerender } = render()
    act(() => result.current.onMarks({ count: 1, paths: ['sections[0].headline'] }))
    expect(result.current.inexactMarks).toEqual([])

    rerender({ data: cta })
    expect(result.current.inexactMarks).toEqual([])
    expect(consoleSpy.all().warn).toEqual([])

    act(() => result.current.onMarks({ count: 1, paths: ['sections[0].headline'] }))
    expect(result.current.inexactMarks).toEqual([
      { path: 'sections[0].headline', nearest: 'sections[0]' },
    ])
  })
})
