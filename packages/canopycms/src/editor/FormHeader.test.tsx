import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import React, { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FieldConfig } from '../config'
import type { FormValue } from './FormRenderer'
import { FormRenderer } from './FormRenderer'
import { FormHeader, type OutlineNode } from './FormHeader'
import { PreviewPane } from './PreviewPane'
import { PANE_HEADER_HEIGHT } from './pane-header'
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
  it('shows the type badge, and names the entry to assistive tech only', () => {
    render(
      <CanopyCMSProvider>
        <FormHeader title="About us" typeLabel="Page" outline={[]} onSelect={vi.fn()} />
      </CanopyCMSProvider>,
    )
    const header = screen.getByTestId('form-header')
    const title = within(header).getByText('About us')
    expect(title).toBe(screen.getByTestId('form-header-title'))
    expect(title.className).toContain('mantine-VisuallyHidden-root')
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

  it('is as tall as the preview toolbar beside it', () => {
    render(
      <CanopyCMSProvider>
        <PreviewPane src="/about" data={{}} previewWidth="fit" onPreviewWidthChange={vi.fn()} />
        <FormHeader title="About us" outline={[]} onSelect={vi.fn()} />
      </CanopyCMSProvider>,
    )
    expect(screen.getByTestId('form-header').style.minHeight).toBe(`${PANE_HEADER_HEIGHT}px`)
    // The preview pane's 1px top border sits above its toolbar.
    expect(screen.getByTestId('preview-toolbar').style.minHeight).toBe(
      `${PANE_HEADER_HEIGHT - 1}px`,
    )
  })

  describe('outline tree', () => {
    const outline: OutlineNode[] = [
      { label: 'Title', path: 'title' },
      { label: 'Extras', children: [{ label: 'Summary', path: 'summary' }] },
      {
        label: 'People',
        path: 'people',
        children: [
          { label: 'Ada', secondary: 'Engineer', path: 'people[0]' },
          { label: 'Brian', path: 'people[1]' },
        ],
      },
    ]

    const renderHeader = async (onSelect = vi.fn()) => {
      const user = userEvent.setup()
      render(
        <CanopyCMSProvider>
          <FormHeader title="T" outline={outline} onSelect={onSelect} />
        </CanopyCMSProvider>,
      )
      const nav = await openOutline(user)
      return { nav, user, onSelect }
    }

    it('is a list inside the nav, with a nested list under each group and field that has children', async () => {
      const { nav } = await renderHeader()
      const top = nav.querySelector(':scope > ul')
      expect(top).not.toBeNull()
      const items = [...top!.children].filter((el) => el.tagName === 'LI')
      expect(items).toHaveLength(3)
      expect(
        items.map((li) => [...li.children].filter((el) => el.tagName === 'UL').length),
      ).toEqual([0, 1, 1])
      expect(within(items[2] as HTMLElement).getAllByRole('listitem')).toHaveLength(2)
    })

    it('lists every field and row as a button, in tree order', async () => {
      const { nav } = await renderHeader()
      expect(
        within(nav)
          .getAllByTestId('form-outline-item')
          .map((item) => item.textContent),
      ).toEqual(['Title', 'Summary', 'People', 'Ada Engineer', 'Brian'])
      expect(
        within(nav)
          .getAllByTestId('form-outline-item')
          .every((item) => item.tagName === 'BUTTON'),
      ).toBe(true)
    })

    it('shows a group as plain text that holds its fields', async () => {
      const { nav } = await renderHeader()
      const heading = within(nav).getByText('Extras')
      expect(heading.closest('button')).toBeNull()
      expect(within(nav).queryByRole('button', { name: 'Extras' })).toBeNull()
      const group = heading.closest('li')!
      expect(within(group).getByRole('button', { name: 'Summary' })).toBeTruthy()
    })

    it('names a top-level field button by its content, with no aria-label', async () => {
      const { nav } = await renderHeader()
      for (const name of ['Title', 'Summary', 'People']) {
        const button = within(nav).getByRole('button', { name })
        expect(button.hasAttribute('aria-label')).toBe(false)
      }
    })

    it('names a row by its field label, an arrow, the row label, and its secondary value', async () => {
      const { nav } = await renderHeader()
      const ada = within(nav).getByRole('button', { name: 'People › Ada, Engineer' })
      expect(ada.getAttribute('aria-label')).toBe('People › Ada, Engineer')
      expect(ada.textContent).toBe('Ada Engineer')
      expect(
        within(nav).getByRole('button', { name: 'People › Brian' }).getAttribute('aria-label'),
      ).toBe('People › Brian')
    })

    it('prefixes the rows of a field inside a group with that field, not the group', async () => {
      const user = userEvent.setup()
      render(
        <CanopyCMSProvider>
          <FormHeader
            title="T"
            outline={[
              {
                label: 'Page',
                children: [
                  {
                    label: 'Team',
                    path: 'team',
                    children: [{ label: 'Ada', path: 'team[0]' }],
                  },
                ],
              },
            ]}
            onSelect={vi.fn()}
          />
        </CanopyCMSProvider>,
      )
      const nav = await openOutline(user)
      expect(within(nav).getByRole('button', { name: 'Team › Ada' })).toBeTruthy()
      expect(within(nav).queryByRole('button', { name: /Page ›/ })).toBeNull()
    })

    it('selects the path of a chosen field or row', async () => {
      const { nav, user, onSelect } = await renderHeader()
      await user.click(within(nav).getByRole('button', { name: 'People › Brian' }))
      expect(onSelect).toHaveBeenCalledExactlyOnceWith('people[1]')
    })

    it('selects the path of a chosen field inside a group', async () => {
      const { nav, user, onSelect } = await renderHeader()
      await user.click(within(nav).getByRole('button', { name: 'Summary' }))
      expect(onSelect).toHaveBeenCalledExactlyOnceWith('summary')
    })

    it('shows a field with an empty children list without a nested list', async () => {
      const user = userEvent.setup()
      render(
        <CanopyCMSProvider>
          <FormHeader
            title="T"
            outline={[{ label: 'People', path: 'people', children: [] }]}
            onSelect={vi.fn()}
          />
        </CanopyCMSProvider>,
      )
      const nav = await openOutline(user)
      expect(nav.querySelectorAll('ul')).toHaveLength(1)
    })
  })

  it('closes the outline once an item is chosen', async () => {
    const user = userEvent.setup()
    render(
      <CanopyCMSProvider>
        <FormHeader title="T" outline={[{ label: 'Title', path: 'title' }]} onSelect={vi.fn()} />
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
        <FormHeader title="T" outline={[{ label: 'Title', path: 'title' }]} onSelect={vi.fn()} />
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

  describe('in a narrow pane', () => {
    const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')

    /** jsdom lays nothing out, so the header's width is whatever the test says. */
    const fakeHeaderWidth = (width: number) => {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get(this: HTMLElement) {
          return this.dataset.testid === 'form-header' ? width : 0
        },
      })
    }

    afterEach(() => {
      if (originalWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalWidth)
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
      vi.unstubAllGlobals()
    })

    const renderHeader = () =>
      render(
        <CanopyCMSProvider>
          <FormHeader title="T" outline={[{ label: 'Title', path: 'title' }]} onSelect={vi.fn()} />
        </CanopyCMSProvider>,
      )

    it('shows "Outline" as an icon named Outline, with a tooltip that opens on focus', async () => {
      fakeHeaderWidth(200)
      renderHeader()
      const button = screen.getByRole('button', { name: 'Outline' })
      expect(button.querySelector('.mantine-VisuallyHidden-root')?.textContent).toBe('Outline')
      act(() => button.focus())
      await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe('Outline'))
    })

    it('keeps the same focused button as the pane widens past the threshold', () => {
      let resize = () => {}
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(callback: () => void) {
            resize = callback
          }
          observe() {}
          disconnect() {}
        },
      )
      fakeHeaderWidth(200)
      renderHeader()
      const button = screen.getByRole('button', { name: 'Outline' })
      act(() => button.focus())
      fakeHeaderWidth(400)
      act(() => resize())
      expect(screen.getByRole('button', { name: 'Outline' })).toBe(button)
      expect(button.querySelector('.mantine-VisuallyHidden-root')).toBeNull()
      expect(document.activeElement).toBe(button)
    })

    it('drops the tooltip and its description when the pane widens while it is open', async () => {
      let resize = () => {}
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(callback: () => void) {
            resize = callback
          }
          observe() {}
          disconnect() {}
        },
      )
      fakeHeaderWidth(200)
      renderHeader()
      const button = screen.getByRole('button', { name: 'Outline' })
      act(() => button.focus())
      await waitFor(() => expect(button.getAttribute('aria-describedby')).toBeTruthy())

      fakeHeaderWidth(400)
      act(() => resize())

      await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
      expect(button.hasAttribute('aria-describedby')).toBe(false)
      expect(document.activeElement).toBe(button)
    })

    it('still opens the outline from the icon', async () => {
      fakeHeaderWidth(200)
      const user = userEvent.setup()
      renderHeader()
      await openOutline(user)
    })

    it('keeps the label in a wider pane', () => {
      fakeHeaderWidth(400)
      renderHeader()
      expect(screen.getByRole('button', { name: 'Outline' }).textContent).toBe('Outline')
    })
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

    await user.click(within(nav).getByRole('button', { name: /^People › Fay/ }))

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

