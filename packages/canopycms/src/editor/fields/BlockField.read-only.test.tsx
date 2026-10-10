/**
 * BlockField's drag sensors follow `readOnly` both ways, including a block list that first
 * renders read-only (the branch list still loading) and then unlocks.
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

  it('turns dragging on when a read-only block list unlocks, and off again when it locks', () => {
    const { rerender } = render(field(true))
    expect(sensorCounts.at(-1)).toBe(0)
    expect(screen.queryAllByRole('button', { name: 'Drag to reorder' })).toHaveLength(0)

    rerender(field(false))
    expect(sensorCounts.at(-1)).toBe(2)
    expect(screen.getAllByRole('button', { name: 'Drag to reorder' })).toHaveLength(2)

    rerender(field(true))
    expect(sensorCounts.at(-1)).toBe(0)
  })
})
