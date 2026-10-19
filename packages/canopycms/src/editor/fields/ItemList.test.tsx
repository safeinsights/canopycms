/**
 * The collapsible rows shared by object lists and block lists, driven through `ObjectListField`
 * and `BlockField`: collapsing, the row menu, adding, and what a read-only list withholds.
 */
import React, { useEffect, useRef, useState } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BlockConfig, FieldConfig, ObjectFieldConfig } from '../../config'
import { revealField } from '../field-target'
import { BlockField, type BlockInstance } from './BlockField'
import type { RenderField } from './ObjectField'
import { ItemList } from './ItemList'
import { useItemExpansion } from './item-expansion'
import { ObjectListField } from './ObjectListField'
import { useListItemKeys } from './list-item-keys'
import { ITEM_KEY, isItemKey } from '../../item-keys'

afterEach(() => cleanup())

type Item = Record<string, unknown>

const renderInput: RenderField = (field, value, onChange) => (
  <input
    aria-label={field.name}
    value={typeof value === 'string' ? value : ''}
    onChange={(event) => onChange(event.currentTarget.value)}
  />
)

const teamField: ObjectFieldConfig = {
  name: 'team',
  type: 'object',
  list: true,
  label: 'Team',
  fields: [
    { name: 'name', type: 'string' },
    { name: 'city', type: 'string' },
  ],
}

const people = (...names: string[]): Item[] => names.map((name) => ({ name }))
const five = () => people('Ada', 'Bo', 'Cy', 'Di', 'Ed')

interface ListHarnessProps {
  initial: Item[]
  field?: ObjectFieldConfig
  readOnly?: boolean
  hasErrors?: (index: number) => boolean
  onChange?: (next: Item[]) => void
  onRemoved?: (index: number, item: Item) => void
}

/** An object list holding its own items, as a form does, reporting each change to `onChange`. */
const ListHarness: React.FC<ListHarnessProps> = ({
  initial,
  field = teamField,
  readOnly = false,
  hasErrors,
  onChange,
  onRemoved,
}) => {
  const [items, setItems] = useState(initial)
  const keysFor = useListItemKeys()
  return (
    <MantineProvider>
      <ObjectListField
        id="team"
        label="Team"
        field={field}
        items={items}
        itemKeys={keysFor(items, 'team')}
        onChange={(next) => {
          onChange?.(next)
          setItems(next)
        }}
        renderField={renderInput}
        path={['team']}
        canopyPath="team"
        readOnly={readOnly}
        resetKey="entry-1"
        hasErrors={hasErrors}
        onRemoved={onRemoved}
      />
    </MantineProvider>
  )
}

const templates: BlockConfig[] = [
  {
    name: 'hero',
    label: 'Hero',
    description: 'The banner at the top of a page',
    fields: [{ name: 'headline', type: 'string' }],
  },
  {
    name: 'cta',
    label: 'Call to action',
    description: 'A button with a short prompt',
    fields: [{ name: 'text', type: 'string' }],
  },
]

const hero = (headline: string): BlockInstance => ({ template: 'hero', value: { headline } })
const cta = (text: string): BlockInstance => ({ template: 'cta', value: { text } })

interface BlockHarnessProps {
  initial: BlockInstance[]
  readOnly?: boolean
  maxItems?: number
  onChange?: (next: BlockInstance[]) => void
  onRemoved?: (index: number, block: BlockInstance) => void
}

const BlockHarness: React.FC<BlockHarnessProps> = ({
  initial,
  readOnly = false,
  maxItems,
  onChange,
  onRemoved,
}) => {
  const [blocks, setBlocks] = useState(initial)
  return (
    <MantineProvider>
      <BlockField
        label="Sections"
        templates={templates}
        value={blocks}
        onChange={(next) => {
          onChange?.(next)
          setBlocks(next)
        }}
        renderField={renderInput}
        path={['blocks']}
        readOnly={readOnly}
        resetKey="entry-1"
        onRemoved={onRemoved}
        maxItems={maxItems}
      />
    </MantineProvider>
  )
}

const rows = (): HTMLElement[] => screen.getAllByTestId('item-row')
const rowTitles = (): Array<string | null> => rows().map((row) => row.getAttribute('aria-label'))
const toggleOf = (row: HTMLElement): HTMLElement => within(row).getByTestId('item-row-toggle')
const expandedStates = (): string[] =>
  rows().map((row) => toggleOf(row).getAttribute('aria-expanded') ?? 'missing')
const bodyOf = (row: HTMLElement): HTMLElement =>
  document.getElementById(toggleOf(row).getAttribute('aria-controls') ?? '')!