describe('FormHeader scroll padding', () => {
  const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  let headerHeight = 40

  /** jsdom lays nothing out, so the header's height is whatever the test says. */
  const fakeHeaderHeight = () => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.testid === 'form-header' ? headerHeight : 0
      },
    })
  }

  afterEach(() => {
    if (originalHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalHeight)
    else delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight
    vi.unstubAllGlobals()
    headerHeight = 40
  })

  const header = (
    <CanopyCMSProvider>
      <FormHeader title="T" outline={[]} onSelect={vi.fn()} />
    </CanopyCMSProvider>
  )

  const scrollerStyle = (el: HTMLElement): string | undefined => el.style.scrollPaddingTop

  it('pads the scroll edge of its vertical scroller by the header height and a gap', () => {
    fakeHeaderHeight()
    const { getByTestId } = render(
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        {header}
      </div>,
    )
    expect(scrollerStyle(getByTestId('scroller'))).toBe('48px')
  })

  it('treats overflow-y: scroll as a scroller too', () => {
    fakeHeaderHeight()
    const { getByTestId } = render(
      <div data-testid="scroller" style={{ overflowY: 'scroll' }}>
        {header}
      </div>,
    )
    expect(scrollerStyle(getByTestId('scroller'))).toBe('48px')
  })

  it('pads the nearest scroller, past ancestors that do not scroll, and leaves outer ones alone', () => {
    fakeHeaderHeight()
    const { getByTestId } = render(
      <div data-testid="outer" style={{ overflowY: 'auto' }}>
        <div data-testid="inner" style={{ overflowY: 'auto' }}>
          <div style={{ overflowY: 'visible' }}>
            <div style={{ overflowY: 'hidden' }}>{header}</div>
          </div>
        </div>
      </div>,
    )
    expect(scrollerStyle(getByTestId('inner'))).toBe('48px')
    expect(scrollerStyle(getByTestId('outer')) ?? '').toBe('')
  })

  it("restores the scroller's previous padding on unmount", () => {
    fakeHeaderHeight()
    const { getByTestId, rerender } = render(
      <div data-testid="scroller" style={{ overflowY: 'auto', scrollPaddingTop: '12px' }}>
        {header}
      </div>,
    )
    const scroller = getByTestId('scroller')
    expect(scrollerStyle(scroller)).toBe('48px')

    rerender(<div data-testid="scroller" style={{ overflowY: 'auto', scrollPaddingTop: '12px' }} />)
    expect(scrollerStyle(scroller)).toBe('12px')
  })

  it('leaves no padding behind when the scroller had none', () => {
    fakeHeaderHeight()
    const { getByTestId, rerender } = render(
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        {header}
      </div>,
    )
    const scroller = getByTestId('scroller')
    rerender(<div data-testid="scroller" style={{ overflowY: 'auto' }} />)
    expect(scrollerStyle(scroller) ?? '').toBe('')
  })

  it("follows the header's height through the ResizeObserver, and stops listening on unmount", () => {
    fakeHeaderHeight()
    const callbacks: Array<() => void> = []
    const observed: Element[] = []
    const disconnect = vi.fn()
    class FakeResizeObserver {
      constructor(callback: () => void) {
        callbacks.push(callback)
      }
      observe(element: Element) {
        observed.push(element)
      }
      unobserve() {}
      disconnect = disconnect
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)

    const { getByTestId, rerender } = render(
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        {header}
      </div>,
    )
    expect(observed).toEqual([getByTestId('form-header')])
    expect(scrollerStyle(getByTestId('scroller'))).toBe('48px')

    headerHeight = 72
    callbacks.forEach((callback) => callback())
    expect(scrollerStyle(getByTestId('scroller'))).toBe('80px')

    rerender(<div data-testid="scroller" style={{ overflowY: 'auto' }} />)
    expect(disconnect).toHaveBeenCalled()
  })

  it('still pads, once, where there is no ResizeObserver', () => {
    fakeHeaderHeight()
    vi.stubGlobal('ResizeObserver', undefined)
    const { getByTestId } = render(
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        {header}
      </div>,
    )
    expect(scrollerStyle(getByTestId('scroller'))).toBe('48px')
  })

  it('does nothing, and does not fail, when no ancestor scrolls', () => {
    fakeHeaderHeight()
    const { getByTestId } = render(<div data-testid="plain">{header}</div>)
    expect(scrollerStyle(getByTestId('plain')) ?? '').toBe('')
  })

  it('pads the scroller of a form rendered by FormRenderer with a header', () => {
    fakeHeaderHeight()
    headerHeight = 30
    const { getByTestId } = render(
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        <StatefulForm fields={[titleField]} initialValue={{}} header={{ title: 'T' }} />
      </div>,
    )
    expect(scrollerStyle(getByTestId('scroller'))).toBe('38px')
  })
})

