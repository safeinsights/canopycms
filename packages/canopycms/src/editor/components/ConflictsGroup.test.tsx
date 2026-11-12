import React, { useState } from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EntryConflictChoice, EntryConflictData } from '../../api/merge-conflicts'
import { buildEntryConflicts, type FieldConflict } from '../conflict-cards'
import { textWithChoices, type EntryChoices, type FieldChoice } from '../conflict-choices'
import { CanopyCMSProvider } from '../theme'
import {
  ConflictsGroup,
  EDITED_IN_FORM_REASON,
  LATEST_UNPLACEABLE_REASON,
  type EntryChoiceRefusal,
  SAVE_FIRST_REASON,
  VERSION_LABELS,
  latestTooltip,
  type ConflictsGroupProps,
} from './ConflictsGroup'
import {
  BASE_SHA,
  MERGE_SHA,
  conflictFields,
  conflictRecordFields,
  entryConflictData,
  fieldsConflictData,
  savedValue,
} from './__test__/conflict-fixtures'

afterEach(() => cleanup())

type FieldName = keyof typeof conflictRecordFields
type FormValue = Record<string, unknown>

interface Options {
  only?: FieldName[]
  data?: EntryConflictData
  /** Adjusts the record's versions before the cards are built. */
  tweak?: (data: EntryConflictData) => void
  /** Your saved value as the cards are built from it, when it differs from the merge's. */
  builtFrom?: FormValue
  value?: FormValue
  choices?: EntryChoices
  /** Render without the open entry's form, as for another entry. */
  noForm?: boolean
  /** Whether a choice made is kept in `choices`, as the drawer does. */
  record?: boolean
  props?: Partial<ConflictsGroupProps>
}

/** Renders the group in a small harness that holds the form value and the choices. */
function renderGroup(options: Options = {}) {
  const data = options.data ?? fieldsConflictData(options.only)
  options.tweak?.(data)
  const conflicts = buildEntryConflicts(data, conflictFields, 'body', undefined, options.builtFrom)
  const held = { value: options.value ?? { ...savedValue } }
  const onChoose = vi.fn()
  const onEdit = vi.fn()
  const update = vi.fn()
  const Harness: React.FC = () => {
    const [value, setValue] = useState(held.value)
    const [choices, setChoices] = useState<EntryChoices>(options.choices ?? {})
    const form = {
      value,
      saved: options.builtFrom ?? savedValue,
      bodyField: 'body',
      update: (updater: (v: FormValue) => FormValue) => {
        update(updater)
        held.value = updater(held.value)
        setValue(held.value)
      },
    }
    return (
      <CanopyCMSProvider>
        <ConflictsGroup
          data={data}
          conflicts={conflicts}
          choices={choices}
          form={options.noForm ? undefined : form}
          onChoose={(field: FieldConflict, choice: FieldChoice | undefined, decided: boolean) => {
            onChoose(field, choice, decided)
            if (options.record === false) return
            setChoices((prev) => {
              const { [field.key]: _gone, ...rest } = prev
              return choice ? { ...rest, [field.key]: { mergeSha: field.mergeSha, choice } } : rest
            })
          }}
          onEdit={onEdit}
          {...options.props}
        />
      </CanopyCMSProvider>
    )
  }
  const view = render(<Harness />)
  return { ...view, held, onChoose, onEdit, update, conflicts, data }
}

/** The body as the merge left it with `regions` chosen. */
const bodyChosen = (regions: Parameters<typeof textWithChoices>[1]): string => {
  const text = buildEntryConflicts(fieldsConflictData(['body']), conflictFields, 'body').fields[0]
    .text
  if (!text) throw new Error('the body should merge by region')
  return textWithChoices(text, regions)
}

const headingOf = (card: HTMLElement): string =>
  within(card).getByRole('heading', { level: 4 }).textContent ?? ''

/** The cards whose heading starts with `start`. */
const cardsStarting = (start: string): HTMLElement[] =>
  screen.getAllByTestId('conflict-card').filter((c) => headingOf(c).startsWith(start))
const cardStarting = (start: string): HTMLElement => {
  const found = cardsStarting(start)
  expect(found).toHaveLength(1)
  return found[0]
}

