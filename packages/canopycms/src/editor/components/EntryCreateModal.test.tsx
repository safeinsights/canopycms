import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
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

    await user.clear(slugInput())
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

    await user.clear(slugInput())
    await user.type(slugInput(), 'my-slug')
    expect(slugInput().value).toBe('my-slug')

    rerender(<Harness tick={2} isOpen={false} />)
    rerender(<Harness tick={3} isOpen />)

    expect(slugInput().value).toBe('untitled')
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

  it('shows a clear message and disables Create when the typed slug already exists', async () => {
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

    await user.clear(slugInput())
    await user.type(slugInput(), 'taken-slug')

    expect(await screen.findByText('An entry with this slug already exists')).toBeTruthy()
    expect(createButton().disabled).toBe(true)

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

    await user.clear(slugInput())
    await user.type(slugInput(), 'free-slug')

    expect(screen.queryByText('An entry with this slug already exists')).toBeNull()
    expect(createButton().disabled).toBe(false)

    await user.click(createButton())
    expect(onCreate).toHaveBeenCalledWith('free-slug', 'post')
  })
})
