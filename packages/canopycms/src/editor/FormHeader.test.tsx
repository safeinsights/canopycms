import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import React, { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FieldConfig } from '../config'
import type { FormValue } from './FormRenderer'
import { FormRenderer } from './FormRenderer'
import { FormHeader, type OutlineItem } from './FormHeader'
import { CanopyCMSProvider } from './theme'

afterEach(() => cleanup())

const PEOPLE = ['Ada', 'Brian', 'Chen', 'Dora', 'Eli', 'Fay']

const peopleField: FieldConfig = {
  name: 'people',
  type: 'object',
  label: 'People',
  list: true,
  itemTitleField: 'name',
  fields: [
    { name: 'name', type: 'string', label: 'Name' },
    { name: 'role', type: 'string', label: 'Role' },
  ],
}

const sectionsField: FieldConfig = {
  name: 'sections',
  type: 'block',
  label: 'Sections',
  templates: [
    { name: 'note', label: 'Note', fields: [{ name: 'text', type: 'string', label: 'Text' }] },
  ],
}

const titleField: FieldConfig = { name: 'title', type: 'string', label: 'Title' }

const withPeople: FieldConfig[] = [
  titleField,
  {
    type: 'group',
    name: 'extras',
    label: 'Extras',
    fields: [{ name: 'summary', type: 'string', label: 'Summary' }],
  },
  peopleField,
]

const peopleValue: FormValue = {
  title: 'Team page',
  summary: 'About us',
  // Six rows: a list of four or more starts with only its first row open.
  people: PEOPLE.map((name) => ({ name, role: `${name} role` })),
}

const StatefulForm: React.FC<{
  fields: FieldConfig[]
  initialValue: FormValue
  header?: React.ComponentProps<typeof FormRenderer>['header']
}> = ({ fields, initialValue, header }) => {
  const [value, setValue] = useState<FormValue>(initialValue)
  return (
    <CanopyCMSProvider>
      <FormRenderer fields={fields} value={value} onChange={setValue} header={header} />
    </CanopyCMSProvider>
  )
}

const renderForm = (
  fields: FieldConfig[] = withPeople,
  value: FormValue = peopleValue,
  header: React.ComponentProps<typeof FormRenderer>['header'] = {
    title: 'Team page',
    typeLabel: 'Page',
  },
) => render(<StatefulForm fields={fields} initialValue={value} header={header} />)

const rows = (): HTMLElement[] => screen.queryAllByTestId('item-row')
const openRows = (): HTMLElement[] => rows().filter((row) => row.hasAttribute('data-expanded'))

const openOutline = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Outline' }))
  return screen.findByRole('navigation', { name: 'Outline' })
}

const input = (path: string): HTMLInputElement => {
  const el = document.querySelector<HTMLInputElement>(`input[data-canopy-field="${path}"]`)
  if (!el) throw new Error(`no input for ${path}`)
  return el
}

