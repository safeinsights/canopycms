/**
 * A `list: true` reference field: rows in stored order that reorder, repoint and remove like any
 * list, an Add control that keeps focus, and the cap `maxItems` sets.
 */
import React, { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FieldConfig } from '../../config'
import type { ReferenceOptionsResponse } from '../../api/reference-options'
import { createMockApiClient, type MockApiClient } from '../../api/__test__/mock-client'
import { findFieldTarget, revealField } from '../field-target'
import { FormRenderer, type FormValue } from '../FormRenderer'
import { CanopyCMSProvider } from '../theme'
import { restoreRemoval, type FieldRemoval } from '../undo-removal'
import { ReferenceListField } from './ReferenceListField'
import type { ReferenceOption } from './use-reference-options'

vi.mock('../../api/client', () => ({
  createApiClient: vi.fn(),
}))

let mockClient: MockApiClient
beforeEach(async () => {
  mockClient = createMockApiClient()
  const { createApiClient } = await import('../../api/client')
  vi.mocked(createApiClient).mockReturnValue(mockClient as never)
})
afterEach(() => cleanup())

const POSTS: ReferenceOption[] = [
  { value: 'post-spring', label: 'Spring launch' },
  { value: 'post-summer', label: 'Summer recap' },
  { value: 'post-autumn', label: 'Autumn preview' },
  { value: 'post-winter', label: 'Winter notes' },
  { value: 'post-review', label: 'Year in review' },
]

interface HarnessProps {
  initial: unknown[]
  options?: ReferenceOption[]
  collections?: string[]
  maxItems?: number
  readOnly?: boolean
  onRemoved?: (index: number, id: string, title: string) => void
}

/** The field as a form drives it, holding its own value and showing it. */
const Harness: React.FC<HarnessProps> = ({
  initial,
  options = POSTS,
  collections,
  maxItems,
  readOnly = false,
  onRemoved,
}) => {
  const [value, setValue] = useState<unknown[]>(initial)
  return (
    <CanopyCMSProvider>
      <ReferenceListField
        id="featured"
        label="Featured posts"
        options={collections ? undefined : options}
        collections={collections}
        value={value}
        onChange={setValue}
        path={['featured']}
        canopyPath="featured"
        readOnly={readOnly}
        resetKey="entry-1"
        maxItems={maxItems}
        onRemoved={onRemoved}
      />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </CanopyCMSProvider>
  )
}

const stored = (): unknown => JSON.parse(screen.getByTestId('value').textContent ?? 'null')
const rows = (): HTMLElement[] => screen.queryAllByTestId('item-row')
const rowTitles = (): Array<string | null> => rows().map((row) => row.getAttribute('aria-label'))
const toggleOf = (row: HTMLElement) => within(row).getByTestId('item-row-toggle')
const expandedStates = () => rows().map((row) => toggleOf(row).getAttribute('aria-expanded'))
const addInput = () => screen.getByRole('textbox', { name: 'Add to Featured posts' })
const optionNames = () => screen.queryAllByRole('option').map((option) => option.textContent)

type User = ReturnType<typeof userEvent.setup>

const chooseFromRowMenu = async (user: User, row: HTMLElement, item: RegExp | string) => {
  await user.click(within(row).getByRole('button', { name: /^Actions for / }))
  await user.click(await screen.findByRole('menuitem', { name: item }))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
}

