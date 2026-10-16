import type React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { EntryCreateModal, type EntryType } from './EntryCreateModal'

const ENTRY_TYPES: readonly EntryType[] = [
  { name: 'post', label: 'Post', format: 'json', default: true },
  { name: 'note', label: 'Note', format: 'md' },
]

/**
 * Stands in for Editor.tsx, which builds the `entryTypes` prop with an inline
 * `.map()` — a fresh array identity on every one of its renders, with
 * identical contents. Re-rendering this harness reproduces exactly that: the
 * modal sees a prop that is `!==` the previous one but deep-equal to it.
 */
function Harness({ tick, isOpen = true }: { tick: number; isOpen?: boolean }) {
  const entryTypes: EntryType[] = ENTRY_TYPES.map((et) => ({ ...et }))
  return (
    <MantineProvider>
      <span data-testid="tick">{tick}</span>
      <EntryCreateModal
        isOpen={isOpen}
        collectionLabel="Posts"
        entryTypes={entryTypes}
        onCreate={vi.fn()}
        onClose={vi.fn()}
      />
    </MantineProvider>
  )
}

const slugInput = () => screen.getByTestId('entry-slug-input') as HTMLInputElement
const entryTypeInput = () =>
  screen.getByRole('textbox', { name: /entry type/i }) as HTMLInputElement

describe('EntryCreateModal - form state survives parent re-renders', () => {
  afterEach(() => {
    cleanup()
  })

  it('keeps a typed slug when the parent re-renders with a fresh-but-equal entryTypes array', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Harness tick={1} />)

    await user.type(slugInput(), 'my-slug')
    expect(slugInput().value).toBe('my-slug')

    rerender(<Harness tick={2} />)

    expect(slugInput().value).toBe('my-slug')
  })

  it('keeps a chosen entry type when the parent re-renders with a fresh-but-equal entryTypes array', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Harness tick={1} />)

    // 'post' is the collection default; pick the other one.
    await user.click(entryTypeInput())
    await user.click(await screen.findByRole('option', { name: 'Note' }))
    expect(entryTypeInput().value).toBe('Note')

    rerender(<Harness tick={2} />)

    expect(entryTypeInput().value).toBe('Note')
  })

  it('reseeds the defaults when the modal is closed and reopened', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Harness tick={1} />)

    await user.type(slugInput(), 'my-slug')
    expect(slugInput().value).toBe('my-slug')

    rerender(<Harness tick={2} isOpen={false} />)
    rerender(<Harness tick={3} isOpen />)

    expect(slugInput().value).toBe('')
    expect(entryTypeInput().value).toBe('Post')
  })
})

// Client-side pre-check (August 2026 baseline review, Critical finding): a
// create against a slug that's already loaded client-side should surface a
// clear message immediately, rather than a raw 409 or (for entry types with
// no required fields) letting the request through at all.
describe('EntryCreateModal - existing-slug pre-check', () => {
  afterEach(() => {
    cleanup()
  })

  const createButton = () => screen.getByTestId('create-entry-submit') as HTMLButtonElement

  it('shows a clear message and refuses to create when the typed slug already exists', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn()
    render(
      <MantineProvider>
        <EntryCreateModal
          isOpen
          collectionLabel="Posts"
          entryTypes={ENTRY_TYPES.map((et) => ({ ...et }))}
          onCreate={onCreate}
          onClose={vi.fn()}
          existingSlugs={new Set(['taken-slug'])}
        />
      </MantineProvider>,
    )

    await user.type(slugInput(), 'taken-slug')

    expect(await screen.findByText('An entry with this slug already exists')).toBeTruthy()

    await user.click(createButton())
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('allows creating a slug that is not in the existing set', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn().mockResolvedValue(undefined)
    render(
      <MantineProvider>
        <EntryCreateModal
          isOpen
          collectionLabel="Posts"
          entryTypes={ENTRY_TYPES.map((et) => ({ ...et }))}
          onCreate={onCreate}
          onClose={vi.fn()}
          existingSlugs={new Set(['taken-slug'])}
        />
      </MantineProvider>,
    )

    await user.type(slugInput(), 'free-slug')

    expect(screen.queryByText('An entry with this slug already exists')).toBeNull()
    expect(createButton().disabled).toBe(false)

    await user.click(createButton())
    expect(onCreate).toHaveBeenCalledWith('free-slug', 'post', undefined)
  })
})