const actionsButton = (row: HTMLElement): HTMLElement =>
  within(row).getByRole('button', { name: /^Actions for / })
const liveRegion = (): string =>
  document.querySelector('[aria-live="polite"]')?.textContent ?? 'no live region'

type User = ReturnType<typeof userEvent.setup>

const openRowMenu = async (user: User, row: HTMLElement) => {
  await user.click(actionsButton(row))
  return screen.findByRole('menu')
}

/** Chooses `item` from the "..." menu of `row`, then waits for the menu to close. */
const chooseFromRowMenu = async (user: User, row: HTMLElement, item: RegExp | string) => {
  await openRowMenu(user, row)
  await user.click(await screen.findByRole('menuitem', { name: item }))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
}

describe('collapsing a row', () => {
  it('shuts a row to its header on its toggle, keeps its fields mounted, and opens it again', async () => {
    const user = userEvent.setup()
    render(<ListHarness initial={people('Ada', 'Bo')} />)
    const [first] = rows()
    const toggle = toggleOf(first)

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(bodyOf(first).hidden).toBe(false)
    expect(first.hasAttribute('data-expanded')).toBe(true)
    expect(screen.getAllByRole('textbox', { name: 'name' })).toHaveLength(2)

    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(bodyOf(first).hidden).toBe(true)
    expect(first.hasAttribute('data-expanded')).toBe(false)
    // Hidden from the accessibility tree, yet still in the document with its value.
    expect(screen.getAllByRole('textbox', { name: 'name' })).toHaveLength(1)
    expect(within(bodyOf(first)).getByDisplayValue('Ada')).toBeTruthy()

    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(bodyOf(first).hidden).toBe(false)
    expect(screen.getAllByRole('textbox', { name: 'name' })).toHaveLength(2)
  })

  it('shows the row title with the next text value dimmed beside it', () => {
    render(<ListHarness initial={[{ name: 'Ada', city: 'London' }]} />)
    expect(toggleOf(rows()[0]).textContent).toBe('AdaLondon')
  })

  it.each([
    [1, ['true']],
    [2, ['true', 'true']],
    [3, ['true', 'true', 'true']],
    [4, ['true', 'false', 'false', 'false']],
    [5, ['true', 'false', 'false', 'false', 'false']],
  ])('starts a list of %i with the rows open that the default says', (count, expected) => {
    render(<ListHarness initial={people(...['Ada', 'Bo', 'Cy', 'Di', 'Ed'].slice(0, count))} />)
    expect(expandedStates()).toEqual(expected)
  })
})

describe('Expand all and Collapse all', () => {
  const expandAll = () => screen.getByTestId('list-expand-all')

  it('is absent from a list of one row', () => {
    render(<ListHarness initial={people('Ada')} />)
    expect(screen.queryByTestId('list-expand-all')).toBeNull()
  })

  it('reads "Expand all" until every row is open, opens them all, then reads "Collapse all"', async () => {
    const user = userEvent.setup()
    render(<ListHarness initial={five()} />)
    expect(expandAll().textContent).toBe('Expand all')

    await user.click(expandAll())
    expect(expandedStates()).toEqual(['true', 'true', 'true', 'true', 'true'])
    expect(expandAll().textContent).toBe('Collapse all')

    await user.click(expandAll())
    expect(expandedStates()).toEqual(['false', 'false', 'false', 'false', 'false'])
    expect(expandAll().textContent).toBe('Expand all')
  })

  it('flips its label as single rows are toggled', async () => {
    const user = userEvent.setup()
    render(<ListHarness initial={people('Ada', 'Bo')} />)
    expect(expandAll().textContent).toBe('Collapse all')

    await user.click(toggleOf(rows()[1]))
    expect(expandAll().textContent).toBe('Expand all')

    await user.click(toggleOf(rows()[1]))
    expect(expandAll().textContent).toBe('Collapse all')
  })

  it('opens the rest of a partly open list rather than shutting it', async () => {
    const user = userEvent.setup()
    render(<ListHarness initial={people('Ada', 'Bo', 'Cy')} />)
    await user.click(toggleOf(rows()[2]))
    expect(expandedStates()).toEqual(['true', 'true', 'false'])

    await user.click(expandAll())
    expect(expandedStates()).toEqual(['true', 'true', 'true'])
  })
})

