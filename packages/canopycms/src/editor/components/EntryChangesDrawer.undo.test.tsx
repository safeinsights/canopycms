import React, { useState } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BranchEntryChangeData } from '../../api/branch-entry-changes'
import type { FieldConfig } from '../../config'
import { CanopyCMSProvider } from '../theme'
import {
  EntryChangesDrawer,
  type EntryChangesDrawerProps,
  type EntryChangesSubject,
} from './EntryChangesDrawer'

afterEach(() => cleanup())

const fields: FieldConfig[] = [
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'summary', type: 'string', label: 'Summary' },
  {
    name: 'links',
    type: 'object',
    list: true,
    label: 'Links',
    fields: [{ name: 'label', type: 'string', label: 'Label' }],
  },
] as FieldConfig[]
const subject: EntryChangesSubject = {
  logicalPath: 'content/blog/hello',
  status: 'modified',
  title: 'Hello',
  fields,
}
const side = (data: Record<string, unknown>) => ({
  format: 'json' as const,
  entryType: 'post',
  data,
})
const before = {
  title: 'Hello',
  summary: 'Short',
  links: [{ _key: 'a', label: 'One' }],
}
const after = {
  title: 'Hello there',
  summary: 'Longer',
  links: [
    { _key: 'a', label: 'One' },
    { _key: 'b', label: 'Two' },
  ],
}
const data = (b: Record<string, unknown> | null, a: Record<string, unknown> | null) =>
  ({
    before: b && side(b),
    after: a && side(a),
    mergeBaseSha: 'a'.repeat(40),
  }) satisfies BranchEntryChangeData

/** The drawer over a form value it changes, as the editor's draft would be changed. */
const Harness: React.FC<
  Partial<EntryChangesDrawerProps> & {
    initial?: Record<string, unknown>
    onValue?: (value: Record<string, unknown>) => void
    threads?: number
  }
> = ({ initial = after, onValue, threads, ...props }) => {
  const [value, setValue] = useState(initial)
  return (
    <CanopyCMSProvider>
      <EntryChangesDrawer
        opened
        onClose={() => {}}
        base="main"
        subject={subject}
        state={{
          data: data(before, after),
          error: undefined,
          isValidating: false,
          reload: vi.fn(),
        }}
        undo={{
          value,
          update: (update) =>
            setValue((current) => {
              const next = update(current)
              onValue?.(next)
              return next
            }),
          ...(threads !== undefined && { threadsWithin: () => threads }),
        }}
        {...props}
      />
    </CanopyCMSProvider>
  )
}

const dialog = () => waitFor(() => screen.getByRole('dialog', { name: 'Changes to Hello' }))
const card = async (heading: string) => {
  const cards = within(await dialog()).getAllByTestId('entry-change-card')
  const found = cards.find(
    (c) => within(c).getByRole('heading', { level: 3 }).textContent === heading,
  )
  if (!found) throw new Error(`no card ${heading}`)
  return found
}