/** The visible text of a card's action buttons, in order; the version labels are not actions. */
const actionsOf = (card: HTMLElement): string[] =>
  within(card)
    .queryAllByRole('button')
    .filter((b) => b.getAttribute('data-testid') !== 'conflict-version-label')
    .map((b) => b.textContent ?? '')

const actionButtons = () =>
  screen
    .queryAllByRole('button')
    .filter((b) => b.getAttribute('data-testid') !== 'conflict-version-label')

const SUMMARY = 'Summary was changed by you and by someone else'

const labelNamed = (card: HTMLElement, name: string): HTMLElement => {
  const found = within(card)
    .getAllByTestId('conflict-version-label')
    .find((l) => l.textContent?.startsWith(name))
  if (!found) throw new Error(`no "${name}" label`)
  return found
}

describe('ConflictsGroup cards', () => {
  it('names each kind of conflict in plain words and marks its kind', () => {
    renderGroup()
    const expected: Array<[string, string]> = [
      [SUMMARY, 'changed'],
      ['Hero › Heading was changed by you and by someone else', 'changed'],
      ['Read time was removed from the latest version, but you changed it', 'removed-on-base'],
      ['You removed Tagline, but it was changed in the latest version', 'removed-by-you'],
      ['Steps › Configure was removed from the latest version, but you changed it', 'item'],
      ['Cover image was changed by you and by someone else', 'changed'],
      ['Body (part 1 of 2) was changed by you and by someone else', 'region'],
      ['Body (part 2 of 2) was changed by you and by someone else', 'region'],
      ["This entry's URL was changed by you and by someone else", 'location'],
    ]
    const cards = screen.getAllByTestId('conflict-card')
    expect(cards.map((c) => [headingOf(c), c.getAttribute('data-conflict-kind')])).toEqual(expected)
  })

  it('names each entry-level conflict and marks its kind', () => {
    const kinds = {
      'deleted-on-base': 'This entry was deleted in the latest version, but you changed it',
      'deleted-on-branch': 'You deleted this entry, but it was changed in the latest version',
      unreadable:
        "This entry was changed by you and by someone else in a way that can't be compared field by field",
    } as const
    for (const [kind, heading] of Object.entries(kinds) as Array<[keyof typeof kinds, string]>) {
      const view = renderGroup({ data: entryConflictData(kind) })
      const card = screen.getByTestId('conflict-card')
      expect(headingOf(card)).toBe(heading)
      expect(card.getAttribute('data-conflict-kind')).toBe(kind)
      view.unmount()
    }
  })

  it('shows the Before, Latest version and Your version labels on a value card', () => {
    renderGroup({ only: ['summary'] })
    const labels = within(screen.getByTestId('conflict-card')).getAllByTestId(
      'conflict-version-label',
    )
    expect(labels.map((l) => l.textContent)).toEqual(['Before', 'Latest version', 'Your version'])
  })

  const labelCases = (['before', 'latest', 'yours'] as const).flatMap((which) =>
    (['hover', 'focus'] as const).map((how) => [which, how] as const),
  )
  it.each(labelCases)("opens the %s label's Tooltip on %s", async (which, how) => {
    renderGroup({ only: ['summary'] })
    const label = labelNamed(screen.getByTestId('conflict-card'), VERSION_LABELS[which].label)
    if (how === 'hover') await userEvent.hover(label)
    else act(() => label.focus())
    const tip = await screen.findByRole('tooltip')
    expect(tip.textContent).toBe(VERSION_LABELS[which].tooltip)
  })

  it('never names a branch to someone who is not an admin, not even in the Tooltip', async () => {
    renderGroup()
    const text = () => document.body.textContent ?? ''
    expect(text()).not.toMatch(/\bmain\b/)
    expect(text()).not.toContain('(from')
    act(() => labelNamed(cardStarting(SUMMARY), 'Latest version').focus())
    const tip = await screen.findByRole('tooltip')
    expect(tip.textContent).toBe(VERSION_LABELS.latest.tooltip)
    expect(text()).not.toMatch(/\bmain\b/)
    expect(text()).not.toContain('(from')
  })

  it('names the branch the latest version comes from to an admin', async () => {
    renderGroup({ only: ['summary'], props: { adminBaseBranch: 'main' } })
    act(() => labelNamed(screen.getByTestId('conflict-card'), 'Latest version').focus())
    const tip = await screen.findByRole('tooltip')
    expect(tip.textContent).toBe(latestTooltip('main'))
    expect(tip.textContent).toContain('It comes from main.')
  })
})