describe('the row menu', () => {
  it('moves a row up, reports the new order, and returns focus to that row\'s "Actions for" button', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ListHarness initial={people('Ada', 'Bo', 'Cy')} onChange={onChange} />)

    await chooseFromRowMenu(user, rows()[1], /^Move up/)

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(people('Bo', 'Ada', 'Cy'))
    expect(rowTitles()).toEqual(['Bo', 'Ada', 'Cy'])
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions for Bo' })),
    )
  })

  it('moves a row down, reports the new order, and returns focus to that row\'s "Actions for" button', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ListHarness initial={people('Ada', 'Bo', 'Cy')} onChange={onChange} />)

    await chooseFromRowMenu(user, rows()[1], /^Move down/)

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(people('Ada', 'Cy', 'Bo'))
    expect(rowTitles()).toEqual(['Ada', 'Cy', 'Bo'])
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions for Bo' })),
    )
  })

  it('keeps a moved row open or shut as it was', async () => {
    const user = userEvent.setup()
    render(<ListHarness initial={five()} />)
    // Ada is open, the rest shut.
    await chooseFromRowMenu(user, rows()[0], /^Move down/)
    expect(rowTitles()).toEqual(['Bo', 'Ada', 'Cy', 'Di', 'Ed'])
    expect(expandedStates()).toEqual(['false', 'true', 'false', 'false', 'false'])
  })

  it('blocks Move up on the first row: aria-disabled, says why, and does nothing when chosen', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ListHarness initial={people('Ada', 'Bo')} onChange={onChange} />)

    await openRowMenu(user, rows()[0])
    const moveUp = await screen.findByTestId('item-row-move-up')
    expect(moveUp.getAttribute('aria-disabled')).toBe('true')
    expect(moveUp.textContent).toContain('Already first')
    expect(screen.getByTestId('item-row-move-down').getAttribute('aria-disabled')).toBeNull()

    await user.click(moveUp)
    expect(onChange).not.toHaveBeenCalled()
    expect(rowTitles()).toEqual(['Ada', 'Bo'])
  })

  it('blocks Move down on the last row, and only there', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ListHarness initial={people('Ada', 'Bo')} onChange={onChange} />)

    await openRowMenu(user, rows()[1])
    const moveDown = await screen.findByTestId('item-row-move-down')
    expect(moveDown.getAttribute('aria-disabled')).toBe('true')
    expect(moveDown.textContent).toContain('Already last')
    expect(screen.getByTestId('item-row-move-up').getAttribute('aria-disabled')).toBeNull()
    expect(screen.getByTestId('item-row-move-up').textContent).not.toContain('Already')

    await user.click(moveDown)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('blocks both moves on the only row', async () => {
    const user = userEvent.setup()
    render(<ListHarness initial={people('Ada')} />)
    await openRowMenu(user, rows()[0])
    expect((await screen.findByTestId('item-row-move-up')).getAttribute('aria-disabled')).toBe(
      'true',
    )
    expect(screen.getByTestId('item-row-move-down').getAttribute('aria-disabled')).toBe('true')
  })

  it('duplicates a row as a deep copy placed after it, and opens the copy', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const original = { [ITEM_KEY]: 'cy-key', name: 'Cy', tags: ['x'], address: { town: 'Leeds' } }
    const initial: Item[] = [...people('Ada', 'Bo'), original, ...people('Di', 'Ed')]
    render(<ListHarness initial={initial} onChange={onChange} />)
    expect(expandedStates()).toEqual(['true', 'false', 'false', 'false', 'false'])

    await chooseFromRowMenu(user, rows()[2], 'Duplicate')

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as Item[]
    expect(next).toHaveLength(6)
    expect(next[2]).toBe(original)
    // The copy is the original but for its key, which is a new, usable one.
    expect(next[3]).toEqual({ ...original, [ITEM_KEY]: expect.any(String) })
    expect(isItemKey(next[3][ITEM_KEY])).toBe(true)
    expect(next[3][ITEM_KEY]).not.toBe('cy-key')
    expect(next[2][ITEM_KEY]).toBe('cy-key')
    expect(next[3]).not.toBe(original)
    expect(next[3].tags).not.toBe(original.tags)
    expect(next[3].address).not.toBe(original.address)
    expect(next.map((item) => item.name)).toEqual(['Ada', 'Bo', 'Cy', 'Cy', 'Di', 'Ed'])
    // The copy is open; the row it came from stays as it was.
    expect(expandedStates()).toEqual(['true', 'false', 'false', 'true', 'false', 'false'])
  })

  it('removes a row, reports it with its index, and puts focus on the list', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onRemoved = vi.fn()
    const initial = people('Ada', 'Bo', 'Cy')
    render(<ListHarness initial={initial} onChange={onChange} onRemoved={onRemoved} />)

    await chooseFromRowMenu(user, rows()[1], 'Remove')

    expect(onChange).toHaveBeenCalledWith([initial[0], initial[2]])
    expect(onRemoved).toHaveBeenCalledTimes(1)
    expect(onRemoved.mock.calls[0][0]).toBe(1)
    expect(onRemoved.mock.calls[0][1]).toBe(initial[1])
    expect(rowTitles()).toEqual(['Ada', 'Cy'])
    expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Team' }))
  })

  it("announces a menu move, in the row's own title, to a polite live region", async () => {
    const user = userEvent.setup()
    render(<ListHarness initial={people('Fast', 'Slow')} />)
    expect(liveRegion()).toBe('')

    await chooseFromRowMenu(user, rows()[0], /^Move down/)

    expect(liveRegion()).toBe('Fast moved to position 2 of 2.')
  })

  it('announces a duplicate with the new length, and keeps focus on the source row menu', async () => {
    const user = userEvent.setup()
    render(<ListHarness initial={people('Fast', 'Slow')} />)

    await chooseFromRowMenu(user, rows()[0], 'Duplicate')

    expect(liveRegion()).toBe('Fast duplicated, position 2 of 3.')
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(rows()[0]).getByRole('button', { name: 'Actions for Fast' }),
      ),
    )
  })
})

