/**
 * BlockField's dragging follows `readOnly` both ways, including a block list that first renders
 * read-only (the branch list still loading) and then unlocks, without changing the sensor count.
 */
import React from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
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

  it('offers no menu, add or insert control while read-only, and all of them once it unlocks', () => {
    const { rerender } = render(field(true))
    expect(screen.queryAllByRole('button', { name: 'Actions for Hero' })).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Add section' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add section here' })).toBeNull()

    rerender(field(false))
    expect(screen.getAllByRole('button', { name: 'Actions for Hero' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Add section' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Add section here' })).toHaveLength(1)

    rerender(field(true))
    expect(screen.queryAllByRole('button', { name: 'Actions for Hero' })).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Add section' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add section here' })).toBeNull()
  })

  it('still collapses and opens a block while read-only', () => {
    render(field(true))
    const [toggle] = screen.getAllByTestId('item-row-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })
})