describe('ConflictsGroup buttons', () => {
  it('offers a changed value the latest version, yours and Edit', () => {
    renderGroup()
    expect(actionsOf(cardStarting(SUMMARY))).toEqual([
      'Use latest version',
      'Keep your version',
      'Edit',
    ])
    expect(
      screen.getByRole('button', {
        name: `Use latest version: ${SUMMARY}`,
      }),
    ).toBeTruthy()
    expect(actionsOf(cardStarting('Cover image'))).toEqual([
      'Use latest version',
      'Keep your version',
      'Edit',
    ])
  })

  it('offers a value the latest version removed "Remove it" before "Keep it", and Copy', () => {
    renderGroup()
    const card = cardStarting('Read time was removed')
    expect(actionsOf(card)).toEqual(['Remove it', 'Keep it', 'Copy'])
    expect(within(card).getByRole('button', { name: /^Copy your version: Read time/ })).toBeTruthy()
  })

  it('offers a value you removed "Remove it" and "Keep it" only', () => {
    renderGroup()
    expect(actionsOf(cardStarting('You removed Tagline'))).toEqual(['Remove it', 'Keep it'])
  })

  it('offers a list item "Remove it" and "Keep it", never Edit', () => {
    renderGroup()
    const actions = actionsOf(cardStarting('Steps › Configure'))
    expect(actions.slice(0, 2)).toEqual(['Remove it', 'Keep it'])
    expect(actions).not.toContain('Edit')
  })

  it('offers a body region both versions, Use both, Edit, and a preview of Use both', () => {
    renderGroup()
    for (const part of ['1', '2']) {
      expect(actionsOf(cardStarting(`Body (part ${part} of 2)`))).toEqual([
        'Preview "Use both"',
        'Use latest version',
        'Keep your version',
        'Use both',
        'Edit',
      ])
    }
  })

  it('previews "Use both" with the latest lines, then yours', async () => {
    renderGroup({ only: ['body'] })
    const card = cardStarting('Body (part 1 of 2)')
    expect(within(card).queryByTestId('conflict-use-both-preview')).toBeNull()
    await userEvent.click(within(card).getByRole('button', { name: 'Preview "Use both"' }))
    const text = within(card).getByTestId('conflict-use-both-preview').textContent ?? ''
    const latest = text.indexOf('Install the package with pnpm first.')
    const yours = text.indexOf('Install the package and its peers first.')
    expect(latest).toBeGreaterThan(-1)
    expect(yours).toBeGreaterThan(latest)
    await userEvent.click(within(card).getByRole('button', { name: 'Hide "Use both" preview' }))
    expect(within(card).queryByTestId('conflict-use-both-preview')).toBeNull()
  })

  it('offers the entry URL conflict only "Keep your version"', () => {
    renderGroup()
    expect(actionsOf(cardStarting("This entry's URL"))).toEqual(['Keep your version'])
  })
})

