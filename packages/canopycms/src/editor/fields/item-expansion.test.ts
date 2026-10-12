import React from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { FormExpansionContext, type FormExpansionCommand } from './form-expansion'
import { useItemExpansion, type ItemExpansion } from './item-expansion'

interface Props {
  keys: string[]
  resetKey?: string
}

const setup = (keys: string[], resetKey = 'entry-1') =>
  renderHook<ItemExpansion, Props>(
    ({ keys: k, resetKey: r = 'entry-1' }) => useItemExpansion(k, r),
    {
      initialProps: { keys, resetKey },
    },
  )

const openKeys = (hook: ReturnType<typeof setup>, keys: string[]): string[] =>
  keys.filter((key) => hook.result.current.isExpanded(key))

describe('useItemExpansion', () => {
  it('opens every row of a list of up to three', () => {
    const hook = setup(['a', 'b', 'c'])
    expect(openKeys(hook, ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
    expect(hook.result.current.allExpanded).toBe(true)
  })

  it('opens only the first row of a list of four or more', () => {
    const keys = ['a', 'b', 'c', 'd']
    const hook = setup(keys)
    expect(openKeys(hook, keys)).toEqual(['a'])
    expect(hook.result.current.allExpanded).toBe(false)
  })

  it('opens a row added after the list first showed rows, even in a long list', () => {
    const hook = setup(['a', 'b', 'c', 'd'])
    hook.rerender({ keys: ['a', 'b', 'c', 'd', 'e'] })
    expect(openKeys(hook, ['a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'e'])
  })

  it('opens a row inserted in the middle, such as a duplicate', () => {
    const hook = setup(['a', 'b', 'c', 'd'])
    hook.rerender({ keys: ['a', 'dup', 'b', 'c', 'd'] })
    expect(openKeys(hook, ['a', 'dup', 'b', 'c', 'd'])).toEqual(['a', 'dup'])
  })

  it('keeps each row where the editor left it through a reorder', () => {
    const hook = setup(['a', 'b', 'c'])
    act(() => hook.result.current.setExpanded('b', false))
    hook.rerender({ keys: ['c', 'b', 'a'] })
    expect(openKeys(hook, ['c', 'b', 'a'])).toEqual(['c', 'a'])
  })

  it('keeps the defaults of a long list with their keys, not their positions, through a reorder', () => {
    const keys = ['a', 'b', 'c', 'd']
    const hook = setup(keys)
    hook.rerender({ keys: ['b', 'a', 'c', 'd'] })
    expect(openKeys(hook, keys)).toEqual(['a'])
  })

  it('keeps a row open or shut through its removal and return', () => {
    const hook = setup(['a', 'b', 'c', 'd'])
    act(() => hook.result.current.setExpanded('c', true))
    hook.rerender({ keys: ['a', 'b', 'd'] })
    hook.rerender({ keys: ['a', 'b', 'c', 'd'] })
    expect(openKeys(hook, ['a', 'b', 'c', 'd'])).toEqual(['a', 'c'])
  })

  it('starts over when the entry changes: another list of the same keys gets the defaults', () => {
    const keys = ['a', 'b', 'c', 'd']
    const hook = setup(keys, 'entry-1')
    act(() => hook.result.current.setExpanded('c', true))
    act(() => hook.result.current.setExpanded('a', false))
    expect(openKeys(hook, keys)).toEqual(['c'])

    hook.rerender({ keys, resetKey: 'entry-2' })
    expect(openKeys(hook, keys)).toEqual(['a'])
  })

  it('keeps nothing from the old entry when a row of the new one is toggled', () => {
    const keys = ['a', 'b', 'c', 'd']
    const hook = setup(keys, 'entry-1')
    act(() => hook.result.current.setExpanded('c', true))

    hook.rerender({ keys, resetKey: 'entry-2' })
    act(() => hook.result.current.setExpanded('b', true))

    expect(openKeys(hook, keys)).toEqual(['a', 'b'])
  })

  it('starts over when the entry changes: a short list opens in full, and a long one opens its first', () => {
    const hook = setup(['a', 'b', 'c', 'd'], 'entry-1')
    hook.rerender({ keys: ['x', 'y'], resetKey: 'entry-2' })
    expect(openKeys(hook, ['x', 'y'])).toEqual(['x', 'y'])

    hook.rerender({ keys: ['p', 'q', 'r', 's', 't'], resetKey: 'entry-3' })
    expect(openKeys(hook, ['p', 'q', 'r', 's', 't'])).toEqual(['p'])
  })

  it('counts rows added after the entry changed as added, not as the first population', () => {
    const hook = setup(['a'], 'entry-1')
    hook.rerender({ keys: ['x', 'y', 'z', 'w'], resetKey: 'entry-2' })
    expect(openKeys(hook, ['x', 'y', 'z', 'w'])).toEqual(['x'])
    hook.rerender({ keys: ['x', 'y', 'z', 'w', 'v'], resetKey: 'entry-2' })
    expect(openKeys(hook, ['x', 'y', 'z', 'w', 'v'])).toEqual(['x', 'v'])
  })

  it('setAll shuts every row, then opens every row, and allExpanded follows', () => {
    const keys = ['a', 'b', 'c', 'd']
    const hook = setup(keys)

    act(() => hook.result.current.setAll(false))
    expect(openKeys(hook, keys)).toEqual([])
    expect(hook.result.current.allExpanded).toBe(false)

    act(() => hook.result.current.setAll(true))
    expect(openKeys(hook, keys)).toEqual(keys)
    expect(hook.result.current.allExpanded).toBe(true)
  })

  it('allExpanded drops when one row is shut, and returns when it opens', () => {
    const hook = setup(['a', 'b'])
    expect(hook.result.current.allExpanded).toBe(true)
    act(() => hook.result.current.setExpanded('b', false))
    expect(hook.result.current.allExpanded).toBe(false)
    act(() => hook.result.current.setExpanded('b', true))
    expect(hook.result.current.allExpanded).toBe(true)
  })

  it('opens a row added after setAll(false), and leaves the shut rows shut', () => {
    const hook = setup(['a', 'b'])
    act(() => hook.result.current.setAll(false))
    hook.rerender({ keys: ['a', 'b', 'c'] })
    expect(openKeys(hook, ['a', 'b', 'c'])).toEqual(['c'])
  })

  it('has no expanded rows to report for an empty list', () => {
    const hook = setup([])
    expect(hook.result.current.allExpanded).toBe(false)
  })

  it('counts the first rows of an initially empty list as the first population', () => {
    const hook = setup([])
    hook.rerender({ keys: ['a', 'b', 'c', 'd'] })
    expect(openKeys(hook, ['a', 'b', 'c', 'd'])).toEqual(['a'])
  })

  it('opens every row added one at a time to an initially empty list', () => {
    const hook = setup([])
    hook.rerender({ keys: ['a'] })
    hook.rerender({ keys: ['a', 'b'] })
    hook.rerender({ keys: ['a', 'b', 'c'] })
    hook.rerender({ keys: ['a', 'b', 'c', 'd'] })
    expect(openKeys(hook, ['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('useItemExpansion under the form-wide Expand all and Collapse all', () => {
  const KEYS = ['a', 'b', 'c', 'd', 'e']

  /** A list inside a form whose current command the test sets, as FormRenderer does on a press. */
  const setupInForm = (initialCommand?: FormExpansionCommand) => {
    let command = initialCommand
    let keys = KEYS
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      React.createElement(FormExpansionContext.Provider, { value: command }, children)
    const hook = renderHook<ItemExpansion, Props>(
      ({ keys, resetKey = 'entry-1' }) => useItemExpansion(keys, resetKey),
      { initialProps: { keys }, wrapper },
    )
    /** Makes a command and re-renders, as a press does; `seq` is one past the last. */
    const press = (expanded: boolean) => {
      command = { seq: (command?.seq ?? 0) + 1, expanded }
      hook.rerender({ keys })
    }
    /** Re-renders with the command unchanged, as any other render of the form does. */
    const rerenderForm = () => hook.rerender({ keys })
    const setKeys = (next: string[]) => {
      keys = next
      rerenderForm()
    }
    return { hook, press, rerenderForm, setKeys }
  }

  it('opens every row on an Expand all made after mount, and shuts every row on a Collapse all', () => {
    const { hook, press } = setupInForm()
    expect(openKeys(hook, KEYS)).toEqual(['a'])

    press(true)
    expect(openKeys(hook, KEYS)).toEqual(KEYS)
    expect(hook.result.current.allExpanded).toBe(true)

    press(false)
    expect(openKeys(hook, KEYS)).toEqual([])
    expect(hook.result.current.allExpanded).toBe(false)
  })

  it('does not apply a command made before the list mounted', () => {
    const { hook, rerenderForm } = setupInForm({ seq: 4, expanded: true })
    expect(openKeys(hook, KEYS)).toEqual(['a'])
    rerenderForm()
    expect(openKeys(hook, KEYS)).toEqual(['a'])
  })

  it('applies a press of the same command again, after a row was toggled by hand', () => {
    const { hook, press } = setupInForm()
    press(true)
    act(() => hook.result.current.setExpanded('c', false))
    expect(openKeys(hook, KEYS)).toEqual(['a', 'b', 'd', 'e'])

    press(true)
    expect(openKeys(hook, KEYS)).toEqual(KEYS)
  })

  it('leaves a hand toggle alone when the form re-renders with the command it already applied', () => {
    const { hook, press, rerenderForm } = setupInForm()
    press(true)
    act(() => hook.result.current.setExpanded('c', false))
    rerenderForm()
    rerenderForm()
    expect(openKeys(hook, KEYS)).toEqual(['a', 'b', 'd', 'e'])
  })

  it('opens a row added after a Collapse all, and leaves the shut rows shut', () => {
    const { hook, press, setKeys } = setupInForm()
    press(false)
    setKeys([...KEYS, 'f'])
    expect(openKeys(hook, [...KEYS, 'f'])).toEqual(['f'])
  })

  it('applies a command to the rows the list has when it is pressed, including ones added since mount', () => {
    const { hook, press, setKeys } = setupInForm()
    const grown = [...KEYS, 'f']
    setKeys(grown)
    press(false)
    expect(openKeys(hook, grown)).toEqual([])
    press(true)
    expect(openKeys(hook, grown)).toEqual(grown)
  })
})