describe('adding an item', () => {
  it('reads "Add item" by default and appends an empty item', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ListHarness initial={people('Ada')} onChange={onChange} />)

    const add = screen.getByTestId('object-list-add')
    expect(add.textContent).toBe('Add item')
    expect(screen.getByRole('button', { name: 'Add item' })).toBe(add)

    await user.click(add)
    expect(onChange).toHaveBeenCalledWith([{ name: 'Ada' }, { [ITEM_KEY]: expect.any(String) }])
    const added = onChange.mock.calls[0][0][1] as Item
    expect(isItemKey(added[ITEM_KEY])).toBe(true)
  })

  it('reads "Add <itemLabel>" when the schema names what one item is', () => {
    render(<ListHarness initial={[]} field={{ ...teamField, itemLabel: 'team member' }} />)
    expect(screen.getByTestId('object-list-add').textContent).toBe('Add team member')
    expect(screen.getByRole('button', { name: 'Add team member' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add item' })).toBeNull()
  })

  it('opens the new row and focuses its first input', async () => {
    const user = userEvent.setup()
    render(<ListHarness initial={five()} />)
    expect(expandedStates()).toEqual(['true', 'false', 'false', 'false', 'false'])

    await user.click(screen.getByTestId('object-list-add'))

    expect(expandedStates()).toEqual(['true', 'false', 'false', 'false', 'false', 'true'])
    const added = rows()[5]
    await waitFor(() =>
      expect(document.activeElement).toBe(within(added).getAllByRole('textbox')[0]),
    )
  })
})

describe('a collapsed row with a validation error', () => {
  it('says "Has errors" while it is collapsed, and not while it is open', async () => {
    const user = userEvent.setup()
    render(<ListHarness initial={five()} hasErrors={(index) => index === 1} />)

    expect(within(rows()[1]).getByText('Has errors')).toBeTruthy()
    expect(within(rows()[2]).queryByText('Has errors')).toBeNull()
    expect(within(rows()[0]).queryByText('Has errors')).toBeNull()

    await user.click(toggleOf(rows()[1]))
    expect(within(rows()[1]).queryByText('Has errors')).toBeNull()

    await user.click(toggleOf(rows()[1]))
    expect(within(rows()[1]).getByText('Has errors')).toBeTruthy()
  })

  it('says nothing when the list reports no errors', () => {
    render(<ListHarness initial={five()} hasErrors={() => false} />)
    expect(screen.queryByText('Has errors')).toBeNull()
  })
})

describe('a read-only object list', () => {
  it('has no drag handle, row menu or add button, but its rows still collapse', async () => {
    const user = userEvent.setup()
    render(<ListHarness initial={people('Ada', 'Bo')} readOnly />)

    expect(screen.queryByRole('button', { name: 'Drag to reorder' })).toBeNull()
    expect(screen.queryByTestId('item-row-menu')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Actions for / })).toBeNull()
    expect(screen.queryByTestId('object-list-add')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Add / })).toBeNull()

    const toggle = toggleOf(rows()[0])
    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('has all of them when it is editable', () => {
    render(<ListHarness initial={people('Ada', 'Bo')} />)
    expect(screen.getAllByRole('button', { name: 'Drag to reorder' })).toHaveLength(2)
    expect(screen.getAllByTestId('item-row-menu')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Actions for Ada' })).toBeTruthy()
    expect(screen.getByTestId('object-list-add')).toBeTruthy()
  })
})

