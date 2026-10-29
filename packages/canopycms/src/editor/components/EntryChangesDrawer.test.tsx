import React, { useRef, useState } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BranchEntryChangeData } from '../../api/branch-entry-changes'
import type { FieldConfig } from '../../config'
import { CanopyCMSProvider } from '../theme'
import { returnTarget } from '../utils/focus-return'
import type { EntryChangeState } from '../hooks/useBranchChangesData'
import {
  EntryChangesDrawer,
  type EntryChangesDrawerProps,
  type EntryChangesSubject,
} from './EntryChangesDrawer'

afterEach(() => cleanup())

const textOf = (el: Element | null): string => el?.textContent ?? ''

const fields: FieldConfig[] = [
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'author', type: 'reference', label: 'Author' },
]
const subject: EntryChangesSubject = {
  logicalPath: 'content/blog/hello',
  status: 'modified',
  title: 'Hello',
  fields,
}
const sides = (
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): BranchEntryChangeData => ({
  before: before && { format: 'json', entryType: 'post', data: before },
  after: after && { format: 'json', entryType: 'post', data: after },
  mergeBaseSha: 'a'.repeat(40),
})
const loaded = (data: BranchEntryChangeData): EntryChangesDrawerProps['state'] => ({
  data,
  error: undefined,
  isValidating: false,
  reload: vi.fn().mockResolvedValue(undefined),
})

const renderDrawer = (props: Partial<EntryChangesDrawerProps> = {}) =>
  render(
    <CanopyCMSProvider>
      <EntryChangesDrawer
        opened
        onClose={() => {}}
        base="main"
        subject={subject}
        state={loaded(sides({ title: 'Hello' }, { title: 'Hello there' }))}
        {...props}
      />
    </CanopyCMSProvider>,
  )

const drawer = () => screen.getByRole('dialog', { name: 'Changes to Hello' })

