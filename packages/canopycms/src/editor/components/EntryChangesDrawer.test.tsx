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
    expect(textOf(inserted)).toBe('Added:  there, end of addition')
    expect(within(card).getByRole('heading', { level: 3 }).textContent).toBe('Title')
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
    // Each side whole, cut as any long text is until asked.
    expect(textOf(card)).toContain('a49')
    expect(textOf(card)).toContain('b49')
    expect(within(card).getAllByRole('button', { name: 'Show all 10000 lines' })).toHaveLength(2)
  })

  it('names a reference by title, or as an unknown entry by id', async () => {
    renderDrawer({
      state: loaded(sides({ author: 'aaaaaaaaaaaa' }, { author: 'bbbbbbbbbbbb' })),
      referenceTitle: (id) => (id === 'aaaaaaaaaaaa' ? 'Ada' : undefined),
    })
    const card = within(await waitFor(drawer)).getByTestId('entry-change-card')
    expect(textOf(card)).toContain('Ada')
    expect(textOf(card)).toContain('Entry unavailable')
    expect(textOf(card)).not.toContain('bbbbbbbbbbbb')
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

  it('shows skeleton cards while loading, saying so to a screen reader', async () => {
    renderDrawer({ state: { ...loaded(sides(null, null)), data: undefined } })
    const dialog = await waitFor(drawer)
    expect(within(dialog).getByTestId('entry-changes-loading')).toBeTruthy()
    const status = within(dialog).getByRole('status')
    expect(textOf(status)).toBe('Loading changes…')
  })

  it('announces loading and then the summary from one status region', async () => {
    const view = (state: EntryChangesDrawerProps['state']) => (
      <CanopyCMSProvider>
        <EntryChangesDrawer opened onClose={() => {}} base="main" subject={subject} state={state} />
      </CanopyCMSProvider>
    )
    const { rerender } = render(view({ ...loaded(sides(null, null)), data: undefined }))
    const status = within(await waitFor(drawer)).getByRole('status')
    rerender(view(loaded(sides({ title: 'Hello' }, { title: 'Hello there' }))))
    expect(within(drawer()).getByRole('status')).toBe(status)
    expect(textOf(status)).toBe('1 field changed since main')
  })

  it('counts whole items apart from fields', async () => {
    const team: FieldConfig = {
      name: 'team',
      type: 'object',
      list: true,
      label: 'Team',
      fields: [{ name: 'name', type: 'string', label: 'Name' }],
    }
    renderDrawer({
      subject: { ...subject, fields: [...fields, team] },
      state: loaded(
        sides(
          { title: 'Hello', team: [{ name: 'Ada', _key: 'k1' }] },
          {
            title: 'Hello',
            team: [
              { name: 'Grace', _key: 'k2' },
              { name: 'Linus', _key: 'k3' },
            ],
          },
        ),
      ),
    })
    expect(textOf(within(await waitFor(drawer)).getByTestId('entry-changes-summary'))).toBe(
      '2 items added, 1 item removed since main',
    )
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
    expect(textOf(alert)).toContain(
      'This branch is being synced with main. The changes below may be out of date.',
    )
    expect(within(dialog).getByTestId('entry-change-card')).toBeTruthy()
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(state.reload).toHaveBeenCalled()
  })

  it.each([
    ['tooLarge', 'This entry is too large to compare here.'],
    ['notFound', 'This entry can’t be compared here.'],
    ['unreadable', 'This entry couldn’t be read on one side, so it can’t be compared.'],
  ] as const)(
    'gives a %s refusal its own copy, no Retry, and the ways still open',
    async (kind, copy) => {
      const onOpenEntry = vi.fn()
      renderDrawer({
        state: { ...loaded(sides(null, null)), data: undefined, error: { kind, message: 'x' } },
        onOpenEntry,
        pullRequestUrl: 'https://example.com/pull/7',
      })
      const dialog = await waitFor(drawer)
      const refusal = within(dialog).getByTestId(`entry-changes-${kind}`)
      expect(textOf(refusal)).toContain(copy)
      expect(within(dialog).queryByRole('button', { name: 'Retry' })).toBeNull()
      expect(
        within(refusal)
          .getByRole('link', { name: 'Compare on the pull request (opens in a new tab)' })
          .getAttribute('href'),
      ).toBe('https://example.com/pull/7')
      // A 404 may be an entry the branch no longer has, so it offers only the pull request.
      const open = within(refusal).queryByRole('button', { name: 'Open the entry' })
      if (kind === 'notFound') {
        expect(open).toBeNull()
      } else {
        await userEvent.click(open as HTMLElement)
        expect(onOpenEntry).toHaveBeenCalled()
      }
    },
  )

  it('offers neither way out when there is none', async () => {
    renderDrawer({
      state: {
        ...loaded(sides(null, null)),
        data: undefined,
        error: { kind: 'notFound', message: 'x' },
      },
    })
    const refusal = within(await waitFor(drawer)).getByTestId('entry-changes-notFound')
    expect(within(refusal).queryByRole('button')).toBeNull()
    expect(within(refusal).queryByRole('link')).toBeNull()
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

describe('EntryChangesDrawer marks', () => {
  const card = async () => within(await waitFor(drawer)).getByTestId('entry-change-card')
  const one = (
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    extra: FieldConfig[] = [],
  ) =>
    renderDrawer({
      subject: { ...subject, fields: [...fields, ...extra] },
      state: loaded(sides(before, after)),
    })

  it('joins removed words split only by a space into one removal', async () => {
    one({ title: 'keep two three end' }, { title: 'keep 2 3 end' })
    const removals = (await card()).querySelectorAll('del')
    expect([...removals].map((d) => d.textContent)).toEqual(['Removed: two three, end of removal'])
  })

  it('names a mostly changed value once, up front, instead of run by run', async () => {
    one({ title: 'Alpha' }, { title: 'Omega' })
    const shown = await card()
    expect(textOf(shown)).toContain('Removed: Alpha')
    expect(textOf(shown)).not.toContain('end of removal')
  })

  it('shows a widened gap as the one space added, a mark said in words', async () => {
    one({ title: 'a b' }, { title: 'a  b' })
    const shown = await card()
    expect(shown.querySelector('del')).toBeNull()
    const inserted = shown.querySelectorAll('ins')
    expect([...inserted].map((i) => i.textContent)).toEqual(['Added: ·space, end of addition'])
    expect((inserted[0] as HTMLElement).style.textDecoration).toBe('none')
  })

  it('lines up a line diff in rows, an empty cell opposite a line the other side lacks', async () => {
    one({ notes: 'Start\nEnd' }, { notes: 'Start\nAdded one\nAdded two\nEnd' }, [
      { name: 'notes', type: 'markdown', label: 'Notes' },
    ])
    const grid = within(await card()).getByTestId('entry-change-line-grid')
    // Two column labels, then four cells (gutter and text a side) for each of the four rows.
    expect(grid.children).toHaveLength(2 + 4 * 4)
    const cells = [...grid.children].slice(2).map((cell) => cell.textContent)
    expect(cells.slice(4, 8)).toEqual(['', '', '+', 'Added line: Added one'])
    expect(within(await card()).queryByTestId('entry-change-line-list')).toBeNull()
    // An unchanged line is read once, from its Before cell.
    expect(grid.children[2 + 1].getAttribute('aria-hidden')).toBeNull()
    expect(grid.children[2 + 3].getAttribute('aria-hidden')).toBe('true')
  })

  it('renders one column, and no two-column grid, below md', async () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) =>
      ({
        matches: query.startsWith('(max-width:'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList) as typeof window.matchMedia
    try {
      one({ notes: 'Start\nEnd' }, { notes: 'Start\nAdded one\nEnd' }, [
        { name: 'notes', type: 'markdown', label: 'Notes' },
      ])
      const shown = await card()
      expect(within(shown).getByTestId('entry-change-line-list')).toBeTruthy()
      expect(within(shown).queryByTestId('entry-change-line-grid')).toBeNull()
    } finally {
      window.matchMedia = original
    }
  })

  it('shows a long run of added lines as its first 20 until asked', async () => {
    const inserted = Array.from({ length: 2000 }, (_, i) => `Inserted ${i + 1}`).join('\n')
    one({ notes: 'Start\nEnd' }, { notes: `Start\n${inserted}\nEnd` }, [
      { name: 'notes', type: 'markdown', label: 'Notes' },
    ])
    const grid = within(await card()).getByTestId('entry-change-line-grid')
    expect(grid.children.length / 4).toBeLessThan(500)
    expect(textOf(grid)).toContain('Inserted 20')
    expect(textOf(grid)).not.toContain('Inserted 21')
    await userEvent.click(within(grid).getByRole('button', { name: 'Show all 2000 added lines' }))
    expect(textOf(grid)).toContain('Inserted 2000')
  })

  it('says how a moved item moved, and counts moves apart from changed fields', async () => {
    const team: FieldConfig = {
      name: 'team',
      type: 'object',
      list: true,
      label: 'Team',
      fields: [{ name: 'name', type: 'string', label: 'Name' }],
    }
    const people = [
      { name: 'Ada', _key: 'k1' },
      { name: 'Grace', _key: 'k2' },
      { name: 'Linus', _key: 'k3' },
    ]
    one(
      { title: 'Hello', team: people },
      { title: 'Hello there', team: [people[1], people[0], people[2]] },
      [team],
    )
    const dialog = await waitFor(drawer)
    expect(textOf(within(dialog).getByTestId('entry-changes-summary'))).toBe(
      '1 field changed, 1 item moved since main',
    )
    const moved = within(dialog)
      .getAllByTestId('entry-change-card')
      .find((c) => textOf(c).includes('Moved from'))
    expect(textOf(moved ?? null)).toContain('Team › Ada')
    expect(textOf(moved ?? null)).toContain('Moved from 1st to 2nd of 3')
  })

  it('gives each card of a new entry an Added badge', async () => {
    one(null, { title: 'Hello', author: 'aaaaaaaaaaaa' })
    const cards = within(await waitFor(drawer)).getAllByTestId('entry-change-card')
    expect(cards.map((c) => textOf(c).includes('Added'))).toEqual([true, true])
  })

  it('collapses a long new body after 50 lines until asked', async () => {
    const body = Array.from({ length: 250 }, (_, i) => `Line ${i + 1}`).join('\n')
    one(null, { notes: body }, [{ name: 'notes', type: 'markdown', label: 'Notes' }])
    const shown = await card()
    expect(textOf(shown)).toContain('Line 50')
    expect(textOf(shown)).not.toContain('Line 51')
    await userEvent.click(within(shown).getByRole('button', { name: 'Show all 250 lines' }))
    expect(textOf(shown)).toContain('Line 250')
  })

  it('shows dates in full, the changed part marked, then relative', async () => {
    one({ publishedAt: '2026-01-02' }, { publishedAt: '2026-01-03' }, [
      { name: 'publishedAt', type: 'datetime', label: 'Published' },
    ])
    const shown = await card()
    const full = (day: number) =>
      new Date(2026, 0, day).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    expect(textOf(shown)).toContain(full(2).replace(/\s/g, ' ').split(' ')[0])
    expect(shown.querySelector('ins')).not.toBeNull()
    expect(shown.querySelector('del')).not.toBeNull()
  })
})

describe('EntryChangesDrawer blank lines and line breaks', () => {
  const notes: FieldConfig[] = [{ name: 'notes', type: 'markdown', label: 'Notes' }]
  const show = (before: string, after: string) =>
    renderDrawer({
      subject: { ...subject, fields: notes },
      state: loaded(sides({ notes: before }, { notes: after })),
    })

  it('shows a blank line as "(blank line)", seen and said alike', async () => {
    show('a\n\nb', 'a\nx\nb')
    const card = within(await waitFor(drawer)).getByTestId('entry-change-card')
    expect(card.querySelector('del')?.textContent).toContain('(blank line)')
  })

  it('says a line break was added at the end', async () => {
    show('a\nb', 'a\nb\n')
    const card = within(await waitFor(drawer)).getByTestId('entry-change-card')
    expect(textOf(card)).toContain('Line break added at the end')
  })
})