describe('row names', () => {
  it('tell rows with one title apart by their second value, in the row and in its "Actions for" button', () => {
    render(<BlockHarness initial={[hero('One'), hero('Two')]} />)
    expect(rowTitles()).toEqual(['Hero, One', 'Hero, Two'])
    expect(screen.getByRole('button', { name: 'Actions for Hero, One' })).toBe(
      actionsButton(rows()[0]),
    )
    expect(screen.getByRole('button', { name: 'Actions for Hero, Two' })).toBe(
      actionsButton(rows()[1]),
    )
  })

  it('leave the drag handle named "Drag to reorder"', () => {
    render(<BlockHarness initial={[hero('One'), hero('Two')]} />)
    expect(screen.getAllByRole('button', { name: 'Drag to reorder' })).toHaveLength(2)
  })

  it('name an untitled item by its position, in the words of itemLabel when the schema has one', () => {
    render(<ListHarness initial={[{}, {}]} field={{ ...teamField, itemLabel: 'team member' }} />)
    expect(rowTitles()).toEqual(['Team member 1', 'Team member 2'])
    expect(screen.getByRole('button', { name: 'Actions for Team member 2' })).toBe(
      actionsButton(rows()[1]),
    )
  })

  it('name an untitled item "Item N" without an itemLabel', () => {
    render(<ListHarness initial={[{}, {}]} />)
    expect(rowTitles()).toEqual(['Item 1', 'Item 2'])
  })
})

describe('an object list with no items', () => {
  it('says "Nothing added yet." while editable and "Nothing added." when read-only', () => {
    const { unmount } = render(<ListHarness initial={[]} />)
    expect(screen.getByText('Nothing added yet.')).toBeTruthy()
    unmount()
    render(<ListHarness initial={[]} readOnly />)
    expect(screen.getByText('Nothing added.')).toBeTruthy()
    expect(screen.queryByText('Nothing added yet.')).toBeNull()
  })
})

describe('the Remove menu item', () => {
  it("takes the danger text colour, which reads at 4.5:1 where Mantine's red.6 does not", async () => {
    const user = userEvent.setup()
    render(<ListHarness initial={people('Ada')} />)
    await openRowMenu(user, rows()[0])
    const remove = await screen.findByTestId('item-row-remove')
    expect(remove.getAttribute('style')).toContain('--canopy-danger-text')
  })
})