describe('FormHeader', () => {
  it('shows the title and the type badge', () => {
    render(
      <CanopyCMSProvider>
        <FormHeader title="About us" typeLabel="Page" outline={[]} onSelect={vi.fn()} />
      </CanopyCMSProvider>,
    )
    const header = screen.getByTestId('form-header')
    expect(within(header).getByText('About us')).toBeTruthy()
    expect(header.querySelector('.mantine-Badge-root')?.textContent).toBe('Page')
  })

  it('shows no badge without a type label', () => {
    render(
      <CanopyCMSProvider>
        <FormHeader title="About us" outline={[]} onSelect={vi.fn()} />
      </CanopyCMSProvider>,
    )
    const header = screen.getByTestId('form-header')
    expect(within(header).getByText('About us')).toBeTruthy()
    expect(header.querySelector('.mantine-Badge-root')).toBeNull()
  })

  it('lists outline items as buttons in a nav, with a group heading as plain text', async () => {
    const outline: OutlineItem[] = [
      { label: 'Title', path: 'title', depth: 0 },
      { label: 'Extras', depth: 0 },
      { label: 'People', path: 'people', depth: 0 },
      { label: 'Ada', secondary: 'Engineer', path: 'people[0]', depth: 1 },
    ]
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(
      <CanopyCMSProvider>
        <FormHeader title="T" outline={outline} onSelect={onSelect} />
      </CanopyCMSProvider>,
    )
    const nav = await openOutline(user)

    const items = within(nav).getAllByTestId('form-outline-item')
    expect(items.map((item) => item.textContent)).toEqual(['Title', 'People', 'Ada Engineer'])
    expect(items.every((item) => item.tagName === 'BUTTON')).toBe(true)
    // The heading is text in the nav, not a button, so it can't be chosen.
    expect(within(nav).getByText('Extras')).toBeTruthy()
    expect(within(nav).queryByRole('button', { name: 'Extras' })).toBeNull()

    await user.click(items[2])
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('people[0]')
  })

  it('closes the outline once an item is chosen', async () => {
    const user = userEvent.setup()
    render(
      <CanopyCMSProvider>
        <FormHeader
          title="T"
          outline={[{ label: 'Title', path: 'title', depth: 0 }]}
          onSelect={vi.fn()}
        />
      </CanopyCMSProvider>,
    )
    const nav = await openOutline(user)
    await user.click(within(nav).getByTestId('form-outline-item'))
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Outline' })).toBeNull())
  })

  it('has no Expand all or Collapse all without an onExpandAll', () => {
    render(
      <CanopyCMSProvider>
        <FormHeader title="T" outline={[]} onSelect={vi.fn()} />
      </CanopyCMSProvider>,
    )
    expect(screen.queryByRole('button', { name: 'Expand all lists' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Collapse all lists' })).toBeNull()
  })

  it('calls onExpandAll(true) from Expand all lists and onExpandAll(false) from Collapse all lists', () => {
    const onExpandAll = vi.fn()
    render(
      <CanopyCMSProvider>
        <FormHeader title="T" outline={[]} onSelect={vi.fn()} onExpandAll={onExpandAll} />
      </CanopyCMSProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Expand all lists' }))
    expect(onExpandAll).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all lists' }))
    expect(onExpandAll).toHaveBeenLastCalledWith(false)
  })

  it('hands focus back to the Outline button on Escape', async () => {
    const user = userEvent.setup()
    render(
      <CanopyCMSProvider>
        <FormHeader
          title="T"
          outline={[{ label: 'Title', path: 'title', depth: 0 }]}
          onSelect={vi.fn()}
        />
      </CanopyCMSProvider>,
    )
    const button = screen.getByRole('button', { name: 'Outline' })
    const nav = await openOutline(user)
    // The trap moves focus into the list.
    await waitFor(() => expect(nav.contains(document.activeElement)).toBe(true))

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Outline' })).toBeNull())
    expect(document.activeElement).toBe(button)
  })
})

describe('FormRenderer header', () => {
  it('renders no header without the header prop', () => {
    render(<StatefulForm fields={withPeople} initialValue={peopleValue} />)
    expect(screen.queryByTestId('form-header')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Outline' })).toBeNull()
  })

  it('names the entry and its type', () => {
    renderForm()
    const header = screen.getByTestId('form-header')
    expect(within(header).getByText('Team page')).toBeTruthy()
    expect(within(header).getByText('Page')).toBeTruthy()
  })

  it('outlines the form: fields, group headings and the rows of a list, from the current value', async () => {
    const user = userEvent.setup()
    renderForm()
    const nav = await openOutline(user)
    expect(
      within(nav)
        .getAllByTestId('form-outline-item')
        .map((i) => i.textContent),
    ).toEqual(['Title', 'Summary', 'People', ...PEOPLE.map((name) => `${name} ${name} role`)])
    expect(within(nav).getByText('Extras')).toBeTruthy()
  })

  it('moves focus to the input of a field chosen in the outline', async () => {
    const user = userEvent.setup()
    renderForm()
    const nav = await openOutline(user)

    await user.click(within(nav).getByRole('button', { name: 'Summary' }))

    await waitFor(() => expect(document.activeElement).toBe(input('summary')))
    // Closing the outline does not take the focus back to its button.
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Outline' })).toBeNull())
    expect(document.activeElement).toBe(input('summary'))
  })

  it('opens a collapsed row chosen in the outline and focuses its first input', async () => {
    const user = userEvent.setup()
    renderForm()
    // A list of six starts with only its first row open.
    expect(openRows()).toHaveLength(1)
    expect(rows()[5].hasAttribute('data-expanded')).toBe(false)
    const nav = await openOutline(user)

    await user.click(within(nav).getByRole('button', { name: /^Fay/ }))

    await waitFor(() => expect(rows()[5].hasAttribute('data-expanded')).toBe(true))
    await waitFor(() => expect(document.activeElement).toBe(input('people[5].name')))
    // Only the chosen row opened.
    expect(openRows()).toHaveLength(2)
  })

  describe('Expand all lists and Collapse all lists', () => {
    it('are absent when the schema has no list or block field', () => {
      renderForm([titleField, { name: 'tags', type: 'string', label: 'Tags', list: true }], {
        title: 'x',
        tags: ['a'],
      })
      expect(screen.getByRole('button', { name: 'Outline' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Expand all lists' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Collapse all lists' })).toBeNull()
    })

    it('are present when the schema has a list of objects, and open and shut every row', () => {
      renderForm()
      expect(openRows()).toHaveLength(1)

      fireEvent.click(screen.getByRole('button', { name: 'Expand all lists' }))
      expect(openRows()).toHaveLength(PEOPLE.length)

      fireEvent.click(screen.getByRole('button', { name: 'Collapse all lists' }))
      expect(openRows()).toHaveLength(0)
    })

    it('are present for a block field, and act on its rows', () => {
      const note = (text: string) => ({ template: 'note', value: { text } })
      renderForm([titleField, sectionsField], {
        title: 'x',
        sections: ['a', 'b', 'c', 'd', 'e'].map(note),
      })
      expect(openRows()).toHaveLength(1)

      fireEvent.click(screen.getByRole('button', { name: 'Expand all lists' }))
      expect(openRows()).toHaveLength(5)
      fireEvent.click(screen.getByRole('button', { name: 'Collapse all lists' }))
      expect(openRows()).toHaveLength(0)
    })

    it('reach every list in the form at once', () => {
      renderForm([peopleField, { ...peopleField, name: 'alumni', label: 'Alumni' }], {
        people: peopleValue.people,
        alumni: PEOPLE.map((name) => ({ name: `Old ${name}`, role: '' })),
      })
      expect(openRows()).toHaveLength(2)
      fireEvent.click(screen.getByRole('button', { name: 'Expand all lists' }))
      expect(openRows()).toHaveLength(PEOPLE.length * 2)
      fireEvent.click(screen.getByRole('button', { name: 'Collapse all lists' }))
      expect(openRows()).toHaveLength(0)
    })

    it('act again when pressed a second time after a row was toggled by hand', () => {
      renderForm()
      fireEvent.click(screen.getByRole('button', { name: 'Expand all lists' }))
      fireEvent.click(within(rows()[2]).getByTestId('item-row-toggle'))
      expect(openRows()).toHaveLength(PEOPLE.length - 1)

      fireEvent.click(screen.getByRole('button', { name: 'Expand all lists' }))
      expect(openRows()).toHaveLength(PEOPLE.length)
    })
  })
})