describe('ReferenceListField', () => {
  it('shows one row per pick, in stored order, titled by its entry', () => {
    render(<Harness initial={['post-autumn', 'post-spring', 'post-winter']} />)
    expect(rowTitles()).toEqual(['Autumn preview', 'Spring launch', 'Winter notes'])
  })

  it('starts every row shut, an added one too, since a row title names its entry', async () => {
    const user = userEvent.setup()
    render(<Harness initial={['post-spring', 'post-summer']} />)
    expect(expandedStates()).toEqual(['false', 'false'])

    await user.click(addInput())
    await user.click(screen.getByRole('option', { name: 'Winter notes' }))
    expect(expandedStates()).toEqual(['false', 'false', 'false'])
  })

  it('reorders the value with Move up and Move down', async () => {
    const user = userEvent.setup()
    render(<Harness initial={['post-spring', 'post-summer', 'post-autumn']} />)

    await chooseFromRowMenu(user, rows()[2], /^Move up/)
    expect(stored()).toEqual(['post-spring', 'post-autumn', 'post-summer'])

    await chooseFromRowMenu(user, rows()[0], /^Move down/)
    expect(stored()).toEqual(['post-autumn', 'post-spring', 'post-summer'])
    expect(rowTitles()).toEqual(['Autumn preview', 'Spring launch', 'Summer recap'])
  })

  it('reorders the value by keyboard drag on the handle', async () => {
    // jsdom lays nothing out: each row gets a 40px slot down the page so dnd-kit can measure.
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const index = rows().indexOf(this)
        const top = index === -1 ? 0 : index * 48
        return {
          x: 0,
          y: top,
          top,
          left: 0,
          width: 400,
          height: index === -1 ? 0 : 40,
          bottom: top + (index === -1 ? 0 : 40),
          right: 400,
          toJSON: () => ({}),
        } as DOMRect
      })
    try {
      render(<Harness initial={['post-spring', 'post-summer', 'post-autumn']} />)
      const handle = within(rows()[0]).getByRole('button', { name: 'Drag to reorder' })
      handle.focus()
      fireEvent.keyDown(handle, { code: 'Space', key: ' ' })
      await act(async () => {})
      fireEvent.keyDown(document.activeElement ?? handle, { code: 'ArrowDown', key: 'ArrowDown' })
      await act(async () => {})
      fireEvent.keyDown(document.activeElement ?? handle, { code: 'Space', key: ' ' })
      await waitFor(() => expect(stored()).toEqual(['post-summer', 'post-spring', 'post-autumn']))
    } finally {
      rect.mockRestore()
    }
  })

  it("keeps a moved row open and its menu's focus, with the other rows as they were", async () => {
    const user = userEvent.setup()
    render(<Harness initial={['post-spring', 'post-summer', 'post-autumn', 'post-winter']} />)
    await user.click(toggleOf(rows()[0]))
    expect(expandedStates()).toEqual(['true', 'false', 'false', 'false'])

    await chooseFromRowMenu(user, rows()[0], /^Move down/)

    expect(rowTitles()).toEqual(['Summer recap', 'Spring launch', 'Autumn preview', 'Winter notes'])
    expect(expandedStates()).toEqual(['false', 'true', 'false', 'false'])
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Actions for Spring launch' }),
      ),
    )
  })

  it('keeps the other rows open or shut as they were through a Remove', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        initial={['post-spring', 'post-summer', 'post-autumn', 'post-winter', 'post-review']}
      />,
    )
    await user.click(toggleOf(rows()[1]))
    await user.click(toggleOf(rows()[3]))
    expect(expandedStates()).toEqual(['false', 'true', 'false', 'true', 'false'])

    await chooseFromRowMenu(user, rows()[0], 'Remove')

    expect(rowTitles()).toEqual([
      'Summer recap',
      'Autumn preview',
      'Winter notes',
      'Year in review',
    ])
    expect(expandedStates()).toEqual(['true', 'false', 'true', 'false'])
  })

  it('reports a Remove with the pick and its title, and offers no Duplicate', async () => {
    const user = userEvent.setup()
    const onRemoved = vi.fn()
    render(<Harness initial={['post-spring', 'post-summer']} onRemoved={onRemoved} />)

    await user.click(within(rows()[1]).getByRole('button', { name: /^Actions for / }))
    expect(screen.queryByRole('menuitem', { name: 'Duplicate' })).toBeNull()
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }))

    expect(stored()).toEqual(['post-spring'])
    expect(onRemoved).toHaveBeenCalledWith(1, 'post-summer', 'Summer recap')
  })

  it('appends a pick from Add, leaves out entries already picked, and keeps focus on Add', async () => {
    const user = userEvent.setup()
    render(<Harness initial={['post-spring', 'post-summer']} />)

    await user.click(addInput())
    expect(optionNames()).toEqual(['Autumn preview', 'Winter notes', 'Year in review'])
    await user.type(addInput(), 'Win')
    expect(optionNames()).toEqual(['Winter notes'])
    await user.click(screen.getByRole('option', { name: 'Winter notes' }))

    expect(stored()).toEqual(['post-spring', 'post-summer', 'post-winter'])
    expect(rowTitles()).toEqual(['Spring launch', 'Summer recap', 'Winter notes'])
    expect(document.activeElement).toBe(addInput())
    expect((addInput() as HTMLInputElement).value).toBe('')
    await waitFor(() =>
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
        'Winter notes added, position 3 of 3.',
      ),
    )

    // A second pick straight after, by keyboard alone: Enter takes the first match.
    await user.click(addInput())
    expect(optionNames()).toEqual(['Autumn preview', 'Year in review'])
    await user.type(addInput(), 'year{Enter}')
    expect(stored()).toEqual(['post-spring', 'post-summer', 'post-winter', 'post-review'])
    expect(document.activeElement).toBe(addInput())
  })

  it('replaces Add with a note on how to swap or remove at maxItems', () => {
    render(<Harness initial={['post-spring', 'post-summer', 'post-autumn']} maxItems={3} />)
    expect(screen.queryByRole('textbox', { name: 'Add to Featured posts' })).toBeNull()
    expect(screen.getByTestId('reference-list-cap').textContent).toBe(
      '3 of 3 picked. Open a row to swap its entry, or remove one to add another.',
    )
  })

  it('moves focus to the cap note when a pick reaches maxItems', async () => {
    const user = userEvent.setup()
    render(<Harness initial={['post-spring', 'post-summer']} maxItems={3} />)
    await user.click(addInput())
    await user.click(screen.getByRole('option', { name: 'Winter notes' }))

    const note = screen.getByTestId('reference-list-cap')
    expect(note.textContent).toBe(
      '3 of 3 picked. Open a row to swap its entry, or remove one to add another.',
    )
    await waitFor(() => expect(document.activeElement).toBe(note))
  })

  it('says how many to remove over maxItems', () => {
    render(
      <Harness
        initial={['post-spring', 'post-summer', 'post-autumn', 'post-winter']}
        maxItems={2}
      />,
    )
    expect(screen.getByTestId('reference-list-cap').textContent).toBe(
      '4 picked, but at most 2 are allowed. Remove 2 to save.',
    )
  })

  it('offers Add below maxItems', () => {
    render(<Harness initial={['post-spring', 'post-summer']} maxItems={3} />)
    expect(addInput()).toBeTruthy()
    expect(screen.queryByTestId('reference-list-cap')).toBeNull()
  })

  it('has no handle, row menu or Add when read-only, but its rows still collapse', async () => {
    const user = userEvent.setup()
    render(<Harness initial={['post-spring', 'post-summer']} readOnly />)
    expect(screen.queryByRole('button', { name: 'Drag to reorder' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Actions for / })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Add to Featured posts' })).toBeNull()
    expect(screen.queryByTestId('reference-list-cap')).toBeNull()

    await user.click(toggleOf(rows()[0]))
    expect(expandedStates()).toEqual(['true', 'false'])
  })

  it('repoints a row in place, offering only entries no other row holds', async () => {
    const user = userEvent.setup()
    render(<Harness initial={['post-spring', 'post-summer', 'post-autumn']} />)

    await user.click(toggleOf(rows()[1]))
    const select = within(rows()[1]).getByRole('textbox', { name: 'Entry' })
    await user.click(select)
    expect(optionNames()).toEqual(['Summer recap', 'Winter notes', 'Year in review'])
    await user.click(screen.getByRole('option', { name: 'Year in review' }))

    expect(stored()).toEqual(['post-spring', 'post-review', 'post-autumn'])
    expect(rowTitles()).toEqual(['Spring launch', 'Year in review', 'Autumn preview'])
  })

  it.each([
    ['its own title typed back', '{End}x{Backspace}{Enter}'],
    ['a cleared box', '{Control>}a{/Control}{Backspace}{Enter}'],
  ])('leaves a row pointing where it was on Enter after %s', async (_case, keys) => {
    const user = userEvent.setup()
    // Winter notes is not the first entry the row offers, so a wrong pick would show.
    render(<Harness initial={['post-winter', 'post-spring']} />)
    await user.click(toggleOf(rows()[0]))
    const select = within(rows()[0]).getByRole('textbox', { name: 'Entry' })
    await user.click(select)
    await user.keyboard(keys)
    expect(stored()).toEqual(['post-winter', 'post-spring'])
  })

  it('labels picks the options leave out: missing, restricted and unlisted', () => {
    render(
      <Harness
        initial={[
          { id: 'post-gone', unavailable: true, reason: 'missing' },
          {
            id: 'post-secret',
            unavailable: true,
            reason: 'restricted',
            title: 'Internal memo',
          },
          'post-elsewhere',
          'post-spring',
        ]}
      />,
    )
    expect(rowTitles()).toEqual([
      'Missing entry (post-gone)',
      'Restricted entry: Internal memo',
      'Unavailable entry (post-elsewhere)',
      'Spring launch',
    ])
  })

  it('stores ids once any pick changes, keeping resolved picks in place', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        initial={[{ id: 'post-gone', unavailable: true, reason: 'missing' }, 'post-spring']}
      />,
    )
    await chooseFromRowMenu(user, rows()[1], /^Move up/)
    expect(stored()).toEqual(['post-spring', 'post-gone'])
  })

  describe('a list holding one entry twice', () => {
    it('shows, reorders and removes the copies', async () => {
      const user = userEvent.setup()
      render(<Harness initial={['post-spring', 'post-summer', 'post-spring']} />)
      expect(rowTitles()).toEqual(['Spring launch', 'Summer recap', 'Spring launch'])

      await chooseFromRowMenu(user, rows()[1], /^Move up/)
      expect(stored()).toEqual(['post-summer', 'post-spring', 'post-spring'])

      await chooseFromRowMenu(user, rows()[2], 'Remove')
      expect(stored()).toEqual(['post-summer', 'post-spring'])
    })
  })

  describe('loading options', () => {
    const response = (options: Array<{ id: string; label: string }>): ReferenceOptionsResponse => ({
      ok: true,
      status: 200,
      data: { options: options.map((option) => ({ ...option, collection: 'posts' })) },
    })

    it('holds row titles and Add as placeholders until the options arrive, from one request', async () => {
      let settle: (value: ReferenceOptionsResponse) => void = () => {}
      mockClient.content.getReferenceOptions.mockImplementation(
        () => new Promise<ReferenceOptionsResponse>((resolve) => (settle = resolve)),
      )
      render(
        <Harness initial={['post-spring', 'post-summer', 'post-gone']} collections={['posts']} />,
      )

      expect(screen.getAllByTestId('item-row-title-pending')).toHaveLength(3)
      expect(screen.getByTestId('reference-list-add-pending')).toBeTruthy()
      // Held back while loading, so no row reads "Unavailable" before its title arrives.
      expect(screen.queryByText(/Unavailable entry/)).toBeNull()

      await act(async () =>
        settle(
          response([
            { id: 'post-spring', label: 'Spring launch' },
            { id: 'post-summer', label: 'Summer recap' },
          ]),
        ),
      )

      expect(screen.queryAllByTestId('item-row-title-pending')).toHaveLength(0)
      expect(rowTitles()).toEqual([
        'Spring launch',
        'Summer recap',
        'Unavailable entry (post-gone)',
      ])
      expect(mockClient.content.getReferenceOptions).toHaveBeenCalledTimes(1)
    })

    it('names a pick removed while loading by its id, not as unavailable', async () => {
      const user = userEvent.setup()
      mockClient.content.getReferenceOptions.mockImplementation(
        () => new Promise<ReferenceOptionsResponse>(() => {}),
      )
      const onRemoved = vi.fn()
      render(
        <Harness
          initial={['post-spring', 'post-summer']}
          collections={['posts']}
          onRemoved={onRemoved}
        />,
      )
      await chooseFromRowMenu(user, rows()[0], 'Remove')
      expect(onRemoved).toHaveBeenCalledWith(0, 'post-spring', 'post-spring')
    })

    it('says a failed load above the list and loads again on Retry', async () => {
      const user = userEvent.setup()
      mockClient.content.getReferenceOptions
        .mockResolvedValueOnce({ ok: false, status: 500, error: 'Server unavailable' })
        .mockResolvedValueOnce(response([{ id: 'post-spring', label: 'Spring launch' }]))
      render(<Harness initial={['post-spring']} collections={['posts']} />)

      const alert = await screen.findByTestId('reference-list-error')
      expect(within(alert).getByText('Server unavailable')).toBeTruthy()
      // The id stands in for the title, never "Unavailable entry".
      expect(rowTitles()).toEqual(['post-spring'])

      await user.click(within(alert).getByRole('button', { name: 'Retry' }))
      await waitFor(() => expect(rowTitles()).toEqual(['Spring launch']))
      expect(screen.queryByTestId('reference-list-error')).toBeNull()
    })
  })
})