describe('a block list', () => {
  const sectionMenu = () => screen.findByTestId('block-template-menu')

  it('titles a row with its template label and dims the first text value beside it', () => {
    render(<BlockHarness initial={[hero('Welcome'), cta('Sign up')]} />)
    expect(rowTitles()).toEqual(['Hero, Welcome', 'Call to action, Sign up'])
    expect(toggleOf(rows()[0]).textContent).toBe('HeroWelcome')
    expect(toggleOf(rows()[1]).textContent).toBe('Call to actionSign up')
  })

  it('lists each template with its description under "Add section"', async () => {
    const user = userEvent.setup()
    render(<BlockHarness initial={[]} />)
    expect(screen.getByTestId('block-add-section').textContent).toBe('Add section')

    await user.click(screen.getByRole('button', { name: 'Add section' }))
    const menu = await sectionMenu()

    const heroItem = within(menu).getByTestId('block-template-hero')
    expect(heroItem.textContent).toContain('Hero')
    expect(heroItem.textContent).toContain('The banner at the top of a page')
    const ctaItem = within(menu).getByTestId('block-template-cta')
    expect(ctaItem.textContent).toContain('Call to action')
    expect(ctaItem.textContent).toContain('A button with a short prompt')
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2)
  })

  it('appends an empty block of the template picked, open, with its first input focused', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const first = hero('Welcome')
    render(<BlockHarness initial={[first]} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: 'Add section' }))
    await user.click(within(await sectionMenu()).getByTestId('block-template-cta'))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith([
      first,
      { [ITEM_KEY]: expect.any(String), template: 'cta', value: {} },
    ])
    // The key sits on the block, beside `template`, never inside its `value`.
    const appended = onChange.mock.calls[0][0][1] as Record<string, unknown>
    expect(isItemKey(appended[ITEM_KEY])).toBe(true)
    expect(rowTitles()).toEqual(['Hero, Welcome', 'Call to action'])
    expect(expandedStates()).toEqual(['true', 'true'])
    await waitFor(() =>
      expect(document.activeElement).toBe(within(rows()[1]).getByRole('textbox', { name: 'text' })),
    )
  })

  it('offers an "Add section here" before the first block, even when it is the only one', () => {
    render(<BlockHarness initial={[hero('Only')]} />)
    expect(screen.getAllByTestId('block-insert-between')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Add section here' })).toHaveLength(1)
    const control = screen.getByTestId('block-insert-between')
    expect(
      control.compareDocumentPosition(rows()[0]) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it.each([
    ['first', 0],
    ['second', 1],
    ['third', 2],
  ])('inserts at the index of the %s "Add section here"', async (_which, index) => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const blocks = [hero('One'), hero('Two'), hero('Three')]
    render(<BlockHarness initial={blocks} onChange={onChange} />)
    const inserts = screen.getAllByTestId('block-insert-between')
    expect(inserts).toHaveLength(3)

    await user.click(within(inserts[index]).getByRole('button', { name: 'Add section here' }))
    await user.click(within(await sectionMenu()).getByTestId('block-template-cta'))

    const expected = [...blocks]
    expected.splice(index, 0, { [ITEM_KEY]: expect.any(String), template: 'cta', value: {} })
    expect(onChange).toHaveBeenCalledWith(expected)
    const inserted = onChange.mock.calls[0][0][index] as Record<string, unknown>
    expect(isItemKey(inserted[ITEM_KEY])).toBe(true)
    expect(rowTitles()).toEqual(
      expected.map((b) =>
        b.template === 'cta' ? 'Call to action' : `Hero, ${String(b.value.headline)}`,
      ),
    )
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(rows()[index]).getByRole('textbox', { name: 'text' }),
      ),
    )
  })

  it('shows the template description at the top of the block, which describes the row while open', async () => {
    const user = userEvent.setup()
    render(<BlockHarness initial={[hero('Welcome'), cta('Sign up')]} />)
    const [heroRow, ctaRow] = rows()

    const heroDescriptionId = heroRow.getAttribute('aria-describedby')
    expect(heroDescriptionId).toBeTruthy()
    const heroDescription = document.getElementById(heroDescriptionId!)!
    expect(heroDescription.textContent).toBe('The banner at the top of a page')
    expect(bodyOf(heroRow).contains(heroDescription)).toBe(true)
    expect(bodyOf(heroRow).firstElementChild?.firstElementChild).toBe(heroDescription)

    const ctaDescription = document.getElementById(ctaRow.getAttribute('aria-describedby')!)!
    expect(ctaDescription.textContent).toBe('A button with a short prompt')
    expect(ctaDescription).not.toBe(heroDescription)

    // A shut row has no description to describe it.
    await user.click(toggleOf(heroRow))
    expect(heroRow.hasAttribute('aria-describedby')).toBe(false)
    await user.click(toggleOf(heroRow))
    expect(heroRow.getAttribute('aria-describedby')).toBe(heroDescriptionId)
  })

  it('moves a block down from its menu', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const blocks = [hero('One'), cta('Two')]
    render(<BlockHarness initial={blocks} onChange={onChange} />)

    await chooseFromRowMenu(user, rows()[0], /^Move down/)

    expect(onChange).toHaveBeenCalledWith([blocks[1], blocks[0]])
    expect(rowTitles()).toEqual(['Call to action, Two', 'Hero, One'])
  })

  it('blocks Move up on the first block', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<BlockHarness initial={[hero('One'), cta('Two')]} onChange={onChange} />)
    await openRowMenu(user, rows()[0])
    const moveUp = await screen.findByTestId('item-row-move-up')
    expect(moveUp.getAttribute('aria-disabled')).toBe('true')
    await user.click(moveUp)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('duplicates a block as a deep copy after it', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const blocks = [{ ...hero('One'), [ITEM_KEY]: 'hero-key' }, cta('Two')]
    render(<BlockHarness initial={blocks} onChange={onChange} />)

    await chooseFromRowMenu(user, rows()[0], 'Duplicate')

    const next = onChange.mock.calls[0][0] as BlockInstance[]
    expect(next).toHaveLength(3)
    // The copy is the original but for its key, which is a new, usable one on the block itself.
    expect(next[1]).toEqual({ ...blocks[0], [ITEM_KEY]: expect.any(String) })
    const copyKey = next[1][ITEM_KEY]
    expect(isItemKey(copyKey)).toBe(true)
    expect(copyKey).not.toBe('hero-key')
    expect(next[1].value).not.toHaveProperty(ITEM_KEY)
    expect(next[1]).not.toBe(blocks[0])
    expect(next[1].value).not.toBe(blocks[0].value)
    expect(next[2]).toBe(blocks[1])
  })

  it('removes a block, reports it, and puts focus on the list', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onRemoved = vi.fn()
    const blocks = [hero('One'), cta('Two')]
    render(<BlockHarness initial={blocks} onChange={onChange} onRemoved={onRemoved} />)

    await chooseFromRowMenu(user, rows()[0], 'Remove')

    expect(onChange).toHaveBeenCalledWith([blocks[1]])
    expect(onRemoved).toHaveBeenCalledWith(0, blocks[0])
    expect(onRemoved.mock.calls[0][1]).toBe(blocks[0])
    expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Sections' }))
  })

  it('has no drag handle, row menu, add or insert control when read-only, but its rows still collapse', async () => {
    const user = userEvent.setup()
    render(<BlockHarness initial={[hero('One'), cta('Two')]} readOnly />)

    expect(screen.queryByRole('button', { name: 'Drag to reorder' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Actions for / })).toBeNull()
    expect(screen.queryByTestId('item-row-menu')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add section' })).toBeNull()
    expect(screen.queryByTestId('block-add-section')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add section here' })).toBeNull()
    expect(screen.queryByTestId('block-insert-between')).toBeNull()

    const toggle = toggleOf(rows()[0])
    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('has all of them when it is editable', () => {
    render(<BlockHarness initial={[hero('One'), cta('Two')]} />)
    expect(screen.getAllByRole('button', { name: 'Drag to reorder' })).toHaveLength(2)
    expect(screen.getAllByTestId('item-row-menu')).toHaveLength(2)
    expect(screen.getByTestId('block-add-section')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Add section here' })).toHaveLength(2)
  })
})

describe('a list nested in a block list', () => {
  const leaf: BlockConfig = {
    name: 'leaf',
    label: 'Leaf',
    fields: [{ name: 'text', type: 'string' }],
  }
  const group: BlockConfig = {
    name: 'group',
    label: 'Group',
    fields: [{ name: 'children', type: 'block', templates: [leaf] }],
  }
  const renderNested = (
    field: FieldConfig,
    value: unknown,
    onChange: (v: unknown) => void,
    path: Array<string | number>,
  ): React.ReactNode =>
    field.type === 'block' ? (
      <BlockField
        label="Children"
        templates={[leaf]}
        value={(value as BlockInstance[] | undefined) ?? []}
        onChange={onChange}
        renderField={renderNested}
        path={path}
        resetKey="entry"
      />
    ) : (
      <input
        aria-label={path.join('.')}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    )
  const Nested = () => {
    const [blocks, setBlocks] = useState<BlockInstance[]>([
      {
        template: 'group',
        value: { children: [1, 2, 3].map((n) => ({ template: 'leaf', value: { text: `c${n}` } })) },
      },
      { template: 'leaf', value: { text: 'top' } },
    ])
    return (
      <MantineProvider>
        <BlockField
          label="Sections"
          templates={[group, leaf]}
          value={blocks}
          onChange={setBlocks}
          renderField={renderNested}
          path={['blocks']}
          resetKey="entry"
        />
      </MantineProvider>
    )
  }

  it('focuses the section it added, never a nested row whose key matches', async () => {
    const user = userEvent.setup()
    render(<Nested />)
    const adds = screen.getAllByTestId('block-add-section')
    await user.click(adds[adds.length - 1])
    const menus = await screen.findAllByTestId('block-template-menu')
    await user.click(within(menus[menus.length - 1]).getByTestId('block-template-leaf'))

    await waitFor(() =>
      expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toBe(
        'blocks.2.text',
      ),
    )
  })
})

describe('a field that asks to be revealed as it mounts', () => {
  const Revealer = () => {
    const ref = useRef<HTMLSpanElement>(null)
    useEffect(() => {
      if (ref.current) revealField(ref.current)
    }, [])
    return <span ref={ref} data-testid="revealer" />
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
            path[1] === 4 ? <Revealer /> : <input aria-label={path.join('.')} />
          }
          path={['team']}
          canopyPath="team"
          readOnly={false}
          resetKey="entry"
        />
      </MantineProvider>
    )
  }

  it('opens its collapsed row, which mounted in the same commit', async () => {
    render(<Mounting />)
    const row = screen.getByTestId('revealer').closest<HTMLElement>('[data-testid="item-row"]')
    await waitFor(() => expect(row?.getAttribute('data-expanded')).toBe('true'))
  })
})

describe('a list that offers no Duplicate', () => {
  const Plain: React.FC = () => {
    const keys = ['a', 'b']
    const expansion = useItemExpansion(keys, 'entry-1')
    return (
      <MantineProvider>
        <div data-removal-focus tabIndex={-1}>
          <ItemList
            items={['Ada', 'Bo']}
            itemKeys={keys}
            path={['names']}
            readOnly={false}
            expansion={expansion}
            summarize={(item) => ({ title: item })}
            renderItem={(item) => item}
            onMove={() => {}}
            onRemove={() => {}}
          />
        </div>
      </MantineProvider>
    )
  }

  it('leaves Duplicate out of the row menu', async () => {
    const user = userEvent.setup()
    render(<Plain />)
    await openRowMenu(user, rows()[0])
    expect(screen.getByRole('menuitem', { name: /^Move down/ })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /^Duplicate/ })).toBeNull()
  })
})