describe('FormHeader icon buttons', () => {
  it('name themselves in a tooltip on keyboard focus, not only on hover', async () => {
    render(
      <CanopyCMSProvider>
        <FormHeader title="T" outline={[]} onSelect={vi.fn()} onExpandAll={vi.fn()} />
      </CanopyCMSProvider>,
    )
    const user = userEvent.setup()
    // Tab, as a keyboard user would: a tooltip opens for keyboard focus, not for a click's.
    await user.tab()
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Expand all lists' }))
    expect((await screen.findByRole('tooltip')).textContent).toBe('Expand all lists')
  })

  it('name themselves in a tooltip on touch', async () => {
    render(
      <CanopyCMSProvider>
        <FormHeader title="T" outline={[]} onSelect={vi.fn()} onExpandAll={vi.fn()} />
      </CanopyCMSProvider>,
    )
    const button = screen.getByRole('button', { name: 'Collapse all lists' })
    // A touch is a pointerdown of type touch, then the compatibility mouseenter. Hover alone
    // ignores that; the touch event setting is what lets it open.
    const down = new Event('pointerdown', { bubbles: true })
    Object.defineProperty(down, 'pointerType', { value: 'touch' })
    fireEvent(button, down)
    fireEvent.mouseEnter(button)
    expect((await screen.findByRole('tooltip')).textContent).toBe('Collapse all lists')
  })

  it("are drawn in gray's light colour, which the theme makes readable on the header", () => {
    render(
      <CanopyCMSProvider>
        <FormHeader title="T" outline={[]} onSelect={vi.fn()} onExpandAll={vi.fn()} />
      </CanopyCMSProvider>,
    )
    for (const name of ['Expand all lists', 'Collapse all lists']) {
      const button = screen.getByRole('button', { name })
      expect(button.style.color).toBe('')
      expect(button.style.getPropertyValue('--ai-color')).toBe(
        'var(--mantine-color-gray-light-color)',
      )
    }
  })
})

