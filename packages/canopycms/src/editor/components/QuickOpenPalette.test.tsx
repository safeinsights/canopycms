import type React from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { QUICK_OPEN_REPLACES_ATTR, QuickOpenPalette, type QuickOpenEntry } from './QuickOpenPalette'

beforeAll(() => {
  // Combobox scrolls the armed option into view.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const ENTRIES: QuickOpenEntry[] = [
  {
    path: 'content/guides/start',
    label: 'Getting started',
    slug: 'start',
    collectionPath: 'content/guides',
    typeLabel: 'Guide',
    route: '/guides/start',
  },
  {
    path: 'content/guides/data',
    label: 'Data access',
    slug: 'access-rules',
    collectionPath: 'content/guides',
    typeLabel: 'Guide',
    route: '/guides/access-rules',
  },
  {
    path: 'content/news/launch',
    label: 'Launch day',
    slug: 'launch',
    collectionPath: 'content/news',
    typeLabel: 'News item',
  },
  { path: 'content/home', label: 'Home', slug: 'index', collectionPath: 'content', route: '/' },
  {
    path: 'content/settings',
    label: 'Site settings',
    title: 'Example site',
    slug: 'site',
    collectionPath: 'content',
  },
]
const labelFor = (path: string) =>
  ({ 'content/guides': 'Guides', 'content/news': 'News' })[path] ?? undefined

const renderPalette = (extra: Partial<React.ComponentProps<typeof QuickOpenPalette>> = {}) => {
  const calls: string[] = []
  const onOpen = vi.fn()
  const onClose = vi.fn(() => calls.push('close'))
  const onSelect = vi.fn((path: string) => calls.push(`select:${path}`))
  const ui = (props: Partial<React.ComponentProps<typeof QuickOpenPalette>>) => (
    <MantineProvider>
      <QuickOpenPalette
        opened
        onOpen={onOpen}
        onClose={onClose}
        entries={ENTRIES}
        collectionLabel={labelFor}
        onSelect={onSelect}
        {...props}
      />
    </MantineProvider>
  )
  const view = render(ui(extra))
  return {
    calls,
    onOpen,
    onClose,
    onSelect,
    rerenderWith: (props: Partial<React.ComponentProps<typeof QuickOpenPalette>>) =>
      view.rerender(ui({ ...extra, ...props })),
  }
}

const input = () => screen.getByTestId('quick-open-input') as HTMLInputElement
const options = () => screen.queryAllByTestId('quick-open-option')
/** An option's first line, its label, without the type and route under it. */
const labelOf = (option: HTMLElement) => option.firstElementChild?.textContent
const armedLabels = () =>
  options()
    .filter((option) => option.getAttribute('data-combobox-selected') === 'true')
    .map(labelOf)
const optionLabels = () => options().map(labelOf)
const detailOf = (option: HTMLElement) =>
  within(option).queryByTestId('quick-open-option-detail')?.textContent

describe('QuickOpenPalette hotkey', () => {
  const press = (target: EventTarget, init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(event)
    return event
  }

  const targets: Array<[string, () => HTMLElement]> = [
    ['the page body', () => document.body],
    [
      'a text input',
      () => {
        const field = document.createElement('input')
        document.body.appendChild(field)
        return field
      },
    ],
    [
      'a textarea',
      () => {
        const field = document.createElement('textarea')
        document.body.appendChild(field)
        return field
      },
    ],
    [
      'a contenteditable element',
      () => {
        const editor = document.createElement('div')
        editor.setAttribute('contenteditable', 'true')
        // jsdom does not implement isContentEditable.
        Object.defineProperty(editor, 'isContentEditable', { value: true })
        document.body.appendChild(editor)
        return editor
      },
    ],
  ]

  for (const [modifier, init] of [
    ['⌘', { metaKey: true }],
    ['Ctrl', { ctrlKey: true }],
  ] as const) {
    for (const [name, makeTarget] of targets) {
      it(`opens on ${modifier}+P from ${name} and stops the browser printing`, () => {
        const { onOpen } = renderPalette({ opened: false })

        const event = press(makeTarget(), { key: 'p', ...init })

        expect(onOpen).toHaveBeenCalledTimes(1)
        expect(event.defaultPrevented).toBe(true)
      })
    }
  }

  it('opens when the shifted key reports a capital P', () => {
    const { onOpen } = renderPalette({ opened: false })

    press(document.body, { key: 'P', metaKey: true })

    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  describe('on macOS', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('opens on ⌘P but leaves Ctrl+P to the text field', () => {
      vi.stubGlobal('navigator', { platform: 'MacIntel' })
      const { onOpen } = renderPalette({ opened: false })

      const ctrl = press(document.body, { key: 'p', ctrlKey: true })
      expect(onOpen).not.toHaveBeenCalled()
      expect(ctrl.defaultPrevented).toBe(false)

      press(document.body, { key: 'p', metaKey: true })
      expect(onOpen).toHaveBeenCalledTimes(1)
    })
  })

  describe('with another overlay open', () => {
    const addDialog = (attrs: Record<string, string>) => {
      const dialog = document.createElement('section')
      dialog.setAttribute('role', 'dialog')
      for (const [name, value] of Object.entries(attrs)) dialog.setAttribute(name, value)
      document.body.appendChild(dialog)
      return dialog
    }

    it('stays shut over a modal, and still stops the browser printing', () => {
      const { onOpen } = renderPalette({ opened: false })
      const field = document.createElement('input')
      addDialog({ 'aria-modal': 'true' }).appendChild(field)

      const event = press(field, { key: 'p', ctrlKey: true })

      expect(onOpen).not.toHaveBeenCalled()
      expect(event.defaultPrevented).toBe(true)
    })

    it('opens over an overlay marked as one it replaces', () => {
      const { onOpen } = renderPalette({ opened: false })
      addDialog({ 'aria-modal': 'true', [QUICK_OPEN_REPLACES_ATTR]: 'true' })

      press(document.body, { key: 'p', ctrlKey: true })

      expect(onOpen).toHaveBeenCalledTimes(1)
    })

    it('reopens over its own dialog, which lingers while it closes', async () => {
      const { onOpen } = renderPalette({ opened: true })
      await screen.findByTestId('quick-open-input')

      press(document.body, { key: 'p', ctrlKey: true })

      expect(onOpen).toHaveBeenCalledTimes(1)
    })

    it('opens over a popover, which is not modal', () => {
      const { onOpen } = renderPalette({ opened: false })
      addDialog({})

      press(document.body, { key: 'p', ctrlKey: true })

      expect(onOpen).toHaveBeenCalledTimes(1)
    })
  })

  it('ignores P without a modifier, and Mod+Shift+P', () => {
    const { onOpen } = renderPalette({ opened: false })

    const plain = press(document.body, { key: 'p' })
    press(document.body, { key: 'p', metaKey: true, shiftKey: true })

    expect(onOpen).not.toHaveBeenCalled()
    expect(plain.defaultPrevented).toBe(false)
  })
})

describe('QuickOpenPalette', () => {
  it('lists entries under their collection headings, named by collectionLabel', async () => {
    renderPalette()

    const dialog = await screen.findByRole('dialog')
    for (const heading of ['Guides', 'News', 'content']) {
      expect(within(dialog).getByText(heading)).toBeTruthy()
    }
    expect(within(dialog).queryByText('content/guides')).toBeNull()
    expect(optionLabels()).toEqual([
      'Getting started',
      'Data access',
      'Launch day',
      'Home',
      'Site settings',
    ])
  })

  it('shows the type and route under each label, whichever the entry has, never the slug', async () => {
    renderPalette()

    await screen.findByRole('dialog')
    expect(options().map(detailOf)).toEqual([
      'Guide · /guides/start',
      'Guide · /guides/access-rules',
      'News item',
      '/',
      undefined,
    ])
  })

  it('titles the dialog and labels the search field', async () => {
    renderPalette()

    expect(await screen.findByText('Open entry')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Search entries' })).toBe(input())
    expect(input().placeholder).toBe('Type an entry title or slug')
  })

  it('focuses the search field', async () => {
    renderPalette()

    await waitFor(() => expect(document.activeElement).toBe(input()))
  })

  it('narrows the list as you type, by title or by slug', async () => {
    const user = userEvent.setup()
    renderPalette()

    await user.type(input(), 'launch')
    expect(optionLabels()).toEqual(['Launch day'])

    await user.clear(input())
    await user.type(input(), 'access-rules')
    expect(optionLabels()).toEqual(['Data access'])

    // A type-named entry is found by its title too.
    await user.clear(input())
    await user.type(input(), 'example')
    expect(optionLabels()).toEqual(['Site settings'])
  })

  it('says so when nothing matches', async () => {
    const user = userEvent.setup()
    renderPalette()

    await user.type(input(), 'zzz')

    expect(options()).toHaveLength(0)
    expect(screen.getByTestId('quick-open-empty').textContent).toBe('No entries match “zzz”.')
  })

  it('opens the first match on Enter without any arrow keys', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderPalette()

    await user.type(input(), 'a{Enter}')

    expect(onSelect).toHaveBeenCalledWith('content/guides/start')
  })

  it('arms the first option as soon as it opens', async () => {
    renderPalette()

    await waitFor(() => expect(armedLabels()).toEqual(['Getting started']))
  })

  it('moves down with ArrowDown and opens that entry on Enter', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderPalette()

    await waitFor(() => expect(armedLabels()).toHaveLength(1))
    await user.click(input())
    await user.keyboard('{ArrowDown}{Enter}')

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('content/guides/data')
  })

  it('moves back up with ArrowUp', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderPalette()

    await waitFor(() => expect(armedLabels()).toHaveLength(1))
    await user.click(input())
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}{Enter}')

    expect(onSelect).toHaveBeenCalledWith('content/guides/data')
  })

  it('re-arms the first option when the query changes', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderPalette()

    await waitFor(() => expect(armedLabels()).toHaveLength(1))
    await user.click(input())
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(armedLabels()).toEqual(['Launch day'])
    await user.keyboard('l')
    await waitFor(() => expect(armedLabels()).toEqual(['Data access']))
    await user.keyboard('{Enter}')

    // "l" matches Data access (by its slug) and Launch day. The first of them opens,
    // not the Launch day that was armed before typing.
    expect(onSelect).toHaveBeenCalledWith('content/guides/data')
  })

  it('opens an entry on click, selecting it before closing', async () => {
    const user = userEvent.setup()
    const { calls } = renderPalette()

    await user.click(options()[2])

    expect(calls).toEqual(['select:content/news/launch', 'close'])
  })

  it('closes on Escape without selecting anything', async () => {
    const user = userEvent.setup()
    const { onClose, onSelect } = renderPalette()

    await user.click(input())
    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('focuses returnFocusTo once it has closed, for an opener the caller unmounted', async () => {
    const target = document.createElement('button')
    document.body.appendChild(target)
    const { rerenderWith } = renderPalette({ returnFocusTo: () => target })
    expect(document.activeElement).not.toBe(target)

    rerenderWith({ opened: false })

    await waitFor(() => expect(document.activeElement).toBe(target))
  })

  it('leaves focus where the user moved it before the palette finished closing', async () => {
    const target = document.createElement('button')
    const elsewhere = document.createElement('button')
    document.body.append(target, elsewhere)
    const { rerenderWith } = renderPalette({ returnFocusTo: () => target })
    await waitFor(() => expect(document.activeElement).toBe(input()))

    rerenderWith({ opened: false })
    elsewhere.focus()

    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(document.activeElement).toBe(elsewhere)
  })

  it('starts empty each time it opens', async () => {
    const user = userEvent.setup()
    const { rerenderWith } = renderPalette()

    await user.type(input(), 'launch')
    expect(optionLabels()).toHaveLength(1)

    rerenderWith({ opened: false })
    rerenderWith({ opened: true })

    await waitFor(() => expect(input().value).toBe(''))
    expect(options()).toHaveLength(ENTRIES.length)
  })

  describe('long lists', () => {
    const many: QuickOpenEntry[] = Array.from({ length: 60 }, (_, index) => ({
      path: `content/posts/post-${index}`,
      label: `Post ${index}`,
      slug: `post-${index}`,
      collectionPath: 'content/posts',
    }))

    it('shows 50 options and says how many more there are', async () => {
      renderPalette({ entries: many })

      expect(options()).toHaveLength(50)
      expect(screen.getByText('Showing 50 of 60. Keep typing to narrow the list.')).toBeTruthy()
    })

    it('drops the footer once the list fits', async () => {
      const user = userEvent.setup()
      renderPalette({ entries: many })

      await user.type(input(), 'post-5')

      expect(options().length).toBeLessThanOrEqual(50)
      expect(screen.queryByText(/Showing/)).toBeNull()
    })

    it('shows no footer for exactly 50 matches', () => {
      renderPalette({ entries: many.slice(0, 50) })

      expect(options()).toHaveLength(50)
      expect(screen.queryByText(/Showing/)).toBeNull()
    })
  })
})