describe('ConflictsGroup choosing', () => {
  const clickIn = (card: HTMLElement, name: RegExp | string) =>
    userEvent.click(within(card).getByRole('button', { name }))

  it('takes the latest version of a changed value into the form', async () => {
    const { onChoose, held, conflicts } = renderGroup()
    await clickIn(cardStarting(SUMMARY), /^Use latest version:/)
    expect(onChoose).toHaveBeenCalledTimes(1)
    expect(onChoose).toHaveBeenCalledWith(
      conflicts.fields.find((f) => f.key === 'summary'),
      { how: 'latest' },
      true,
    )
    expect(held.value.summary).toBe('How to begin editing.')
  })

  it('keeps your version of a changed value, leaving the form as it is', async () => {
    const { onChoose, held, update } = renderGroup()
    await clickIn(cardStarting(SUMMARY), /^Keep your version:/)
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'summary' }),
      { how: 'yours' },
      true,
    )
    expect(update).not.toHaveBeenCalled()
    expect(held.value).toEqual(savedValue)
  })

  it('removes a value the latest version removed', async () => {
    const { onChoose, held } = renderGroup()
    expect(held.value.readTime).toBe(6)
    await clickIn(cardStarting('Read time was removed'), /^Remove it:/)
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'readTime' }),
      { how: 'latest' },
      true,
    )
    expect(held.value.readTime).toBeUndefined()
  })

  it('brings back a value you removed that the latest version changed', async () => {
    const { onChoose, held } = renderGroup()
    expect(held.value.tagline).toBeUndefined()
    await clickIn(cardStarting('You removed Tagline'), /^Keep it:/)
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'tagline' }),
      { how: 'latest' },
      true,
    )
    expect(held.value.tagline).toBe('Start here today')
  })

  it('removes a list item the latest version removed', async () => {
    const { held } = renderGroup()
    const keys = (v: FormValue) => (v.steps as Array<{ _key: string }>).map((s) => s._key)
    expect(keys(held.value)).toEqual(['k1', 'k2'])
    await clickIn(cardStarting('Steps › Configure'), /^Remove it:/)
    expect(keys(held.value)).toEqual(['k1'])
  })

  it('leaves a body region undecided until every region is chosen', async () => {
    const { onChoose, held } = renderGroup({ only: ['body'] })
    await clickIn(cardStarting('Body (part 1 of 2)'), /^Use latest version:/)
    expect(onChoose).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'body' }),
      { how: 'regions', regions: { 0: 'latest' } },
      false,
    )
    const body = held.value.body as string
    expect(body).toContain('Install the package with pnpm first.')
    expect(body).not.toContain('and its peers')
    expect(body).toContain('Ask for help on the issue tracker.')

    await clickIn(cardStarting('Body (part 2 of 2)'), /^Use latest version:/)
    expect(onChoose).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'body' }),
      { how: 'regions', regions: { 0: 'latest', 1: 'latest' } },
      true,
    )
    expect(held.value.body).toContain('Ask for help in the chat.')
  })

  it('opens a region for editing after "Use both", the latest lines first', async () => {
    const { onEdit, held } = renderGroup({ only: ['body'] })
    await clickIn(cardStarting('Body (part 1 of 2)'), /^Use both:/)
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ key: 'body' }))
    expect(held.value.body).toContain(
      'Install the package with pnpm first.\nInstall the package and its peers first.',
    )
  })

  it('opens the field for editing from Edit', async () => {
    const { onEdit, onChoose } = renderGroup({ only: ['summary'] })
    await clickIn(screen.getByTestId('conflict-card'), /^Edit:/)
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ key: 'summary' }))
    expect(onChoose).not.toHaveBeenCalled()
  })

  it('says the form was edited and offers "Mark resolved" in place of keeping yours', async () => {
    const { onChoose } = renderGroup({
      only: ['summary'],
      value: { ...savedValue, summary: 'My own wording.' },
    })
    const card = screen.getByTestId('conflict-card')
    expect(actionsOf(card)).toEqual(['Use latest version', 'Mark resolved', 'Edit'])
    const latest = within(card).getByRole('button', { name: /^Use latest version:/ })
    expect(latest.getAttribute('aria-disabled')).toBe('true')
    await userEvent.hover(latest)
    expect((await screen.findByRole('tooltip')).textContent).toBe(EDITED_IN_FORM_REASON)
    await userEvent.click(latest)
    expect(onChoose).not.toHaveBeenCalled()
    await userEvent.click(within(card).getByRole('button', { name: /^Mark resolved:/ }))
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'summary' }),
      { how: 'edited' },
      true,
    )
  })

  it('shows what was chosen and takes the latest version back out on "Choose again"', async () => {
    const { onChoose, held } = renderGroup({ only: ['summary'] })
    const card = screen.getByTestId('conflict-card')
    expect(within(card).queryByTestId('conflict-choice-note')).toBeNull()
    await clickIn(card, /^Use latest version:/)
    expect(within(card).getByTestId('conflict-choice-note').textContent).toContain(
      'Using the latest version. Save to keep this choice.',
    )
    expect(actionsOf(card)).toEqual(['Choose again'])
    expect(held.value.summary).toBe('How to begin editing.')

    await clickIn(card, /^Choose again:/)
    expect(onChoose).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'summary' }),
      undefined,
      false,
    )
    expect(held.value.summary).toBe('A guide to your first edit.')
    expect(within(card).queryByTestId('conflict-choice-note')).toBeNull()
  })

  it('turns a choice the form was edited away from into the edit, marked resolved', async () => {
    const { onChoose, held } = renderGroup({
      only: ['summary'],
      value: { ...savedValue, summary: 'My own wording.' },
      choices: { summary: { mergeSha: MERGE_SHA, choice: { how: 'latest' } } },
    })
    await waitFor(() =>
      expect(onChoose).toHaveBeenLastCalledWith(
        expect.objectContaining({ key: 'summary' }),
        { how: 'edited' },
        true,
      ),
    )
    expect(screen.getByTestId('conflict-choice-note').textContent).toBe(
      'Marked resolved. Save to keep this choice.',
    )
    expect(held.value.summary).toBe('My own wording.')
  })

  it('keeps every choice as made while locked, though the form shows the saved value', () => {
    const { onChoose } = renderGroup({
      only: ['summary'],
      choices: { summary: { mergeSha: MERGE_SHA, choice: { how: 'latest' } } },
      props: { lockedReason: 'This branch is in review. Withdraw it to make changes.' },
    })
    expect(onChoose).not.toHaveBeenCalled()
    expect(screen.getByTestId('conflict-choice-note').textContent).toBe(
      'Using the latest version. Save to keep this choice.',
    )
  })

  it('says each kind of choice in its note', async () => {
    renderGroup({ only: ['readTime', 'tagline', 'location'] })
    await clickIn(cardStarting('Read time was removed'), /^Remove it:/)
    await clickIn(cardStarting('You removed Tagline'), /^Keep it:/)
    await clickIn(cardStarting("This entry's URL"), /^Keep your version:/)
    const notes = screen.getAllByTestId('conflict-choice-note').map((n) => n.textContent)
    expect(notes).toEqual([
      'Removing it. Save to keep this choice.',
      'Keeping it. Save to keep this choice.',
      'Keeping your version. Save to keep this choice.',
    ])
  })

  it('records the first region choice taken back without losing the other', async () => {
    const { onChoose } = renderGroup({
      only: ['body'],
      choices: {
        body: {
          mergeSha: MERGE_SHA,
          choice: { how: 'regions', regions: { 0: 'latest', 1: 'yours' } },
        },
      },
      // The form holds what those choices wrote.
      value: { ...savedValue, body: bodyChosen({ 0: 'latest', 1: 'yours' }) },
      record: false,
    })
    await clickIn(cardStarting('Body (part 2 of 2)'), /^Choose again:/)
    expect(onChoose).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'body' }),
      { how: 'regions', regions: { 0: 'latest' } },
      false,
    )
  })
})

