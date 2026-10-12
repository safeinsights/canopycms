import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ObjectFieldConfig } from '../config'
import { focusFieldTarget, revealField, whenRevealed } from './field-target'
import type { RenderField } from './fields/ObjectField'
import { ObjectListField } from './fields/ObjectListField'
import { useListItemKeys } from './fields/list-item-keys'

afterEach(() => cleanup())

const teamField: ObjectFieldConfig = {
  name: 'team',
  type: 'object',
  list: true,
  label: 'Team',
  fields: [{ name: 'name', type: 'string' }],
}

const renderInput: RenderField = (field, value) => (
  <input aria-label={field.name} defaultValue={typeof value === 'string' ? value : ''} />
)

/** A five-item list: its first row open and the other four collapsed. */
const renderFiveRows = () => {
  const items = ['Ada', 'Bo', 'Cy', 'Di', 'Ed'].map((name) => ({ name }))
  return render(
    <MantineProvider>
      <ObjectListField
        id="team"
        label="Team"
        field={teamField}
        items={items}
        itemKeys={items.map((_, index) => `key-${index}`)}
        onChange={() => {}}
        renderField={renderInput}
        path={['team']}
        canopyPath="team"
        readOnly={false}
        resetKey="entry-1"
      />
    </MantineProvider>,
  )
}

const rowAt = (container: HTMLElement, index: number): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-canopy-field="team[${index}]"]`)!
const toggleAt = (container: HTMLElement, index: number): HTMLElement =>
  rowAt(container, index).querySelector<HTMLElement>('[data-testid="item-row-toggle"]')!
const inputAt = (container: HTMLElement, index: number): HTMLInputElement =>
  rowAt(container, index).querySelector<HTMLInputElement>('input')!

describe('focusFieldTarget', () => {
  it('opens the collapsed row holding an input, then focuses the input', async () => {
    const { container } = renderFiveRows()
    const input = inputAt(container, 3)
    expect(toggleAt(container, 3).getAttribute('aria-expanded')).toBe('false')

    act(() => focusFieldTarget(input))

    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(toggleAt(container, 3).getAttribute('aria-expanded')).toBe('true')
    // Only the row that holds the field opens.
    expect(
      [0, 1, 2, 3, 4].map((index) => toggleAt(container, index).getAttribute('aria-expanded')),
    ).toEqual(['true', 'false', 'false', 'true', 'false'])
  })

  it('opens the collapsed row when given the row itself, and focuses its first input', async () => {
    const { container } = renderFiveRows()

    act(() => focusFieldTarget(rowAt(container, 2)))

    await waitFor(() => expect(document.activeElement).toBe(inputAt(container, 2)))
    expect(toggleAt(container, 2).getAttribute('aria-expanded')).toBe('true')
  })

  it('focuses an input in an open row at once, without waiting for a frame', () => {
    const { container } = renderFiveRows()
    const input = inputAt(container, 0)

    focusFieldTarget(input)

    expect(document.activeElement).toBe(input)
  })

  it('scrolls the field into view', () => {
    const { container } = renderFiveRows()
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')

    focusFieldTarget(inputAt(container, 0))

    expect(scroll).toHaveBeenCalledTimes(1)
    scroll.mockRestore()
  })
})

describe('revealField', () => {
  it('returns false when no row holding the element was collapsed', () => {
    const { container } = renderFiveRows()
    expect(revealField(inputAt(container, 0))).toBe(false)
    expect(revealField(rowAt(container, 0))).toBe(false)
  })

  it('returns false for an element outside any list', () => {
    render(<input aria-label="Title" />)
    expect(revealField(screen.getByLabelText('Title'))).toBe(false)
  })

  it('returns true, and opens the row, when the element was in a collapsed row', () => {
    const { container } = renderFiveRows()

    let revealed: boolean | undefined
    act(() => {
      revealed = revealField(inputAt(container, 4))
    })

    expect(revealed).toBe(true)
    expect(toggleAt(container, 4).getAttribute('aria-expanded')).toBe('true')
  })

  it('returns false the second time, the row being open by then', () => {
    const { container } = renderFiveRows()
    act(() => {
      revealField(inputAt(container, 4))
    })
    expect(revealField(inputAt(container, 4))).toBe(false)
  })
})

describe('whenRevealed', () => {
  it('runs the callback at once when no row had to open', () => {
    const { container } = renderFiveRows()
    const then = vi.fn()

    whenRevealed(inputAt(container, 0), then)

    expect(then).toHaveBeenCalledTimes(1)
  })

  it('runs the callback only after a collapsed row has opened', async () => {
    const { container } = renderFiveRows()
    const expandedWhenRun: Array<string | null> = []
    const then = vi.fn(() =>
      expandedWhenRun.push(toggleAt(container, 1).getAttribute('aria-expanded')),
    )

    act(() => whenRevealed(inputAt(container, 1), then))
    expect(then).not.toHaveBeenCalled()

    await waitFor(() => expect(then).toHaveBeenCalledTimes(1))
    expect(expandedWhenRun).toEqual(['true'])
  })
})

describe('whenRevealed in a browser that reports visibility', () => {
  const proto = HTMLElement.prototype as { checkVisibility?: () => boolean }
  const original = proto.checkVisibility
  afterEach(() => {
    proto.checkVisibility = original
  })

  it('asks again until a row mounted with the field opens, then runs once the field shows', async () => {
    proto.checkVisibility = function (this: HTMLElement) {
      return this.isConnected && !this.closest('[hidden]')
    }
    const shownWhenRun: boolean[] = []
    const Asker = () => {
      const ref = React.useRef<HTMLSpanElement>(null)
      // A child's layout effect runs before its row's, so this first ask finds no listener.
      React.useLayoutEffect(() => {
        const el = ref.current
        if (el) whenRevealed(el, () => shownWhenRun.push(el.checkVisibility()))
      }, [])
      return <span ref={ref} />
    }
    const field: ObjectFieldConfig = {
      name: 'team',
      type: 'object',
      list: true,
      label: 'Team',
      fields: [{ name: 'name', type: 'string' }],
    }
    const Mounting = () => {
      const keysFor = useListItemKeys()
      const items = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name }))
      return (
        <MantineProvider>
          <ObjectListField
            id="team"
            label="Team"
            field={field}
            items={items}
            itemKeys={keysFor(items, 'team')}
            onChange={() => {}}
            renderField={(_f, _v, _c, path) =>
              path[1] === 4 ? <Asker /> : <input aria-label={path.join('.')} />
            }
            path={['team']}
            canopyPath="team"
            readOnly={false}
            resetKey="entry"
          />
        </MantineProvider>
      )
    }
    render(<Mounting />)
    await waitFor(() => expect(shownWhenRun).toEqual([true]))
  })
})