describe('an object list at its maxItems', () => {
  const capped = { ...teamField, maxItems: 2 }
  const reason = 'This list holds at most 2 items. Remove one to add another.'

  it('disables Add, says why on hover, and adds nothing when clicked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ListHarness initial={people('Ada', 'Bo')} field={capped} onChange={onChange} />)

    const add = screen.getByTestId('object-list-add')
    expect(add.getAttribute('aria-disabled')).toBe('true')
    await user.hover(add)
    expect((await screen.findByRole('tooltip')).textContent).toBe(reason)
    await user.click(add)
    expect(onChange).not.toHaveBeenCalled()
    expect(rows()).toHaveLength(2)
  })

  it('blocks Duplicate with the same reason', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ListHarness initial={people('Ada', 'Bo')} field={capped} onChange={onChange} />)

    await openRowMenu(user, rows()[0])
    const duplicate = screen.getByRole('menuitem', { name: /^Duplicate/ })
    expect(duplicate.getAttribute('aria-disabled')).toBe('true')
    expect(duplicate.textContent).toContain(reason)
    await user.click(duplicate)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('adds freely below the cap', async () => {
    const user = userEvent.setup()
    render(<ListHarness initial={people('Ada')} field={capped} />)
    const add = screen.getByTestId('object-list-add')
    expect(add.getAttribute('aria-disabled')).toBeNull()
    await user.click(add)
    expect(rows()).toHaveLength(2)
    expect(screen.getByTestId('object-list-add').getAttribute('aria-disabled')).toBe('true')
  })
})