describe('EntryCreateModal - unavailable entry types', () => {
  afterEach(() => {
    cleanup()
  })

  const unavailable = {
    reason: 'unknown-schema' as const,
    schemaRef: 'widgetSchema',
    metaFile: 'content/widgets/.collection.json',
  }

  const createButton = () => screen.getByTestId('create-entry-submit') as HTMLButtonElement

  const renderModal = (
    entryTypes: EntryType[],
    extra: Partial<React.ComponentProps<typeof EntryCreateModal>> = {},
  ) => {
    const onCreate = vi.fn().mockResolvedValue(undefined)
    render(
      <MantineProvider>
        <EntryCreateModal
          isOpen
          collectionLabel="Widgets"
          entryTypes={entryTypes}
          onCreate={onCreate}
          onClose={vi.fn()}
          {...extra}
        />
      </MantineProvider>,
    )
    return { onCreate }
  }

  it('does not offer an unavailable type, and never defaults to one', async () => {
    const user = userEvent.setup()
    // The unavailable type comes first and is flagged default: the worst case for a default pick.
    const { onCreate } = renderModal([
      { name: 'widget', format: 'json', default: true, unavailable },
      { name: 'note', label: 'Note', format: 'md' },
    ])

    expect(screen.queryByText('widget')).toBeNull()
    expect(screen.getByText('Note')).toBeTruthy()
    await user.type(slugInput(), 'a-note')
    await user.click(createButton())
    expect(onCreate).toHaveBeenCalledWith('a-note', 'note', undefined)
  })

  it('ignores a pre-selected type that is unavailable', async () => {
    const user = userEvent.setup()
    const { onCreate } = renderModal(
      [
        { name: 'widget', format: 'json', unavailable },
        { name: 'note', format: 'md' },
        { name: 'memo', format: 'md' },
      ],
      { selectedEntryTypeName: 'widget' },
    )

    await user.type(slugInput(), 'a-note')
    await user.click(createButton())
    expect(onCreate).toHaveBeenCalledWith('a-note', 'note', undefined)
  })

  it('makes creating impossible when every type is unavailable, and says why', async () => {
    const user = userEvent.setup()
    const { onCreate } = renderModal([{ name: 'widget', format: 'json', unavailable }])

    expect(screen.getByTestId('no-creatable-types').textContent).toContain('widgetSchema')
    expect(createButton().disabled).toBe(true)
    await user.click(createButton())
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('shows no unavailable-type message when every type is available', () => {
    renderModal([{ name: 'note', format: 'md' }])

    expect(screen.queryByTestId('no-creatable-types')).toBeNull()
    expect(createButton().disabled).toBe(false)
  })
})

describe('EntryCreateModal - title-first form', () => {
  afterEach(() => {
    cleanup()
  })

  const TITLED: EntryType[] = [
    { name: 'post', label: 'Post', format: 'mdx', titleField: ['title'] },
  ]
  const submitButton = () => screen.getByTestId('create-entry-submit') as HTMLButtonElement
  const titleInput = () => screen.getByTestId('entry-title-input') as HTMLInputElement

  const renderModal = (
    entryTypes: EntryType[] = TITLED,
    extra: Partial<React.ComponentProps<typeof EntryCreateModal>> = {},
  ) => {
    const onCreate = vi.fn().mockResolvedValue(undefined)
    render(
      <MantineProvider>
        <EntryCreateModal
          isOpen
          collectionLabel="Posts"
          entryTypes={entryTypes}
          onCreate={onCreate}
          onClose={vi.fn()}
          {...extra}
        />
      </MantineProvider>,
    )
    return { onCreate }
  }

  it('titles the modal with the collection and opens with both fields empty', () => {
    renderModal()

    expect(screen.getByText('Add entry to Posts')).toBeTruthy()
    expect(titleInput().value).toBe('')
    expect(slugInput().value).toBe('')
    expect(screen.queryByText(/Creating in/)).toBeNull()
  })

  it('puts the title input first and focuses it', async () => {
    renderModal()

    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[]
    expect(inputs.map((input) => input.dataset.testid)).toEqual([
      'entry-title-input',
      'entry-slug-input',
    ])
    await waitFor(() => expect(document.activeElement).toBe(titleInput()))
    // One autofocus target per dialog: the slug input is not a second claimant.
    expect(slugInput().hasAttribute('data-autofocus')).toBe(false)
  })

  it('shows no error on a fresh form', () => {
    renderModal()

    expect(screen.queryByText('Enter a slug')).toBeNull()
    expect(screen.queryByText('Enter a title')).toBeNull()
  })

  it('makes the slug follow the title', async () => {
    const user = userEvent.setup()
    renderModal()

    await user.type(titleInput(), 'Fish & Chips')

    expect(slugInput().value).toBe('fish-and-chips')
  })

  it('stops following the title once the slug is edited by hand', async () => {
    const user = userEvent.setup()
    renderModal()

    await user.type(titleInput(), 'Hello')
    await user.type(slugInput(), '-there')
    expect(slugInput().value).toBe('hello-there')

    await user.type(titleInput(), ' world')
    expect(slugInput().value).toBe('hello-there')
  })

  it('shows the URL path from previewPath, with a placeholder while the slug is empty', async () => {
    const user = userEvent.setup()
    renderModal(TITLED, { previewPath: (slug) => `/posts/${slug}` })

    expect(screen.getByText('URL path: /posts/your-slug')).toBeTruthy()

    await user.type(titleInput(), 'Hello')
    expect(screen.getByText('URL path: /posts/hello')).toBeTruthy()
  })

  it('describes the slug format when the entry has no page', () => {
    renderModal(TITLED, { previewPath: () => undefined })

    expect(screen.getByText('Lowercase letters, numbers and hyphens')).toBeTruthy()
    expect(screen.queryByText(/URL path/)).toBeNull()
  })

  it('flags a title-derived slug that is already taken', async () => {
    const user = userEvent.setup()
    renderModal(TITLED, { existingSlugs: new Set(['hello']) })

    await user.type(titleInput(), 'Hello')

    expect(await screen.findByText('An entry with this slug already exists')).toBeTruthy()
  })

  it('passes the trimmed title to onCreate for a type with a title field', async () => {
    const user = userEvent.setup()
    const { onCreate } = renderModal()

    await user.type(titleInput(), '  Hello World  ')
    await user.click(submitButton())

    expect(onCreate).toHaveBeenCalledWith('hello-world', 'post', 'Hello World')
  })

  it('submits with Enter from the title input', async () => {
    const user = userEvent.setup()
    const { onCreate } = renderModal()

    await user.type(titleInput(), 'Hello{Enter}')

    expect(onCreate).toHaveBeenCalledWith('hello', 'post', 'Hello')
  })

  it('submits with Enter from the slug input', async () => {
    const user = userEvent.setup()
    const { onCreate } = renderModal()

    await user.type(titleInput(), 'Hello')
    await user.type(slugInput(), '-there{Enter}')

    expect(onCreate).toHaveBeenCalledWith('hello-there', 'post', 'Hello')
  })

  it('shows what is missing, and does not create, when submitted empty', async () => {
    const user = userEvent.setup()
    const { onCreate } = renderModal()

    await user.click(submitButton())

    expect(screen.getByText('Enter a title')).toBeTruthy()
    expect(screen.getByText('Enter a slug')).toBeTruthy()
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('refuses an invalid slug typed by hand', async () => {
    const user = userEvent.setup()
    const { onCreate } = renderModal()

    await user.type(titleInput(), 'Hello')
    await user.clear(slugInput())
    await user.type(slugInput(), 'NotValid')
    await user.click(submitButton())

    expect(screen.getByText('Use lowercase letters')).toBeTruthy()
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('shows only the slug input, focused, for a type with no title field', async () => {
    const user = userEvent.setup()
    const { onCreate } = renderModal([{ name: 'note', label: 'Note', format: 'md' }])

    expect(screen.queryByTestId('entry-title-input')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(slugInput()))

    await user.type(slugInput(), 'a-note')
    await user.click(submitButton())
    expect(onCreate).toHaveBeenCalledWith('a-note', 'note', undefined)
  })

  it('swaps the title input in and out as the entry type changes', async () => {
    const user = userEvent.setup()
    renderModal([
      { name: 'post', label: 'Post', format: 'mdx', default: true, titleField: ['title'] },
      { name: 'note', label: 'Note', format: 'md' },
    ])

    expect(screen.getByTestId('entry-title-input')).toBeTruthy()

    await user.click(screen.getByRole('textbox', { name: /entry type/i }))
    await user.click(await screen.findByRole('option', { name: 'Note' }))

    expect(screen.queryByTestId('entry-title-input')).toBeNull()
  })

  it('uses sentence-case copy for the type picker', () => {
    renderModal([
      { name: 'post', label: 'Post', format: 'mdx', default: true },
      { name: 'note', label: 'Note', format: 'md' },
    ])

    expect(screen.getByText('Entry type')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add entry' })).toBeTruthy()
  })

  it('explains a collection with no entry types instead of offering a form', () => {
    renderModal([])

    expect(screen.getByTestId('no-entry-types').textContent).toContain(
      'Posts holds only collections, so there is no entry type to add.',
    )
    expect(screen.queryByTestId('create-entry-submit')).toBeNull()
    expect(screen.queryByTestId('entry-slug-input')).toBeNull()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })
})
