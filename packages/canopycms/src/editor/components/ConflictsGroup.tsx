'use client'

/**
 * The "Conflicts" group at the top of "Show changes": one card per place both you and someone else
 * changed since you started the branch, showing how it read before, in the latest version and in
 * yours, and the choices that settle it. A field's choice is an unsaved edit that the entry's next
 * save resolves (conflict-choices.ts); an entry-level choice acts at once, through the API.
 * Authors never see a branch name here; an admin's Tooltip names the branch the latest version
 * comes from.
 */

import React, { useEffect, useId, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CopyButton,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  VisuallyHidden,
} from '@mantine/core'
import { IconAlertCircle, IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react'

import type { EntryConflictChoice, EntryConflictData } from '../../api/merge-conflicts'
import type { ConflictCard, EntryConflicts, FieldConflict } from '../conflict-cards'
import {
  holdsChoice,
  isDecided,
  withLatest,
  withRegions,
  withYours,
  type EntryChoices,
  type FieldChoice,
  type RegionChoice,
} from '../conflict-choices'
import { EDITOR_ACTIONS } from '../copy'
import type { DisplayValue, TextDiff } from '../entry-diff'
import { MarkedText, ReasonedButton, TEXT_STYLE, Value, plural } from './change-parts'
import { UnsavedMark } from './UnsavedMark'

type FormValue = Record<string, unknown>

/**
 * The three versions a card shows, each label with the Tooltip that says what it is.
 * @internal Exported for tests.
 */
export const VERSION_LABELS = {
  before: {
    label: 'Before',
    tooltip: 'How this field read when you started this branch.',
  },
  latest: {
    label: 'Latest version',
    tooltip:
      "How it reads now on the site's shared copy, changed since you started (by another person's approved changes or a developer).",
  },
  yours: {
    label: 'Your version',
    tooltip: 'Your change on this branch.',
  },
} as const

/**
 * The latest version's Tooltip; an admin also learns which branch it comes from.
 * @internal Exported for tests.
 */
export const latestTooltip = (adminBaseBranch: string | undefined): string =>
  adminBaseBranch
    ? `${VERSION_LABELS.latest.tooltip} It comes from ${adminBaseBranch}.`
    : VERSION_LABELS.latest.tooltip

const CHOICE_NOTES: Record<FieldChoice['how'] | 'remove' | 'keep', string> = {
  latest: 'Using the latest version. Save to keep this choice.',
  yours: 'Keeping your version. Save to keep this choice.',
  edited: 'Marked resolved. Save to keep this choice.',
  regions: 'Chosen. Save to keep this choice.',
  remove: 'Removing it. Save to keep this choice.',
  keep: 'Keeping it. Save to keep this choice.',
}

const REGION_NOTES: Record<RegionChoice, string> = {
  latest: 'Using the latest version here.',
  yours: 'Keeping your version here.',
  both: 'Using both here: the latest version, then yours.',
}

/**
 * Why a choice can't replace what the form holds: an edit made since, which it would lose.
 * @internal Exported for tests.
 */
export const EDITED_IN_FORM_REASON =
  'You\'ve edited this in the form. Choose "Mark resolved" to keep your edit.'
const EDITED_IN_FORM = 'Edited in the form.'
/**
 * Why an entry-level choice that rewrites the entry waits: it would replace unsaved edits.
 * @internal Exported for tests.
 */
export const SAVE_FIRST_REASON = "Save or discard this entry's unsaved changes first."
const OPEN_TO_CHOOSE = 'Open this entry to choose.'
/**
 * Why a choice that takes the latest version can't: it couldn't be read, or its list items on the
 * way to the place can't be matched to the ones the merge named.
 * @internal Exported for tests.
 */
export const LATEST_UNPLACEABLE_REASON =
  'The latest version of this can\'t be found here. Use "Edit" to change it by hand, then "Mark resolved".'
const LATEST_UNAVAILABLE = "Can't be shown here"

/**
 * A card's heading: where, and what happened there, in plain words.
 * @internal Exported for tests.
 */
export function conflictHeading(card: ConflictCard): string {
  if (card.type === 'location') return "This entry's URL was changed by you and by someone else"
  const where = card.path.join(' › ')
  const part =
    card.type === 'region' && card.count > 1 ? ` (part ${card.index + 1} of ${card.count})` : ''
  if (card.type === 'value' && card.conflict === 'removed-on-base') {
    return `${where} was removed from the latest version, but you changed it`
  }
  if (card.type === 'value' && card.conflict === 'removed-by-you') {
    return `You removed ${where}, but it was changed in the latest version`
  }
  return `${where}${part} was changed by you and by someone else`
}

/** What an entry-level conflict is, and the choices that settle it, in order. */
const ENTRY_KINDS: Record<
  Exclude<EntryConflictData['kind'], 'fields'>,
  { heading: string; choices: Array<{ choice: EntryConflictChoice; label: string; danger?: true }> }
> = {
  'deleted-on-base': {
    heading: 'This entry was deleted in the latest version, but you changed it',
    choices: [
      { choice: 'keep', label: EDITOR_ACTIONS.keepIt },
      { choice: 'delete', label: EDITOR_ACTIONS.deleteEntry, danger: true },
    ],
  },
  'deleted-on-branch': {
    heading: 'You deleted this entry, but it was changed in the latest version',
    choices: [
      { choice: 'restore', label: EDITOR_ACTIONS.restoreEntry },
      { choice: 'keep', label: EDITOR_ACTIONS.keepItDeleted },
    ],
  },
  unreadable: {
    heading:
      "This entry was changed by you and by someone else in a way that can't be compared field by field",
    choices: [
      { choice: 'use-latest', label: EDITOR_ACTIONS.useLatestVersion },
      { choice: 'keep', label: EDITOR_ACTIONS.keepYourVersion },
    ],
  },
}

/** The text a value can be copied as; undefined for one with no plain text, such as an image. */
const copyTextOf = (value: DisplayValue): string | undefined => {
  switch (value.kind) {
    case 'text':
    case 'raw':
      return value.text
    case 'date':
      return value.text
    case 'number':
      return String(value.value)
    case 'select':
      return value.label
    default:
      return undefined
  }
}

/** A version's label, its Tooltip opening on hover, focus and touch, and said to a screen reader. */
const VersionLabel: React.FC<{ label: string; tooltip: string }> = ({ label, tooltip }) => {
  const id = useId()
  return (
    <Group gap={4} wrap="nowrap">
      <Tooltip
        label={tooltip}
        multiline
        maw={280}
        events={{ hover: true, focus: true, touch: true }}
      >
        <UnstyledButton
          aria-describedby={id}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          data-testid="conflict-version-label"
        >
          <Text size="xs" c="dimmed" span>
            {label}
          </Text>
          <IconInfoCircle size={12} aria-hidden style={{ color: 'var(--mantine-color-dimmed)' }} />
        </UnstyledButton>
      </Tooltip>
      <VisuallyHidden id={id}>{tooltip}</VisuallyHidden>
    </Group>
  )
}

/** One side of a line diff: its lines, the changed runs marked. */
const SideLines: React.FC<{ text: Extract<TextDiff, { mode: 'lines' }> }> = ({ text }) => (
  <Stack gap={0}>
    {text.rows.map((row, i) => {
      if (row.kind === 'skipped') {
        return (
          <Text key={i} size="xs" c="dimmed">
            {plural(row.count, 'unchanged line', 'unchanged lines')}
          </Text>
        )
      }
      if (row.kind === 'same') {
        return (
          <Text key={i} size="sm" style={TEXT_STYLE}>
            {row.text || ' '}
          </Text>
        )
      }
      if (!row.after) return null
      return (
        <Text key={i} size="sm" style={TEXT_STYLE}>
          <MarkedText parts={row.after} side="after" unit="line" />
        </Text>
      )
    })}
  </Stack>
)

/** A version's value, marked against Before where it changed text. */
const VersionValue: React.FC<{
  value: DisplayValue | string
  marks?: TextDiff
  /** The value couldn't be found, so none shows. */
  unavailable?: boolean
}> = ({ value, marks, unavailable }) => {
  if (unavailable) {
    return (
      <Text size="sm" c="dimmed" data-testid="conflict-latest-unavailable">
        {LATEST_UNAVAILABLE}
      </Text>
    )
  }
  if (marks?.mode === 'words') {
    return (
      <Text size="sm" style={TEXT_STYLE}>
        <MarkedText parts={marks.parts} side="after" unit="text" />
      </Text>
    )
  }
  if (marks?.mode === 'lines') return <SideLines text={marks} />
  if (typeof value === 'string') {
    return value === '' ? (
      <Text size="sm" c="dimmed">
        No lines
      </Text>
    ) : (
      <Text size="sm" style={TEXT_STYLE}>
        {value}
      </Text>
    )
  }
  return <Value value={value} />
}

const Versions: React.FC<{
  card: Exclude<ConflictCard, { type: 'location' }>
  adminBaseBranch?: string
}> = ({ card, adminBaseBranch }) => (
  <SimpleGrid cols={{ base: 1, md: 3 }} spacing="sm">
    <Stack gap={4} miw={0} data-testid="conflict-before">
      <VersionLabel {...VERSION_LABELS.before} />
      <VersionValue value={card.before} />
    </Stack>
    <Stack gap={4} miw={0} data-testid="conflict-latest">
      <VersionLabel label={VERSION_LABELS.latest.label} tooltip={latestTooltip(adminBaseBranch)} />
      <VersionValue
        value={card.latest}
        marks={card.latestText}
        unavailable={card.type === 'value' && card.latestUnavailable}
      />
    </Stack>
    <Stack gap={4} miw={0} data-testid="conflict-yours">
      <VersionLabel {...VERSION_LABELS.yours} />
      <VersionValue value={card.yours} marks={card.yoursText} />
    </Stack>
  </SimpleGrid>
)

/** What a card's buttons act on: the open entry's form, and what was chosen for the conflict. */
interface CardActions {
  /** Why the choices can't act now, such as a locked branch. */
  reason?: string
  /** Why a choice that takes the latest version can't act ({@link LATEST_UNPLACEABLE_REASON}). */
  latestReason?: string
  choice?: FieldChoice
  /** The form still holds the place as the last choice left it, so a new choice loses nothing. */
  held: boolean
  choose: (choice: FieldChoice | undefined) => void
  chooseRegion: (region: number, choice: RegionChoice) => void
  /** Takes back one region's choice, leaving the others. */
  clearRegion: (region: number) => void
  edit: () => void
}

const ChoiceNote: React.FC<{ text: string }> = ({ text }) => (
  <Group gap={6} wrap="nowrap" data-testid="conflict-choice-note">
    <UnsavedMark aria-hidden="true" />
    <Text size="xs">{text}</Text>
  </Group>
)

/** Latest, then yours, as "Use both" would place them, shown before it is applied. */
const UseBothPreview: React.FC<{ latest: string; yours: string }> = ({ latest, yours }) => {
  const [shown, setShown] = useState(false)
  const id = useId()
  return (
    <Stack gap={4} align="flex-start">
      <Button
        size="compact-xs"
        variant="subtle"
        aria-expanded={shown}
        aria-controls={shown ? id : undefined}
        onClick={() => setShown((s) => !s)}
      >
        {shown ? 'Hide "Use both" preview' : 'Preview "Use both"'}
      </Button>
      {shown && (
        <Box id={id} data-testid="conflict-use-both-preview">
          <Text size="xs" c="dimmed">
            Use both: latest, then yours
          </Text>
          <Text size="sm" style={TEXT_STYLE}>
            {[latest, yours].filter((t) => t !== '').join('\n')}
          </Text>
        </Box>
      )}
    </Stack>
  )
}

const FieldCardActions: React.FC<{ card: ConflictCard; actions: CardActions; label: string }> = ({
  card,
  actions,
  label,
}) => {
  const { reason, latestReason, choice, held } = actions
  const named = (verb: string) => `${verb}: ${label}`
  const btn = (verb: string, onClick: () => void, testId: string, why = reason) => (
    <ReasonedButton
      key={testId}
      reason={why}
      onClick={onClick}
      aria-label={named(verb)}
      data-testid={testId}
    >
      {verb}
    </ReasonedButton>
  )
  const editedReason = reason ?? (held ? undefined : EDITED_IN_FORM_REASON)
  // A choice taking the latest version waits for both: nothing to lose, and something to take.
  const latestTakes = reason ?? latestReason ?? editedReason

  if (card.type === 'region') {
    const chosen = choice?.how === 'regions' ? choice.regions[card.index] : undefined
    const fieldChosen = choice && choice.how !== 'regions'
    if (chosen || fieldChosen) {
      return (
        <Group gap="xs" wrap="wrap" align="center">
          <ChoiceNote
            text={
              chosen
                ? `${REGION_NOTES[chosen]} Save to keep this choice.`
                : CHOICE_NOTES[choice?.how ?? 'edited']
            }
          />
          {btn(
            EDITOR_ACTIONS.chooseAgain,
            () => (chosen ? actions.clearRegion(card.index) : actions.choose(undefined)),
            'conflict-choose-again',
          )}
        </Group>
      )
    }
    return (
      <Stack gap={4}>
        <UseBothPreview latest={card.latest} yours={card.yours} />
        <Group gap="xs" wrap="wrap" align="center">
          {btn(
            EDITOR_ACTIONS.useLatestVersion,
            () => actions.chooseRegion(card.index, 'latest'),
            'conflict-use-latest',
            latestTakes,
          )}
          {held
            ? btn(
                EDITOR_ACTIONS.keepYourVersion,
                () => actions.chooseRegion(card.index, 'yours'),
                'conflict-keep-yours',
              )
            : btn(
                EDITOR_ACTIONS.markResolved,
                () => actions.choose({ how: 'edited' }),
                'conflict-mark-resolved',
              )}
          {btn(
            EDITOR_ACTIONS.useBoth,
            () => actions.chooseRegion(card.index, 'both'),
            'conflict-use-both',
            latestTakes,
          )}
          {btn('Edit', actions.edit, 'conflict-edit')}
          {!held && !reason && <Text size="xs">{EDITED_IN_FORM}</Text>}
        </Group>
      </Stack>
    )
  }

  if (card.type === 'location') {
    if (choice) {
      return (
        <Group gap="xs" wrap="wrap" align="center">
          <ChoiceNote text={CHOICE_NOTES.yours} />
          {btn(
            EDITOR_ACTIONS.chooseAgain,
            () => actions.choose(undefined),
            'conflict-choose-again',
          )}
        </Group>
      )
    }
    return (
      <Group gap="xs" wrap="wrap" align="center">
        {btn(
          EDITOR_ACTIONS.keepYourVersion,
          () => actions.choose({ how: 'yours' }),
          'conflict-keep-yours',
        )}
      </Group>
    )
  }

  const removed = card.conflict !== 'changed'
  if (choice) {
    // "Remove it" and "Keep it" name what happens to the value, not whose version it is.
    const note = !removed
      ? CHOICE_NOTES[choice.how]
      : (choice.how === 'latest') === (card.conflict === 'removed-on-base')
        ? CHOICE_NOTES.remove
        : CHOICE_NOTES.keep
    return (
      <Group gap="xs" wrap="wrap" align="center">
        <ChoiceNote text={note} />
        {btn(EDITOR_ACTIONS.chooseAgain, () => actions.choose(undefined), 'conflict-choose-again')}
      </Group>
    )
  }
  if (removed) {
    const removeIs: FieldChoice['how'] = card.conflict === 'removed-on-base' ? 'latest' : 'yours'
    const keepIs: FieldChoice['how'] = removeIs === 'latest' ? 'yours' : 'latest'
    const pick = (how: FieldChoice['how']) => () =>
      actions.choose(how === 'latest' ? { how: 'latest' } : { how: 'yours' })
    const copy = copyTextOf(card.yours)
    // Your side is what the form holds, so once it was edited by hand the edit is what's kept.
    const side = (verb: string, how: FieldChoice['how'], testId: string) =>
      how === 'latest'
        ? btn(verb, pick(how), testId, latestTakes)
        : held
          ? btn(verb, pick(how), testId)
          : null
    return (
      <Group gap="xs" wrap="wrap" align="center">
        {side(EDITOR_ACTIONS.removeIt, removeIs, 'conflict-remove-it')}
        {side(EDITOR_ACTIONS.keepIt, keepIs, 'conflict-keep-it')}
        {!held &&
          btn(
            EDITOR_ACTIONS.markResolved,
            () => actions.choose({ how: 'edited' }),
            'conflict-mark-resolved',
          )}
        {copy !== undefined && (
          <CopyButton value={copy}>
            {({ copied, copy: doCopy }) => (
              <Button
                size="compact-sm"
                variant="subtle"
                onClick={doCopy}
                aria-label={copied ? `Copied: ${label}` : `Copy your version: ${label}`}
                data-testid="conflict-copy"
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
        )}
      </Group>
    )
  }
  return (
    <Group gap="xs" wrap="wrap" align="center">
      {btn(
        EDITOR_ACTIONS.useLatestVersion,
        () => actions.choose({ how: 'latest' }),
        'conflict-use-latest',
        latestTakes,
      )}
      {held
        ? btn(
            EDITOR_ACTIONS.keepYourVersion,
            () => actions.choose({ how: 'yours' }),
            'conflict-keep-yours',
          )
        : btn(
            EDITOR_ACTIONS.markResolved,
            () => actions.choose({ how: 'edited' }),
            'conflict-mark-resolved',
          )}
      {!card.item && btn('Edit', actions.edit, 'conflict-edit')}
      {!held && !reason && <Text size="xs">{EDITED_IN_FORM}</Text>}
    </Group>
  )
}

/**
 * A conflict card's yellow mark (a 409 conflict is yellow: nothing is lost yet) beside its warning
 * icon and heading, never colour alone. The card keeps the drawer's surface, which the text and
 * change marks are measured on.
 */
const CARD_ACCENT: React.CSSProperties = {
  borderInlineStart: '4px solid var(--mantine-color-yellow-filled)',
}

const FieldCard: React.FC<{
  card: ConflictCard
  adminBaseBranch?: string
  actions?: CardActions
}> = ({ card, adminBaseBranch, actions }) => {
  const heading = conflictHeading(card)
  return (
    <Paper
      withBorder
      p="sm"
      radius="sm"
      component="li"
      style={CARD_ACCENT}
      data-testid="conflict-card"
      data-conflict-kind={card.type === 'value' ? (card.item ? 'item' : card.conflict) : card.type}
    >
      <Stack gap="xs">
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <IconAlertTriangle size={16} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
          <Text
            component="h4"
            size="sm"
            fw={500}
            m={0}
            miw={0}
            style={{ overflowWrap: 'anywhere' }}
          >
            {heading}
          </Text>
        </Group>
        {card.type === 'location' ? (
          <Text size="sm">
            It keeps your URL. To use another, choose &quot;{EDITOR_ACTIONS.changeUrl}…&quot; in the
            entry&apos;s menu.
          </Text>
        ) : (
          <Versions card={card} adminBaseBranch={adminBaseBranch} />
        )}
        {actions && <FieldCardActions card={card} actions={actions} label={heading} />}
      </Stack>
    </Paper>
  )
}

/**
 * Why an entry-level choice didn't act: `warning` where nothing is lost or the outcome is unknown,
 * `error` for a failure a retry may pass.
 */
export interface EntryChoiceRefusal {
  message: string
  tone: 'warning' | 'error'
}

const EntryCard: React.FC<{
  kind: Exclude<EntryConflictData['kind'], 'fields'>
  reason?: string
  unsavedEdits?: boolean
  onResolve?: (choice: EntryConflictChoice) => Promise<EntryChoiceRefusal | undefined>
}> = ({ kind, reason, unsavedEdits, onResolve }) => {
  const [working, setWorking] = useState<EntryConflictChoice>()
  const [refusal, setRefusal] = useState<EntryChoiceRefusal & { choice: EntryConflictChoice }>()
  const { heading, choices } = ENTRY_KINDS[kind]
  const resolve = async (choice: EntryConflictChoice) => {
    if (!onResolve || working) return
    setWorking(choice)
    setRefusal(undefined)
    try {
      const refused = await onResolve(choice)
      setRefusal(refused && { ...refused, choice })
    } finally {
      setWorking(undefined)
    }
  }
  return (
    <Paper
      withBorder
      p="sm"
      radius="sm"
      component="li"
      style={CARD_ACCENT}
      data-testid="conflict-card"
      data-conflict-kind={kind}
    >
      <Stack gap="xs">
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <IconAlertTriangle size={16} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
          <Text component="h4" size="sm" fw={500} m={0}>
            {heading}
          </Text>
        </Group>
        {onResolve && (
          <Group gap="xs" wrap="wrap" align="center">
            {choices.map(({ choice, label, danger }) => (
              <ReasonedButton
                key={choice}
                reason={
                  reason ?? (choice !== 'keep' && unsavedEdits ? SAVE_FIRST_REASON : undefined)
                }
                onClick={() => void resolve(choice)}
                loading={working === choice}
                danger={danger}
                data-testid={`conflict-entry-${choice}`}
              >
                {label}
              </ReasonedButton>
            ))}
          </Group>
        )}
        {refusal && (
          <Alert
            variant="light"
            color={refusal.tone === 'error' ? 'red' : 'yellow'}
            icon={
              refusal.tone === 'error' ? (
                <IconAlertCircle size={16} />
              ) : (
                <IconAlertTriangle size={16} />
              )
            }
            data-testid="conflict-entry-refused"
          >
            <Stack gap={4} align="flex-start">
              <Text size="sm">{refusal.message}</Text>
              {refusal.tone === 'error' && (
                <Button
                  size="compact-sm"
                  variant="subtle"
                  loading={working === refusal.choice}
                  onClick={() => void resolve(refusal.choice)}
                >
                  Retry
                </Button>
              )}
            </Stack>
          </Alert>
        )}
      </Stack>
    </Paper>
  )
}

/** The open entry's form, which field choices change. */
interface ConflictsForm {
  value: FormValue
  saved: FormValue
  update: (update: (value: FormValue) => FormValue) => void
  /** The schema's body field on an md/mdx entry. */
  bodyField?: string
}

export interface ConflictsGroupProps {
  data: EntryConflictData
  conflicts: EntryConflicts
  /** The branch the latest version comes from, given only for an admin. */
  adminBaseBranch?: string
  choices: EntryChoices
  /** The open entry's form; without it the cards only show, and say to open the entry. */
  form?: ConflictsForm
  /** Records a field's choice, or clears it with undefined. `decided` says it settles the field. */
  onChoose?: (field: FieldConflict, choice: FieldChoice | undefined, decided: boolean) => void
  /** Closes the drawer and focuses the field in the form. */
  onEdit?: (field: FieldConflict) => void
  /** Settles an entry-level conflict; resolves with why it couldn't, when it couldn't. */
  onResolveEntry?: (choice: EntryConflictChoice) => Promise<EntryChoiceRefusal | undefined>
  /** Why this user can't change the entry: the choices are hidden. */
  noEditReason?: string
  /** Why the choices can't act now: they stay, disabled, saying so. */
  lockedReason?: string
  /** The entry has unsaved edits, which an entry-level choice would replace. */
  unsavedEdits?: boolean
}

/** The "Conflicts" group: a heading, a count heard as it changes, and the cards. */
export const ConflictsGroup: React.FC<ConflictsGroupProps> = ({
  data,
  conflicts,
  adminBaseBranch,
  choices,
  form,
  onChoose,
  onEdit,
  onResolveEntry,
  noEditReason,
  lockedReason,
  unsavedEdits,
}) => {
  const headingId = useId()
  const editable = !noEditReason
  const entryKind = data.kind === 'fields' ? undefined : data.kind

  // A stored choice stands while the form still holds what it chose. One the form was edited away
  // from since stands for the edit: a decided choice becomes "Mark resolved", which the save
  // resolves as it would the choice, open drawer or not; an undecided region choice, or one on text
  // that now shows whole, is dropped. A locked form shows the saved value over the draft it keeps,
  // so while locked every choice stands as made.
  const standing = new Map<string, FieldChoice>()
  const stale: Array<{ field: FieldConflict; next: FieldChoice | undefined }> = []
  if (form) {
    for (const field of conflicts.fields) {
      const chosen = choices[field.key]
      if (!chosen || chosen.mergeSha !== field.mergeSha) continue
      const placed = chosen.choice.how !== 'regions' || !!field.text
      const held =
        !!lockedReason ||
        chosen.choice.how === 'edited' ||
        holdsChoice(form.value, form.saved, field, chosen.choice, form.bodyField)
      if (placed && held) {
        standing.set(field.key, chosen.choice)
      } else if (placed && isDecided(field, chosen.choice)) {
        standing.set(field.key, { how: 'edited' })
        stale.push({ field, next: { how: 'edited' } })
      } else {
        stale.push({ field, next: undefined })
      }
    }
  }
  const staleKeys = stale.map(({ field, next }) => `${field.key}:${next?.how ?? ''}`).join(',')
  const open = entryKind
    ? 1
    : conflicts.fields.filter(
        (f) => !isDecided(f, form ? standing.get(f.key) : choices[f.key]?.choice),
      ).length
  useEffect(() => {
    for (const { field, next } of stale) onChoose?.(field, next, !!next)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `stale` is this render's, keyed by `staleKeys`
  }, [staleKeys])

  const actionsFor = (field: FieldConflict): CardActions | undefined => {
    if (!form || !editable || !onChoose) return undefined
    const choice = standing.get(field.key)
    const held = holdsChoice(form.value, form.saved, field, choice, form.bodyField)
    const record = (next: FieldChoice | undefined) => onChoose(field, next, isDecided(field, next))
    const latestReason =
      withLatest(form.value, field, form.bodyField) !== undefined
        ? undefined
        : LATEST_UNPLACEABLE_REASON
    return {
      reason: lockedReason,
      latestReason,
      choice,
      held,
      choose: (next) => {
        if (next?.how === 'latest') {
          form.update((v) => withLatest(v, field, form.bodyField) ?? v)
        } else if (
          next === undefined &&
          held &&
          (choice?.how === 'latest' || choice?.how === 'regions')
        ) {
          // Choosing again takes back what a choice wrote, unless the form was edited since; an
          // edit marked resolved stays.
          form.update((v) => withYours(v, form.saved, field, form.bodyField) ?? v)
        }
        record(next)
      },
      chooseRegion: (region, regionChoice) => {
        const regions = {
          ...(choice?.how === 'regions' ? choice.regions : {}),
          [region]: regionChoice,
        }
        form.update((v) => withRegions(v, field, regions, form.bodyField) ?? v)
        record({ how: 'regions', regions })
        // A join almost always needs tidying, so it opens for editing.
        if (regionChoice === 'both') onEdit?.(field)
      },
      clearRegion: (region) => {
        if (choice?.how !== 'regions') return
        const { [region]: _cleared, ...regions } = choice.regions
        if (held) form.update((v) => withRegions(v, field, regions, form.bodyField) ?? v)
        record(Object.keys(regions).length > 0 ? { how: 'regions', regions } : undefined)
      },
      edit: () => onEdit?.(field),
    }
  }

  return (
    <Stack component="section" gap="xs" aria-labelledby={headingId} data-testid="conflicts-group">
      <Text component="h3" id={headingId} size="sm" fw={600} m={0}>
        Conflicts
      </Text>
      <Text size="sm" data-testid="conflicts-summary">
        {entryKind
          ? 'Changed by you and by someone else. Choose what to keep.'
          : `${plural(conflicts.fields.length, 'field', 'fields')} changed by you and by someone else. Choose what to keep, then save.`}
      </Text>
      <VisuallyHidden role="status" data-testid="conflicts-left">
        {open === 0
          ? 'All chosen. Save to keep your choices.'
          : `${plural(open, 'field', 'fields')} left to choose.`}
      </VisuallyHidden>
      {conflicts.incomplete && (
        <Text size="xs" c="dimmed" data-testid="conflicts-incomplete">
          Some versions couldn&apos;t be read, so some values may not show.
        </Text>
      )}
      {noEditReason && (
        <Text size="sm" data-testid="conflicts-no-edit">
          {noEditReason}
        </Text>
      )}
      {editable && !form && !entryKind && (
        <Text size="sm" data-testid="conflicts-open-to-choose">
          {OPEN_TO_CHOOSE}
        </Text>
      )}
      {editable && lockedReason && (
        <Text size="sm" data-testid="conflicts-locked">
          {lockedReason}
        </Text>
      )}
      <Stack component="ul" gap="sm" p={0} m={0} style={{ listStyle: 'none' }}>
        {entryKind ? (
          <EntryCard
            kind={entryKind}
            reason={lockedReason}
            unsavedEdits={unsavedEdits}
            onResolve={editable ? onResolveEntry : undefined}
          />
        ) : (
          conflicts.fields.flatMap((field) => {
            const actions = actionsFor(field)
            return field.cards.map((card) => (
              <FieldCard
                key={card.id}
                card={card}
                adminBaseBranch={adminBaseBranch}
                actions={actions}
              />
            ))
          })
        )}
      </Stack>
    </Stack>
  )
}