describe('EntryChangesDrawer', () => {
  it('summarises the change and shows each field’s sides, marked in words as well as style', async () => {
    renderDrawer()
    const dialog = await waitFor(drawer)
    expect(textOf(within(dialog).getByTestId('entry-changes-summary'))).toContain(
      '1 field changed since main',
    )
    const card = within(dialog).getByTestId('entry-change-card')
    expect(textOf(card)).toContain('Title')
    expect(textOf(card)).toContain('Changed')
    const inserted = card.querySelector('ins')
    // The inserted run keeps its own leading space, so the "Added: " prefix is followed by it.
    expect(textOf(inserted)).toBe('Added:  there')
    expect(within(inserted as HTMLElement).getByText('Added:')).toBeTruthy()
  })

  it('shows a text it couldn’t mark whole on each side, saying so', async () => {
    const many = (word: string) =>
      Array.from({ length: 10_000 }, (_, i) => `${word}${i}`).join('\n')
    renderDrawer({
      subject: { ...subject, fields: [{ name: 'notes', type: 'markdown', label: 'Notes' }] },
      state: loaded(sides({ notes: many('a') }, { notes: many('b') })),
    })
    const card = within(await waitFor(drawer)).getByTestId('entry-change-card')
    expect(textOf(within(card).getByTestId('entry-change-unmarked'))).toBe(
      'Too many changes to highlight.',
    )
    expect(card.querySelector('ins, del')).toBeNull()
    expect(textOf(card)).toContain('a9999')
    expect(textOf(card)).toContain('b9999')
  })

  it('names a reference by title, or as an unknown entry by id', async () => {
    renderDrawer({
      state: loaded(sides({ author: 'aaaaaaaaaaaa' }, { author: 'bbbbbbbbbbbb' })),
      referenceTitle: (id) => (id === 'aaaaaaaaaaaa' ? 'Ada' : undefined),
    })
    const card = within(await waitFor(drawer)).getByTestId('entry-change-card')
    expect(textOf(card)).toContain('Ada')
    expect(textOf(card)).toContain('Unknown entry bbbbbbbbbbbb')
  })

  it('says a new, deleted or moved entry is one', async () => {
    const { unmount } = renderDrawer({ state: loaded(sides(null, { title: 'Hello' })) })
    expect(textOf(within(await waitFor(drawer)).getByTestId('entry-changes-summary'))).toContain(
      'New entry',
    )
    unmount()
    const deleted = renderDrawer({ state: loaded(sides({ title: 'Hello' }, null)) })
    expect(textOf(within(await waitFor(drawer)).getByTestId('entry-changes-summary'))).toContain(
      'Deleted entry',
    )
    deleted.unmount()
    renderDrawer({
      subject: { ...subject, from: 'content/blog/hi', movedFromLabel: 'Blog › hi' },
      state: loaded(sides({ title: 'Hello' }, { title: 'Hello' })),
    })
    const dialog = await waitFor(drawer)
    expect(textOf(within(dialog).getByTestId('entry-changes-moved'))).toContain(
      'Moved from Blog › hi',
    )
    expect(within(dialog).queryByTestId('entry-changes-summary')).toBeNull()
  })

  it('says when only formatting changed', async () => {
    renderDrawer({ state: loaded(sides({ title: 'Hello' }, { title: 'Hello' })) })
    expect(textOf(within(await waitFor(drawer)).getByTestId('entry-changes-summary'))).toContain(
      'Only formatting changed; no field values differ.',
    )
  })

  it('says unsaved edits are left out', async () => {
    renderDrawer({ subject: { ...subject, unsavedEdits: true } })
    expect(textOf(within(await waitFor(drawer)).getByTestId('entry-changes-unsaved'))).toContain(
      'Unsaved edits aren’t included. Save to include them.',
    )
  })

  it('shows skeleton cards while loading', async () => {
    renderDrawer({ state: { ...loaded(sides(null, null)), data: undefined } })
    expect(within(await waitFor(drawer)).getByTestId('entry-changes-loading')).toBeTruthy()
  })

  it('shows a 409 in yellow in the server’s words, keeps the last data, and retries', async () => {
    const state: EntryChangeState = {
      ...loaded(sides({ title: 'Hello' }, { title: 'Hello there' })),
      isLoading: false,
      error: { kind: 'syncing', message: 'This branch is being synced with main.' },
    }
    renderDrawer({ state })
    const dialog = await waitFor(drawer)
    const alert = within(dialog).getByTestId('entry-changes-syncing')
    expect(textOf(alert)).toContain('This branch is being synced with main.')
    expect(within(dialog).getByTestId('entry-change-card')).toBeTruthy()
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(state.reload).toHaveBeenCalled()
  })

  it.each([
    ['tooLarge', 'This entry is too large to compare here.'],
    ['unavailable', 'This entry can’t be compared.'],
  ] as const)('gives a %s refusal plain copy and no Retry', async (kind, copy) => {
    renderDrawer({
      state: { ...loaded(sides(null, null)), data: undefined, error: { kind, message: 'x' } },
    })
    const dialog = await waitFor(drawer)
    expect(textOf(within(dialog).getByTestId(`entry-changes-${kind}`))).toContain(copy)
    expect(within(dialog).queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('closes on Escape and returns focus to the button that opened it', async () => {
    const Harness = () => {
      const [opened, setOpened] = useState(false)
      const opener = useRef<HTMLButtonElement>(null)
      return (
        <CanopyCMSProvider>
          <button ref={opener} type="button" onClick={() => setOpened(true)}>
            Show changes
          </button>
          <EntryChangesDrawer
            opened={opened}
            onClose={() => setOpened(false)}
            returnFocusTo={() => returnTarget(opener.current, () => null)}
            base="main"
            subject={subject}
            state={loaded(sides({ title: 'Hello' }, { title: 'Hello there' }))}
          />
        </CanopyCMSProvider>
      )
    }
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Show changes' })
    await userEvent.click(opener)
    await waitFor(drawer)
    await waitFor(() => expect(drawer().contains(document.activeElement)).toBe(true))
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })
})