describe('ConflictsGroup states', () => {
  it('keeps the buttons when the branch is locked, disabled with the reason', async () => {
    const reason = 'This branch is in review. Withdraw it to make changes.'
    const { onChoose } = renderGroup({ only: ['summary'], props: { lockedReason: reason } })
    const card = screen.getByTestId('conflict-card')
    const buttons = within(card)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-testid') !== 'conflict-version-label')
    expect(buttons).toHaveLength(3)
    for (const b of buttons) expect(b.getAttribute('aria-disabled')).toBe('true')
    await userEvent.hover(buttons[0])
    expect((await screen.findByRole('tooltip')).textContent).toBe(reason)
    await userEvent.click(buttons[0])
    expect(onChoose).not.toHaveBeenCalled()
  })

  it('hides every button and says why when the user cannot edit', () => {
    const reason = "You don't have edit access to this entry."
    renderGroup({ props: { noEditReason: reason } })
    expect(screen.getAllByTestId('conflict-card').length).toBeGreaterThan(0)
    expect(actionButtons()).toHaveLength(0)
    expect(screen.getByTestId('conflicts-no-edit').textContent).toBe(reason)
  })

  it("says to open the entry, with no buttons, when the form is another entry's", () => {
    renderGroup({ noForm: true })
    expect(screen.getByTestId('conflicts-open-to-choose').textContent).toBe(
      'Open this entry to choose.',
    )
    expect(actionButtons()).toHaveLength(0)
  })

  it('counts the conflicts left to choose for a screen reader, as they are decided', async () => {
    renderGroup({ only: ['summary', 'heading'] })
    const live = screen.getByTestId('conflicts-left')
    expect(live.getAttribute('role')).toBe('status')
    expect(live.textContent).toBe('2 fields left to choose.')
    await userEvent.click(
      within(cardStarting(SUMMARY)).getByRole('button', { name: /^Keep your version:/ }),
    )
    expect(live.textContent).toBe('1 field left to choose.')
    await userEvent.click(
      within(cardStarting('Hero')).getByRole('button', { name: /^Keep your version:/ }),
    )
    expect(live.textContent).toBe('All chosen. Save to keep your choices.')
  })

  it('does not count a body as chosen until every region is', async () => {
    renderGroup({ only: ['body'] })
    const live = screen.getByTestId('conflicts-left')
    expect(live.textContent).toBe('1 field left to choose.')
    await userEvent.click(
      within(cardStarting('Body (part 1 of 2)')).getByRole('button', {
        name: /^Keep your version:/,
      }),
    )
    expect(live.textContent).toBe('1 field left to choose.')
  })
})

