/**
 * BlockField's dragging follows `readOnly` both ways, including a block list that first renders
 * read-only (the branch list still loading) and then unlocks, without changing the sensor count.
 */
import React from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'

import type { BlockConfig } from '../../config'
import { BlockField, type BlockInstance } from './BlockField'

const sensorCounts = vi.hoisted(() => [] as number[])
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>()
  const { createElement } = await import('react')
  const DndContext = (props: React.ComponentProps<typeof actual.DndContext>) => {
    sensorCounts.push(props.sensors?.length ?? 0)
    return createElement(actual.DndContext, props)
  }
  return { ...actual, DndContext }
})

const templates: BlockConfig[] = [
  { name: 'hero', label: 'Hero', fields: [{ name: 'headline', type: 'string' }] },
]
const value: BlockInstance[] = [
  { template: 'hero', value: { headline: 'One' } },
  { template: 'hero', value: { headline: 'Two' } },
]

const field = (readOnly: boolean) => (
  <MantineProvider>
    <BlockField
      templates={templates}
      value={value}
      onChange={() => {}}
      renderField={() => null}
      path={['blocks']}
      readOnly={readOnly}
    />
  </MantineProvider>
)

describe('BlockField readOnly', () => {
  afterEach(() => {
    cleanup()
    sensorCounts.length = 0
  })

  it('turns dragging off per block while read-only, and back on when the list unlocks', () => {
    const { rerender } = render(field(true))
    expect(screen.queryAllByRole('button', { name: 'Drag to reorder' })).toHaveLength(0)

    rerender(field(false))
    const handles = screen.getAllByRole('button', { name: 'Drag to reorder' })
    expect(handles).toHaveLength(2)
    expect(handles.map((h) => h.getAttribute('aria-disabled'))).toEqual(['false', 'false'])

    rerender(field(true))
    expect(screen.queryAllByRole('button', { name: 'Drag to reorder' })).toHaveLength(0)
    // DndContext's hooks depend on the sensor count, so it never changes.
    expect(new Set(sensorCounts)).toEqual(new Set([2]))
  })
})