describe('FormHeader badge', () => {
  it('gives way before the controls in a narrow pane: it may shrink below its content', () => {
    render(
      <CanopyCMSProvider>
        <FormHeader title="T" typeLabel="Landing page" outline={[]} onSelect={vi.fn()} />
      </CanopyCMSProvider>,
    )
    const badge = document.querySelector<HTMLElement>('.mantine-Badge-root')!
    expect(badge.style.minWidth).toMatch(/^0(px)?$/)
  })
})

describe('FormRenderer notice and custom renderers', () => {
  it('renders the notice right under the header, before the fields', () => {
    render(
      <CanopyCMSProvider>
        <FormRenderer
          fields={[titleField]}
          value={{}}
          onChange={() => {}}
          header={{ title: 'Team page' }}
          notice={<p data-testid="notice">Read only</p>}
        />
      </CanopyCMSProvider>,
    )
    const header = screen.getByTestId('form-header')
    const notice = screen.getByTestId('notice')
    const field = screen.getByLabelText('Title')
    expect(header.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(notice.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Nothing sits between the header and the notice but them.
    expect(header.nextElementSibling).toBe(notice)
  })

  it('renders the notice before the conflict alert, the read-only styles and the fields', () => {
    render(
      <CanopyCMSProvider>
        <FormRenderer
          fields={[titleField]}
          value={{}}
          onChange={() => {}}
          header={{ title: 'Team page' }}
          notice={<p data-testid="notice">Read only</p>}
          conflictNotice
          readOnly
        />
      </CanopyCMSProvider>,
    )
    const notice = screen.getByTestId('notice')
    const alert = screen.getByTestId('conflict-alert')
    expect(notice.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('form-header').nextElementSibling).toBe(notice)
  })

  it('renders the notice first when there is no header', () => {
    const { container } = render(
      <CanopyCMSProvider>
        <FormRenderer
          fields={[titleField]}
          value={{}}
          onChange={() => {}}
          notice={<p data-testid="notice">Read only</p>}
        />
      </CanopyCMSProvider>,
    )
    expect(screen.queryByTestId('form-header')).toBeNull()
    expect(container.querySelector('[data-form-renderer]')!.firstElementChild).toBe(
      screen.getByTestId('notice'),
    )
  })

  it('renders nothing for no notice', () => {
    renderForm()
    expect(screen.getByTestId('form-header').nextElementSibling?.hasAttribute('data-testid')).toBe(
      false,
    )
  })

  describe('a custom renderer for block', () => {
    const customBlock = {
      block: () => <div data-testid="custom-block">my blocks</div>,
    }
    const note = (text: string) => ({ template: 'note', value: { text } })
    const blockValue: FormValue = { title: 'x', sections: ['a', 'b', 'c', 'd', 'e'].map(note) }

    const renderCustom = (fields: FieldConfig[], value: FormValue) =>
      render(
        <CanopyCMSProvider>
          <FormRenderer
            fields={fields}
            value={value}
            onChange={() => {}}
            header={{ title: 'T' }}
            customRenderers={customBlock}
          />
        </CanopyCMSProvider>,
      )

    it('offers no Expand all or Collapse all when the block field is the only list', () => {
      renderCustom([titleField, sectionsField], blockValue)
      expect(screen.getByTestId('custom-block')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Expand all lists' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Collapse all lists' })).toBeNull()
    })

    it('still offers them when another, built-in, list is in the form', () => {
      renderCustom([sectionsField, peopleField], { ...blockValue, people: peopleValue.people })
      expect(screen.getByRole('button', { name: 'Expand all lists' })).toBeTruthy()
    })

    it('outlines the custom block field without rows, and the built-in list with them', async () => {
      const user = userEvent.setup()
      renderCustom([sectionsField, peopleField], { ...blockValue, people: peopleValue.people })
      const nav = await openOutline(user)
      const labels = within(nav)
        .getAllByTestId('form-outline-item')
        .map((item) => item.textContent)
      expect(labels[0]).toBe('Sections')
      expect(labels).toContain('Ada Ada role')
      expect(labels).not.toContain('Note a')
      expect(labels.some((label) => label?.startsWith('Note'))).toBe(false)
      expect(within(nav).queryByRole('button', { name: /^Sections ›/ })).toBeNull()
    })

    it('outlines the rows of a built-in block field as usual', async () => {
      const user = userEvent.setup()
      render(
        <CanopyCMSProvider>
          <FormRenderer
            fields={[sectionsField]}
            value={blockValue}
            onChange={() => {}}
            header={{ title: 'T' }}
          />
        </CanopyCMSProvider>,
      )
      const nav = await openOutline(user)
      expect(within(nav).getAllByRole('button', { name: /^Sections › Note/ })).toHaveLength(5)
    })
  })
})