describe('a list reference in a form', () => {
  const featured: FieldConfig = {
    name: 'featured',
    type: 'reference',
    label: 'Featured posts',
    list: true,
    options: POSTS,
  }

  /** A form holding its own value, reporting removals so a test can put them back. */
  const FormHarness: React.FC<{
    fields: FieldConfig[]
    initial: FormValue
    onRemoved?: (removal: FieldRemoval) => void
    /** Told the form's value and its setter after each render. */
    onState?: (value: FormValue, setValue: (next: FormValue) => void) => void
  }> = ({ fields, initial, onRemoved, onState }) => {
    const [value, setValue] = useState(initial)
    useEffect(() => {
      onState?.(value, setValue)
    }, [onState, value])
    return (
      <CanopyCMSProvider>
        <FormRenderer fields={fields} value={value} onChange={setValue} onRemoved={onRemoved} />
      </CanopyCMSProvider>
    )
  }

  it('draws a list reference as rows and a single one as a picker', () => {
    render(
      <FormHarness
        fields={[featured, { name: 'lead', type: 'reference', label: 'Lead post', options: POSTS }]}
        initial={{ featured: ['post-spring', 'post-summer'], lead: 'post-autumn' }}
      />,
    )
    expect(screen.getByTestId('reference-list-featured')).toBeTruthy()
    expect(rowTitles()).toEqual(['Spring launch', 'Summer recap'])
    expect(screen.getByTestId('reference-field-lead')).toBeTruthy()
    expect(screen.queryByTestId('reference-list-lead')).toBeNull()
  })

  it.each([
    ['at the top level', [featured], (items: string[]) => ({ featured: items }), 'featured[1]'],
    [
      'inside an object',
      [
        { name: 'teaser', type: 'object', fields: [{ ...featured, name: 'items' }] },
      ] as FieldConfig[],
      (items: string[]) => ({ teaser: { items } }),
      'teaser.items[1]',
    ],
  ])('opens row 1 when %s its path is revealed', async (_where, fields, valueOf, path) => {
    render(
      <FormHarness
        fields={fields}
        initial={valueOf(['post-spring', 'post-summer', 'post-autumn', 'post-winter'])}
      />,
    )
    expect(expandedStates()).toEqual(['false', 'false', 'false', 'false'])

    const target = findFieldTarget(path)
    expect(target?.path).toBe(path)
    act(() => {
      revealField(target!.element)
    })
    await waitFor(() => expect(expandedStates()).toEqual(['false', 'true', 'false', 'false']))
  })

  it('reports a Remove that Undo puts back at its place', async () => {
    const user = userEvent.setup()
    const onRemoved = vi.fn()
    let state: [FormValue, (next: FormValue) => void] | undefined
    render(
      <FormHarness
        fields={[featured]}
        initial={{ featured: ['post-spring', 'post-summer', 'post-autumn'] }}
        onRemoved={onRemoved}
        onState={(value, setValue) => (state = [value, setValue])}
      />,
    )
    await chooseFromRowMenu(user, rows()[1], 'Remove')

    const removal: FieldRemoval = onRemoved.mock.calls[0][0]
    expect(removal).toEqual({
      kind: 'list-item',
      listPath: ['featured'],
      index: 1,
      item: 'post-summer',
      label: '"Summer recap" from Featured posts',
    })
    const [now, setValue] = state!
    const restored = restoreRemoval([featured], now, removal)
    expect(restored).toEqual({ featured: ['post-spring', 'post-summer', 'post-autumn'] })
    act(() => setValue(restored!))
    expect(rowTitles()).toEqual(['Spring launch', 'Summer recap', 'Autumn preview'])
  })

  it('refuses to Undo a Remove whose entry the list holds again', async () => {
    const user = userEvent.setup()
    const onRemoved = vi.fn()
    let state: [FormValue, (next: FormValue) => void] | undefined
    render(
      <FormHarness
        fields={[featured]}
        initial={{ featured: ['post-spring', 'post-summer', 'post-spring'] }}
        onRemoved={onRemoved}
        onState={(value, setValue) => (state = [value, setValue])}
      />,
    )
    await chooseFromRowMenu(user, rows()[2], 'Remove')

    const [now] = state!
    expect(now).toEqual({ featured: ['post-spring', 'post-summer'] })
    expect(restoreRemoval([featured], now, onRemoved.mock.calls[0][0])).toBeUndefined()
  })
})