describe('EntryChangesDrawer undo', () => {
  it('undoes one field in the form, says so, and redoes it', async () => {
    const values: Array<Record<string, unknown>> = []
    render(<Harness onValue={(v) => values.push(v)} />)
    const title = await card('Title')
    const button = within(title).getByRole('button', { name: 'Undo change to Title' })
    await userEvent.click(button)
    expect(values.at(-1)).toMatchObject({ title: 'Hello', summary: 'Longer' })
    expect(within(title).getByTestId('entry-change-undone').textContent).toBe(
      'Undone in the form. Save to keep it.',
    )
    // The same button, so focus stays on it.
    expect(button.textContent).toBe('Redo change')
    expect(document.activeElement).toBe(button)
    await userEvent.click(button)
    expect(values.at(-1)).toMatchObject({ title: 'Hello there' })
    expect(within(title).getByTestId('entry-change-undone').textContent).toBe('')
  })

  it('keeps undo from a change with unsaved edits, saying why', async () => {
    const onValue = vi.fn()
    render(<Harness initial={{ ...after, title: 'Typed' }} onValue={onValue} />)
    const title = within(await card('Title')).getByRole('button', { name: /^Undo change/ })
    expect(title.getAttribute('aria-disabled')).toBe('true')
    await userEvent.hover(title)
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'This change has unsaved edits. Save them, or choose "Discard changes" in the entry\'s menu, on its name, first.',
    )
    await userEvent.click(title)
    const all = within(await dialog()).getByTestId('entry-changes-undo-all')
    expect(all.getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(all)
    expect(onValue).not.toHaveBeenCalled()
    // A change the edit didn't touch still undoes.
    const summary = within(await card('Summary')).getByRole('button', { name: /^Undo change/ })
    expect(summary.getAttribute('aria-disabled')).toBeNull()
  })

  it('keeps undo from an added item edited since its save', async () => {
    const onValue = vi.fn()
    const edited = { ...after, links: [after.links[0], { _key: 'b', label: 'Two edited' }] }
    render(<Harness initial={edited} onValue={onValue} />)
    const button = within(await card('Links › Two')).getByRole('button', { name: /^Undo change/ })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(button)
    expect(onValue).not.toHaveBeenCalled()
  })

  it('keeps redo from a removed item put back and edited since', async () => {
    const onValue = vi.fn()
    const removedOnBranch = { ...after, links: [] }
    // "Undo change" put the item back; the form has edited it since.
    const putBackThenEdited = { ...after, links: [{ _key: 'a', label: 'One, edited' }] }
    render(
      <Harness
        initial={putBackThenEdited}
        onValue={onValue}
        state={{
          data: data(before, removedOnBranch),
          error: undefined,
          isValidating: false,
          reload: vi.fn(),
        }}
      />,
    )
    const redo = within(await card('Links › One')).getByRole('button', { name: /^Redo change/ })
    expect(redo.getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(redo)
    expect(onValue).not.toHaveBeenCalled()
  })

  it('says an undo is unsaved on a line held from the start, with no notice arriving', async () => {
    const Unsaved: React.FC = () => {
      const [value, setValue] = useState<Record<string, unknown>>(after)
      return (
        <CanopyCMSProvider>
          <EntryChangesDrawer
            opened
            onClose={() => {}}
            base="main"
            subject={{ ...subject, unsavedEdits: value !== after }}
            state={{
              data: data(before, after),
              error: undefined,
              isValidating: false,
              reload: vi.fn(),
            }}
            undo={{ value, update: (update) => setValue(update) }}
          />
        </CanopyCMSProvider>
      )
    }
    render(<Unsaved />)
    const line = within(await dialog()).getByTestId('entry-changes-all-undone')
    expect(line.textContent).toBe('')
    await userEvent.click(within(await card('Title')).getByRole('button', { name: /^Undo change/ }))
    expect(line.isConnected).toBe(true)
    expect(line.textContent).toBe('Unsaved edits, undos included, apply when you save.')
    expect(within(await dialog()).queryByTestId('entry-changes-unsaved')).toBeNull()
  })

  it('says the lock’s reason once, in sight, on a locked branch', async () => {
    render(<Harness lockedReason="Locked." />)
    expect(within(await dialog()).getByTestId('entry-changes-locked').textContent).toBe('Locked.')
  })

  it('offers no "Undo all changes" for a single change', async () => {
    render(
      <Harness
        initial={{ ...before, title: 'Hello there' }}
        state={{
          data: data(before, { ...before, title: 'Hello there' }),
          error: undefined,
          isValidating: false,
          reload: vi.fn(),
        }}
      />,
    )
    const view = await dialog()
    expect(within(view).queryByTestId('entry-changes-undo-all')).toBeNull()
    expect(within(view).getByRole('button', { name: 'Undo change to Title' })).toBeTruthy()
  })

  it('says where "Undo all changes" moved the added items’ threads', async () => {
    render(<Harness threads={2} />)
    await userEvent.click(within(await dialog()).getByTestId('entry-changes-undo-all'))
    expect(within(await dialog()).getByTestId('entry-changes-announcement').textContent).toBe(
      'All changes undone in the form. Save to keep them. Its 2 comment threads moved to "Comment on this entry".',
    )
    expect(
      within(await card('Links › Two')).getByTestId('entry-change-undone').textContent,
    ).toContain('Its 2 comment threads moved')
  })

  it('announces each undo once, from one status region, not from the card', async () => {
    render(<Harness />)
    const region = within(await dialog()).getByTestId('entry-changes-announcement')
    const title = await card('Title')
    await userEvent.click(within(title).getByRole('button', { name: 'Undo change to Title' }))
    expect(region.textContent).toBe('Undone: Title. Save to keep it.')
    expect(within(title).queryByRole('status')).toBeNull()
    const first = region.firstElementChild
    await userEvent.click(within(title).getByRole('button', { name: 'Redo change to Title' }))
    await userEvent.click(within(title).getByRole('button', { name: 'Undo change to Title' }))
    // The same words again, in a new node, so they are read again.
    expect(region.textContent).toBe('Undone: Title. Save to keep it.')
    expect(region.firstElementChild).not.toBe(first)
  })

  it('takes out an added item and says where its threads went', async () => {
    const values: Array<Record<string, unknown>> = []
    render(<Harness onValue={(v) => values.push(v)} threads={2} />)
    const item = await card('Links › Two')
    await userEvent.click(within(item).getByRole('button', { name: /^Undo change/ }))
    expect(values.at(-1)?.links).toEqual(before.links)
    expect(within(item).getByTestId('entry-change-undone').textContent).toBe(
      'Undone in the form. Save to keep it. Its 2 comment threads moved to "Comment on this entry".',
    )
  })

  it('undoes and redoes every change at once', async () => {
    const values: Array<Record<string, unknown>> = []
    render(<Harness onValue={(v) => values.push(v)} />)
    const all = within(await dialog()).getByTestId('entry-changes-undo-all')
    expect(all.textContent).toBe('Undo all changes')
    await userEvent.click(all)
    expect(values.at(-1)).toEqual(before)
    expect(all.textContent).toBe('Redo all changes')
    expect(within(await dialog()).getByTestId('entry-changes-all-undone').textContent).toBe(
      'All changes undone in the form. Save to keep them.',
    )
    await userEvent.click(all)
    expect(values.at(-1)).toEqual(after)
  })

  it('shows a change the form already undid as undone', async () => {
    render(<Harness initial={{ ...after, summary: 'Short' }} />)
    const summary = await card('Summary')
    expect(within(summary).getByRole('button', { name: 'Redo change to Summary' })).toBeTruthy()
  })

  it('keeps the controls on a locked branch, disabled, with the reason', async () => {
    const onValue = vi.fn()
    const reason = 'This branch is in review. Withdraw it to make changes.'
    render(<Harness onValue={onValue} lockedReason={reason} />)
    const button = within(await card('Title')).getByRole('button', { name: 'Undo change to Title' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    await userEvent.hover(button)
    expect((await screen.findByRole('tooltip')).textContent).toBe(reason)
    await userEvent.click(button)
    await userEvent.click(within(await dialog()).getByTestId('entry-changes-undo-all'))
    expect(onValue).not.toHaveBeenCalled()
  })

  it('hides every control without edit access, saying why once', async () => {
    render(<Harness noEditReason="You don't have edit access to this entry." />)
    const view = await dialog()
    expect(within(view).queryByTestId('entry-change-undo')).toBeNull()
    expect(within(view).queryByTestId('entry-changes-undo-all')).toBeNull()
    expect(within(view).getByTestId('entry-changes-no-edit').textContent).toBe(
      "You don't have edit access to this entry.",
    )
  })

  it('refuses a change inside an item the form no longer has, saying why', async () => {
    const changedItem = { ...after, links: [{ _key: 'a', label: 'First' }, after.links[1]] }
    const onValue = vi.fn()
    render(
      <Harness
        initial={{ ...changedItem, links: [after.links[1]] }}
        onValue={onValue}
        state={{
          data: data(before, changedItem),
          error: undefined,
          isValidating: false,
          reload: vi.fn(),
        }}
      />,
    )
    const button = within(await card('Links › One › Label')).getByTestId('entry-change-undo')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    // Not offered as undone: nothing could redo it.
    expect(button.textContent).toBe('Undo change')
    await userEvent.click(button)
    expect(onValue).not.toHaveBeenCalled()
  })

  it('offers no undo for an entry type change', async () => {
    render(
      <Harness
        state={{
          data: { ...data(before, after), after: { ...side(after), entryType: 'page' } },
          error: undefined,
          isValidating: false,
          reload: vi.fn(),
        }}
      />,
    )
    const view = await dialog()
    expect(within(view).queryByTestId('entry-change-undo')).toBeNull()
    expect(within(view).getByTestId('entry-changes-type-changed')).toBeTruthy()
  })

  it('says undo leaves a moved entry where it is, and how to move it back', async () => {
    const { unmount } = render(
      <Harness subject={{ ...subject, from: 'content/blog/hi', movedFromLabel: 'Blog › hi' }} />,
    )
    expect(within(await dialog()).getByTestId('entry-changes-move-hint').textContent).toBe(
      'Undoing changes doesn’t move the entry back. To move it back, use "Change URL…".',
    )
    unmount()
    render(
      <Harness subject={{ ...subject, from: 'content/news/hi', movedFromLabel: 'News › hi' }} />,
    )
    expect(within(await dialog()).getByTestId('entry-changes-move-hint').textContent).toBe(
      'Undoing changes doesn’t move the entry back.',
    )
  })

  it('offers "Delete entry" for an entry added on the branch', async () => {
    const onDeleteEntry = vi.fn()
    render(
      <Harness
        subject={{ ...subject, status: 'added' }}
        onDeleteEntry={onDeleteEntry}
        state={{ data: data(null, after), error: undefined, isValidating: false, reload: vi.fn() }}
      />,
    )
    const view = await dialog()
    expect(within(view).queryByTestId('entry-change-undo')).toBeNull()
    await userEvent.click(within(view).getByRole('button', { name: 'Delete entry' }))
    expect(onDeleteEntry).toHaveBeenCalledOnce()
  })

  it('hides "Delete entry" without edit access', async () => {
    render(
      <Harness
        subject={{ ...subject, status: 'added' }}
        onDeleteEntry={vi.fn()}
        noEditReason="No access."
        state={{ data: data(null, after), error: undefined, isValidating: false, reload: vi.fn() }}
      />,
    )
    expect(within(await dialog()).queryByRole('button', { name: 'Delete entry' })).toBeNull()
  })

  it('offers no controls without an open entry to undo in', async () => {
    render(
      <CanopyCMSProvider>
        <EntryChangesDrawer
          opened
          onClose={() => {}}
          base="main"
          subject={subject}
          state={{
            data: data(before, after),
            error: undefined,
            isValidating: false,
            reload: vi.fn(),
          }}
        />
      </CanopyCMSProvider>,
    )
    const view = await dialog()
    expect(within(view).queryByRole('button', { name: /Undo/ })).toBeNull()
  })

  describe('"Restore entry"', () => {
    const deleted = (props: Partial<EntryChangesDrawerProps>) => (
      <Harness
        subject={{ ...subject, status: 'deleted' }}
        state={{ data: data(before, null), error: undefined, isValidating: false, reload: vi.fn() }}
        {...props}
      />
    )

    it('restores an entry the branch deleted', async () => {
      const onRestoreEntry = vi.fn().mockResolvedValue(undefined)
      render(deleted({ onRestoreEntry }))
      const view = await dialog()
      expect(within(view).queryByTestId('entry-change-undo')).toBeNull()
      await userEvent.click(within(view).getByRole('button', { name: 'Restore entry' }))
      expect(onRestoreEntry).toHaveBeenCalledOnce()
      expect(within(view).queryByTestId('entry-changes-restore-refused')).toBeNull()
    })

    it('says why it couldn’t, yellow where nothing is lost, and lets it be tried again', async () => {
      let settle: (refusal: undefined) => void = () => {}
      const onRestoreEntry = vi
        .fn()
        .mockResolvedValueOnce({ tone: 'warning', message: 'Another entry now has this URL.' })
        .mockReturnValueOnce(new Promise((resolve) => (settle = resolve)))
      render(deleted({ onRestoreEntry }))
      const view = await dialog()
      const button = within(view).getByRole('button', { name: 'Restore entry' })
      await userEvent.click(button)
      const refused = await within(view).findByTestId('entry-changes-restore-refused')
      expect(refused.textContent).toBe('Another entry now has this URL.')
      expect(refused.getAttribute('style')).toContain('yellow')
      // The old reason goes as the retry starts, not when it ends.
      await userEvent.click(button)
      await waitFor(() =>
        expect(within(view).queryByTestId('entry-changes-restore-refused')).toBeNull(),
      )
      settle(undefined)
    })

    it('stays, disabled, on a locked branch, and hides without edit access', async () => {
      const onRestoreEntry = vi.fn()
      const { unmount } = render(deleted({ onRestoreEntry, lockedReason: 'Locked.' }))
      const button = within(await dialog()).getByRole('button', { name: 'Restore entry' })
      expect(button.getAttribute('aria-disabled')).toBe('true')
      await userEvent.click(button)
      expect(onRestoreEntry).not.toHaveBeenCalled()
      unmount()
      render(deleted({ onRestoreEntry, noEditReason: 'No access.' }))
      expect(within(await dialog()).queryByRole('button', { name: 'Restore entry' })).toBeNull()
    })
  })
})