describe('ConflictsGroup entry-level conflicts', () => {
  const cases: Array<
    [Exclude<EntryConflictData['kind'], 'fields'>, Array<[string, EntryConflictChoice]>]
  > = [
    [
      'deleted-on-base',
      [
        ['Keep it', 'keep'],
        ['Delete entry', 'delete'],
      ],
    ],
    [
      'deleted-on-branch',
      [
        ['Restore entry', 'restore'],
        ['Keep it deleted', 'keep'],
      ],
    ],
    [
      'unreadable',
      [
        ['Use latest version', 'use-latest'],
        ['Keep your version', 'keep'],
      ],
    ],
  ]

  const setup = (
    kind: (typeof cases)[number][0],
    props: Partial<ConflictsGroupProps> = {},
    answer: EntryChoiceRefusal | undefined = undefined,
  ) => {
    const onResolveEntry = vi.fn(async (_choice: EntryConflictChoice) => answer)
    const view = renderGroup({ data: entryConflictData(kind), props: { onResolveEntry, ...props } })
    return { ...view, onResolveEntry }
  }

  it.each(cases)('offers a %s entry its choices, in order', (kind, choices) => {
    setup(kind)
    expect(actionsOf(screen.getByTestId('conflict-card'))).toEqual(choices.map(([label]) => label))
  })

  it.each(cases)('settles a %s entry through onResolveEntry', async (kind, choices) => {
    const { onResolveEntry } = setup(kind)
    for (const [label, choice] of choices) {
      onResolveEntry.mockClear()
      await userEvent.click(screen.getByRole('button', { name: label }))
      expect(onResolveEntry).toHaveBeenCalledTimes(1)
      expect(onResolveEntry).toHaveBeenCalledWith(choice)
    }
  })

  it('shows why the API refused a choice', async () => {
    const message = 'Another entry now has this URL. Change it, then restore this one.'
    setup('deleted-on-branch', {}, { message, tone: 'warning' })
    expect(screen.queryByTestId('conflict-entry-refused')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Restore entry' }))
    const refused = await screen.findByTestId('conflict-entry-refused')
    expect(refused.textContent).toBe(message)
    expect(within(refused).queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('offers Retry only for an error, and Retry runs the same choice again', async () => {
    const { onResolveEntry } = setup('deleted-on-branch')
    onResolveEntry.mockResolvedValueOnce({ message: 'The save failed.', tone: 'error' })
    await userEvent.click(screen.getByRole('button', { name: 'Restore entry' }))
    const refused = await screen.findByTestId('conflict-entry-refused')
    expect(refused.textContent).toContain('The save failed.')
    expect(onResolveEntry).toHaveBeenCalledTimes(1)
    await userEvent.click(within(refused).getByRole('button', { name: 'Retry' }))
    expect(onResolveEntry).toHaveBeenCalledTimes(2)
    expect(onResolveEntry).toHaveBeenLastCalledWith('restore')
    await waitFor(() => expect(screen.queryByTestId('conflict-entry-refused')).toBeNull())
  })

  it('holds every choice that rewrites the entry while it has unsaved edits, but not keeping it', async () => {
    const { onResolveEntry } = setup('deleted-on-base', { unsavedEdits: true })
    const keep = screen.getByRole('button', { name: 'Keep it' })
    const del = screen.getByRole('button', { name: 'Delete entry' })
    expect(del.getAttribute('aria-disabled')).toBe('true')
    expect(keep.getAttribute('aria-disabled')).toBeNull()
    await userEvent.hover(del)
    expect((await screen.findByRole('tooltip')).textContent).toBe(SAVE_FIRST_REASON)
    await userEvent.click(del)
    expect(onResolveEntry).not.toHaveBeenCalled()
    await userEvent.click(keep)
    expect(onResolveEntry).toHaveBeenCalledWith('keep')
  })

  it('holds "Use latest version" on an unreadable entry with unsaved edits', async () => {
    const { onResolveEntry } = setup('unreadable', { unsavedEdits: true })
    const latest = screen.getByRole('button', { name: 'Use latest version' })
    expect(latest.getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(latest)
    expect(onResolveEntry).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: 'Keep your version' }).getAttribute('aria-disabled'),
    ).toBeNull()
  })

  it('hides the choices from a user who cannot edit', async () => {
    setup('deleted-on-base', { noEditReason: 'No edit access.' })
    await waitFor(() => expect(screen.getByTestId('conflicts-no-edit')).toBeTruthy())
    expect(actionButtons()).toHaveLength(0)
  })
})

describe('ConflictsGroup summary', () => {
  it('counts the fields changed by both sides', () => {
    renderGroup({ only: ['summary', 'body'] })
    expect(screen.getByTestId('conflicts-summary').textContent).toBe(
      '2 fields changed by you and by someone else. Choose what to keep, then save.',
    )
  })
})

describe('ConflictsGroup when the latest version cannot be placed', () => {
  const unreadable = (data: EntryConflictData) => {
    data.versions[BASE_SHA] = { unavailable: 'too-large' }
  }

  it('disables the choices that take the latest version, saying why, and keeps the others', async () => {
    const { onChoose, onEdit } = renderGroup({ only: ['summary'], tweak: unreadable })
    const card = screen.getByTestId('conflict-card')
    const latest = within(card).getByRole('button', { name: /^Use latest version:/ })
    expect(latest.getAttribute('aria-disabled')).toBe('true')
    await userEvent.hover(latest)
    expect((await screen.findByRole('tooltip')).textContent).toBe(LATEST_UNPLACEABLE_REASON)
    await userEvent.click(latest)
    expect(onChoose).not.toHaveBeenCalled()

    const keep = within(card).getByRole('button', { name: /^Keep your version:/ })
    expect(keep.getAttribute('aria-disabled')).toBeNull()
    await userEvent.click(within(card).getByRole('button', { name: /^Edit:/ }))
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ key: 'summary' }))
    await userEvent.click(keep)
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'summary' }),
      { how: 'yours' },
      true,
    )
  })

  it("says the latest version can't be shown where it could not be read", () => {
    renderGroup({ only: ['summary'], tweak: unreadable })
    expect(
      within(screen.getByTestId('conflict-latest')).getByTestId('conflict-latest-unavailable')
        .textContent,
    ).toBe("Can't be shown here")
  })

  it('shows no such note while the latest version can be read', () => {
    renderGroup({ only: ['summary'] })
    expect(screen.queryByTestId('conflict-latest-unavailable')).toBeNull()
  })

  it('disables "Remove it" and "Keep it" where they map to the latest version', () => {
    renderGroup({ only: ['readTime', 'tagline'], tweak: unreadable })
    const read = cardStarting('Read time was removed')
    const tag = cardStarting('You removed Tagline')
    const button = (card: HTMLElement, name: RegExp) => within(card).getByRole('button', { name })
    expect(button(read, /^Remove it:/).getAttribute('aria-disabled')).toBe('true')
    expect(button(read, /^Keep it:/).getAttribute('aria-disabled')).toBeNull()
    expect(button(tag, /^Keep it:/).getAttribute('aria-disabled')).toBe('true')
    expect(button(tag, /^Remove it:/).getAttribute('aria-disabled')).toBeNull()
  })

  it('leaves "Remove it" on a removed list item enabled while the latest version is readable', () => {
    renderGroup({ only: ['step'] })
    const remove = within(screen.getByTestId('conflict-card')).getByRole('button', {
      name: /^Remove it:/,
    })
    expect(remove.getAttribute('aria-disabled')).toBeNull()
  })
})

