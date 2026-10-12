/**
 * The row-reordering callback `ObjectListField` hands its `ItemList`, which can be called with
 * an index outside the list (a Move up on the first row) and must then change nothing.
 */
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ObjectFieldConfig } from '../../config'
import { ObjectListField } from './ObjectListField'

type Item = Record<string, unknown>

const captured = vi.hoisted(() => ({
  onMove: undefined as undefined | ((from: number, to: number) => void),
}))

vi.mock('./ItemList', () => ({
  ItemList: (props: { onMove: (from: number, to: number) => void }) => {
    captured.onMove = props.onMove
    return null
  },
}))

afterEach(() => {
  cleanup()
  captured.onMove = undefined
})

const teamField: ObjectFieldConfig = {
  name: 'team',
  type: 'object',
  list: true,
  label: 'Team',
  fields: [{ name: 'name', type: 'string' }],
}

const items: Item[] = [{ name: 'Ada' }, { name: 'Bo' }, { name: 'Cy' }]

const renderList = (onChange: (next: Item[]) => void) => {
  render(
    <MantineProvider>
      <ObjectListField
        id="team"
        label="Team"
        field={teamField}
        items={items}
        itemKeys={['a', 'b', 'c']}
        onChange={onChange}
        renderField={() => null}
        path={['team']}
        canopyPath="team"
        readOnly={false}
        resetKey="entry-1"
      />
    </MantineProvider>,
  )
  const onMove = captured.onMove
  if (!onMove) throw new Error('ItemList was not rendered')
  return onMove
}

describe('ObjectListField move', () => {
  it.each([
    ['before the first row', 0, -1],
    ['past the last row', 2, 3],
    ['far past the last row', 0, 3],
    ['onto its own position', 1, 1],
  ])('changes nothing when a row moves %s', (_label, from, to) => {
    const onChange = vi.fn()
    const onMove = renderList(onChange)

    onMove(from, to)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('reorders the items when a row moves within the list', () => {
    const onChange = vi.fn()
    const onMove = renderList(onChange)

    onMove(0, 2)

    expect(onChange).toHaveBeenCalledWith([{ name: 'Bo' }, { name: 'Cy' }, { name: 'Ada' }])
  })

  it('moves a row up by one', () => {
    const onChange = vi.fn()
    const onMove = renderList(onChange)

    onMove(2, 1)

    expect(onChange).toHaveBeenCalledWith([{ name: 'Ada' }, { name: 'Cy' }, { name: 'Bo' }])
  })
})