describe('a block list at its maxItems', () => {
  const reason = 'This list holds at most 1 section. Remove one to add another.'
  // The dropdown mounts after a transition, so absence is only known once one would have shown.
  const expectNoTemplateMenu = () =>
    expect(screen.findByTestId('block-template-menu', {}, { timeout: 500 })).rejects.toThrow()

  it('disables "Add section", says why, and opens no template menu', async () => {
    const user = userEvent.setup()
    render(<BlockHarness initial={[hero('One')]} maxItems={1} />)

    const add = screen.getByTestId('block-add-section')
    expect(add.getAttribute('aria-disabled')).toBe('true')
    await user.hover(add)
    expect((await screen.findByRole('tooltip')).textContent).toBe(reason)
    await user.click(add)
    await expectNoTemplateMenu()
  })

  it('disables each "Add section here", naming the reason to assistive tech', async () => {
    const user = userEvent.setup()
    render(<BlockHarness initial={[hero('One')]} maxItems={1} />)

    const insert = screen.getByRole('button', { name: 'Add section here' })
    expect(insert.getAttribute('aria-disabled')).toBe('true')
    const describedBy = insert.getAttribute('aria-describedby') ?? ''
    expect(document.getElementById(describedBy)?.textContent).toBe(reason)
    await user.click(insert)
    await expectNoTemplateMenu()
  })

  it('blocks Duplicate with the same reason', async () => {
    const user = userEvent.setup()
    render(<BlockHarness initial={[hero('One')]} maxItems={1} />)
    await openRowMenu(user, rows()[0])
    const duplicate = screen.getByRole('menuitem', { name: /^Duplicate/ })
    expect(duplicate.getAttribute('aria-disabled')).toBe('true')
    expect(duplicate.textContent).toContain(reason)
  })

  it('opens the template menu below the cap', async () => {
    const user = userEvent.setup()
    render(<BlockHarness initial={[hero('One')]} maxItems={2} />)
    await user.click(screen.getByTestId('block-add-section'))
    expect(await screen.findByTestId('block-template-menu')).toBeTruthy()
  })
})