describe('ConflictsGroup text saved since the merge', () => {
  it('shows a body as one whole value, with no "Use both", once its text was saved since', () => {
    const saved = { ...savedValue, body: `${savedValue.body as string}Typed since.\n` }
    renderGroup({ only: ['body'], builtFrom: saved, value: saved })
    const cards = screen.getAllByTestId('conflict-card')
    expect(cards).toHaveLength(1)
    expect(headingOf(cards[0])).toBe('Body was changed by you and by someone else')
    expect(cards[0].getAttribute('data-conflict-kind')).toBe('changed')
    expect(actionsOf(cards[0])).toEqual(['Use latest version', 'Keep your version', 'Edit'])
  })

  it("shows regions while the saved text is the merge's", () => {
    renderGroup({ only: ['body'], builtFrom: savedValue })
    expect(screen.getAllByTestId('conflict-card')).toHaveLength(2)
  })
})

describe('round 2 review', () => {
  const click = (card: HTMLElement, name: RegExp) =>
    userEvent.click(within(card).getByRole('button', { name }))

  it('keeps a hand edit marked resolved when the choice is taken back', async () => {
    const { held } = renderGroup({
      only: ['summary'],
      value: { ...savedValue, summary: 'My own wording.' },
    })
    const card = screen.getByTestId('conflict-card')
    await click(card, /^Mark resolved:/)
    await click(card, /^Choose again:/)
    expect(held.value.summary).toBe('My own wording.')
  })

  it('keeps a body edited by hand when "Mark resolved" on a region is taken back', async () => {
    const edited = String(savedValue.body).replace('Middle paragraph', 'My middle paragraph')
    const { held } = renderGroup({ only: ['body'], value: { ...savedValue, body: edited } })
    await click(screen.getAllByTestId('conflict-card')[0], /^Mark resolved:/)
    await click(screen.getAllByTestId('conflict-card')[0], /^Choose again:/)
    expect(held.value.body).toBe(edited)
  })

  it('offers "Mark resolved", not "Keep it", once your side was edited by hand', () => {
    const steps = (savedValue.steps as Array<Record<string, unknown>>).filter(
      (s) => s._key !== 'k2',
    )
    renderGroup({ only: ['step'], value: { ...savedValue, steps } })
    const card = screen.getByTestId('conflict-card')
    expect(within(card).queryByRole('button', { name: /^Keep it:/ })).toBeNull()
    expect(within(card).getByRole('button', { name: /^Mark resolved:/ })).toBeTruthy()
  })

  it('stands no region choice on text that now shows whole', () => {
    const first = buildEntryConflicts(
      fieldsConflictData(['body']),
      conflictFields,
      'body',
      undefined,
      savedValue,
    ).fields[0]
    if (!first.text) throw new Error('the body should merge by region')
    const saved = { ...savedValue, body: textWithChoices(first.text, { 0: 'latest' }) }
    renderGroup({
      only: ['body'],
      builtFrom: saved,
      value: saved,
      choices: {
        body: { mergeSha: MERGE_SHA, choice: { how: 'regions', regions: { 0: 'latest' } } },
      },
    })
    const card = screen.getByTestId('conflict-card')
    expect(screen.queryByTestId('conflict-choice-note')).toBeNull()
    expect(within(card).getByRole('button', { name: /^Keep your version:/ })).toBeTruthy()
  })
})
