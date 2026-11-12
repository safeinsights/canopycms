'use client'

/**
 * The "Changes to <title>" drawer: one card per changed field of an entry, its value at the
 * base beside its saved value on the branch. LazyEntryChangesDrawer loads it, so the diff model
 * and jsdiff stay out of the editor's first chunk.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  VisuallyHidden,
  em,
  getBreakpointValue,
  useMantineTheme,
} from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconExternalLink,
  IconArrowsMove,
  IconInfoCircle,
  IconMinus,
  IconPencil,
  IconPlus,
} from '@tabler/icons-react'

import type { BranchChangeEntry } from '../../api/branch-changes'
import type { FieldConfig } from '../../config'
import type { CanopyPathSegment } from '../canopy-path'
import { EDITOR_ACTIONS } from '../copy'
import { computeEntryDiff, type DiffRow, type EntryChange, type TextDiff } from '../entry-diff'
import type { EntryChangeState } from '../hooks/useBranchChangesData'
import type { ConflictsState } from '../hooks/useConflictsData'
import { buildEntryConflicts } from '../conflict-cards'
import type { EntryConflictData } from '../../api/merge-conflicts'
import { findBodyFieldName } from '../../utils/body-field'
import { OverlayDrawer } from '../shell/OverlayHeader'
import { movedThreadsNote } from '../undo-removal'
import {
  canSetBack,
  canopyPathOf,
  formValueOfSide,
  holdsAs,
  setAllBack,
  setChangeBack,
  sideOfFormValue,
} from '../undo-change'
import { focusReturnProps } from '../utils/focus-return'
import {
  DateValue,
  MarkedText,
  ReasonedButton,
  TEXT_STYLE,
  Value,
  ordinal,
  plural,
  type Side,
} from './change-parts'
import { ConflictsGroup, type ConflictsGroupProps, type EntryChoiceDone } from './ConflictsGroup'
import { LoadingCards, LoadingSummary } from './EntryChangesSkeleton'

/** The entry a drawer compares, as the editor knows it. */
export interface EntryChangesSubject {
  logicalPath: string
  /** A moved entry's path at the base. */
  from?: string
  /** The entry's content id, which both sides must carry. */
  contentId?: string
  status: BranchChangeEntry['status']
  title: string
  /** The entry type's fields; empty when the editor has none for it. */
  fields: readonly FieldConfig[]
  /** A moved entry's path at the base, in human labels. */
  movedFromLabel?: string
  /** The open entry has edits not yet saved, which the comparison leaves out. */
  unsavedEdits?: boolean
}

export interface EntryChangesDrawerProps {
  opened: boolean
  onClose: () => void
  /** The close transition has finished. */
  onExited?: () => void
  /** Names the element that takes focus after the drawer closes. */
  returnFocusTo?: () => HTMLElement | null
  /** The base branch's name, for the copy. */
  base: string
  subject: EntryChangesSubject
  /** The comparison, loaded while the drawer is open (`useEntryChangeData`). */
  state: Pick<EntryChangeState, 'data' | 'error' | 'isValidating' | 'reload'>
  /** A referenced entry's title, from the entries the editor has listed. */
  referenceTitle?: (id: string) => string | undefined
  /** Closes the drawer and opens the entry; given only when the entry exists on the branch. */
  onOpenEntry?: () => void
  /** The branch's pull request, offered where this drawer can't compare. */
  pullRequestUrl?: string
  /** Undoing the entry's changes in its form; given only for the open entry. */
  undo?: EntryChangesUndo
  /**
   * Why this user can't change the entry at all, such as a path rule: its undo, delete and
   * restore controls are hidden and this one line says why.
   */
  noEditReason?: string
  /**
   * Why those controls can't act now, such as a locked branch: they stay, disabled, saying so,
   * as the form's do.
   */
  lockedReason?: string
  /** Opens the confirm that deletes an entry added on the branch, closing the drawer first. */
  onDeleteEntry?: () => void
  /** Puts back an entry deleted on the branch; resolves with why it couldn't, when it couldn't. */
  onRestoreEntry?: () => Promise<RestoreRefusal | undefined>
  /** The entry's open conflicts, given while the branch lists any for it. */
  conflicts?: EntryChangesConflicts
}

/** What the "Conflicts" group needs beyond the drawer's own props (ConflictsGroup.tsx). */
export interface EntryChangesConflicts extends Pick<
  ConflictsGroupProps,
  'adminBaseBranch' | 'choices' | 'onChoose' | 'onEdit'
> {
  state: ConflictsState<EntryConflictData | null>
  onResolveEntry?: ConflictsGroupProps['onResolveEntry']
  /** The entry has a draft, open or not, which an entry-level choice would leave behind. */
  unsavedEdits?: boolean
}

/** Why "Restore entry" didn't: `warning` where nothing is lost, or the outcome is unknown. */
export interface RestoreRefusal {
  message: string
  tone: 'warning' | 'error'
}

/** The open entry's form value, and the way to change its draft; see `undo-change.ts`. */
export interface EntryChangesUndo {
  /** The entry's value as its form holds it, unsaved edits included. */
  value: Record<string, unknown>
  /**
   * Its saved value as the form loaded it, which a redo puts back: references resolved, so a
   * redone entry matches its saved state and isn't left unsaved. Else the comparison's saved side.
   */
  saved?: Record<string, unknown>
  /** Sets the entry's draft to what `update` makes of its value at that moment. */
  update: (update: (value: Record<string, unknown>) => Record<string, unknown>) => void
  /** Open field threads inside a canopy path, which taking out an item there moves to the entry. */
  threadsWithin?: (path: CanopyPathSegment[]) => number
}

const KIND_BADGES: Record<EntryChange['kind'], { label: string; icon: React.ReactNode }> = {
  added: { label: 'Added', icon: <IconPlus size={10} aria-hidden /> },
  removed: { label: 'Removed', icon: <IconMinus size={10} aria-hidden /> },
  changed: { label: 'Changed', icon: <IconPencil size={10} aria-hidden /> },
  moved: { label: 'Moved', icon: <IconArrowsMove size={10} aria-hidden /> },
}

const Gutter: React.FC<{ sign?: '−' | '+' }> = ({ sign }) => (
  <Text size="sm" c="dimmed" aria-hidden ta="center" style={{ userSelect: 'none' }}>
    {sign ?? ''}
  </Text>
)

const Skipped: React.FC<{ count: number; style?: React.CSSProperties }> = ({ count, style }) => (
  <Text size="xs" c="dimmed" py={2} style={style}>
    {plural(count, 'unchanged line', 'unchanged lines')}
  </Text>
)

const LINE_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1rem minmax(0, 1fr) 1rem minmax(0, 1fr)',
  columnGap: 'var(--mantine-spacing-xs)',
}

/** Consecutive changed rows of one kind past this many show only RUN_SHOWN of them until asked. */
const LONG_RUN = 50
const RUN_SHOWN = 20

type RunKind = 'added' | 'removed' | 'changed'

/** `rows` split into runs: each long run of lines added, removed or changed is its own segment. */
const rowSegments = (
  rows: readonly DiffRow[],
): Array<{ rows: readonly DiffRow[]; long?: RunKind }> => {
  const kindOf = (row: DiffRow): RunKind | undefined =>
    row.kind !== 'change' ? undefined : !row.before ? 'added' : !row.after ? 'removed' : 'changed'
  const segments: Array<{ rows: readonly DiffRow[]; long?: RunKind }> = []
  let plain: DiffRow[] = []
  for (let i = 0; i < rows.length; ) {
    const side = kindOf(rows[i])
    let end = i + 1
    while (side && end < rows.length && kindOf(rows[end]) === side) end++
    if (side && end - i > LONG_RUN) {
      if (plain.length > 0) segments.push({ rows: plain })
      plain = []
      segments.push({ rows: rows.slice(i, end), long: side })
    } else {
      plain.push(...rows.slice(i, end))
    }
    i = end
  }
  if (plain.length > 0) segments.push({ rows: plain })
  return segments
}

/** A long run's first rows, then the button that shows the rest and moves focus to them. */
const LongRun: React.FC<{
  rows: readonly DiffRow[]
  side: RunKind
  renderRows: RenderRows
}> = ({ rows, side, renderRows }) => {
  const [expanded, setExpanded] = useState(false)
  const firstNew = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (expanded) firstNew.current?.focus()
  }, [expanded])
  if (expanded) {
    return (
      <>
        {renderRows(rows.slice(0, RUN_SHOWN))}
        {renderRows(rows.slice(RUN_SHOWN), firstNew)}
      </>
    )
  }
  return (
    <>
      {renderRows(rows.slice(0, RUN_SHOWN))}
      <Box style={{ gridColumn: '1 / -1' }}>
        <Button size="compact-sm" variant="subtle" onClick={() => setExpanded(true)}>
          Show all {rows.length} {side} lines
        </Button>
      </Box>
    </>
  )
}

/**
 * Renders rows; the first one's first text cell takes `focusRef` and `tabIndex={-1}`, so focus
 * can land on it.
 */
type RenderRows = (rows: readonly DiffRow[], focusRef?: React.Ref<HTMLElement>) => React.ReactNode

/** The props that make a row's first text cell a focus target, when `i` is the first row's. */
const focusTarget = (i: number, focusRef?: React.Ref<HTMLElement>) =>
  i === 0 && focusRef ? { ref: focusRef as React.Ref<HTMLDivElement>, tabIndex: -1 } : {}

/** Two columns from `md`: an unchanged line is read once, from Before. */
const twoColumnRows: RenderRows = (rows, focusRef) =>
  rows.map((row, i) => {
    if (row.kind === 'skipped') {
      return <Skipped key={i} count={row.count} style={{ gridColumn: '1 / -1' }} />
    }
    if (row.kind === 'same') {
      const text = row.text || '\u00a0'
      return (
        <React.Fragment key={i}>
          <Gutter />
          <Text size="sm" style={TEXT_STYLE} {...focusTarget(i, focusRef)}>
            {text}
          </Text>
          <Gutter />
          <Text size="sm" style={TEXT_STYLE} aria-hidden>
            {text}
          </Text>
        </React.Fragment>
      )
    }
    return (
      <React.Fragment key={i}>
        <Gutter sign={row.before ? '−' : undefined} />
        <Text size="sm" style={TEXT_STYLE} {...focusTarget(row.before ? i : -1, focusRef)}>
          {row.before ? <MarkedText parts={row.before} side="before" unit="line" /> : null}
        </Text>
        <Gutter sign={row.after ? '+' : undefined} />
        <Text size="sm" style={TEXT_STYLE} {...focusTarget(row.before ? -1 : i, focusRef)}>
          {row.after ? <MarkedText parts={row.after} side="after" unit="line" /> : null}
        </Text>
      </React.Fragment>
    )
  })

/** One column below `md`, with − and + gutters. */
const oneColumnRows: RenderRows = (rows, focusRef) =>
  rows.flatMap((row, i) => {
    if (row.kind === 'skipped') {
      return [<Skipped key={i} count={row.count} style={{ gridColumn: '1 / -1' }} />]
    }
    if (row.kind === 'same') {
      return [
        <Gutter key={`${i}g`} />,
        <Text key={i} size="sm" style={TEXT_STYLE} {...focusTarget(i, focusRef)}>
          {row.text || '\u00a0'}
        </Text>,
      ]
    }
    return (['before', 'after'] as const).flatMap((side) => {
      const parts = row[side]
      if (!parts) return []
      return [
        <Gutter key={`${i}${side}g`} sign={side === 'before' ? '−' : '+'} />,
        <Text
          key={`${i}${side}`}
          size="sm"
          style={TEXT_STYLE}
          {...focusTarget(side === 'before' || !row.before ? i : -1, focusRef)}
        >
          <MarkedText parts={parts} side={side} unit="line" />
        </Text>,
      ]
    })
  })

/**
 * A line diff as aligned rows, so Before and After stay level however many lines one side adds:
 * from `md`, two columns with an empty cell opposite a line the other side lacks; below it, one
 * column with − and + gutters. One layout renders, chosen by the theme's `md` breakpoint.
 */
const LineRows: React.FC<{ rows: readonly DiffRow[] }> = ({ rows }) => {
  const theme = useMantineTheme()
  const narrow =
    useMediaQuery(`(max-width: ${em(getBreakpointValue('md', theme.breakpoints) - 0.1)})`, false, {
      getInitialValueInEffect: false,
    }) === true
  const renderRows = narrow ? oneColumnRows : twoColumnRows
  const segments = rowSegments(rows)
  return (
    <Box
      style={narrow ? { ...LINE_GRID, gridTemplateColumns: '1rem minmax(0, 1fr)' } : LINE_GRID}
      data-testid={narrow ? 'entry-change-line-list' : 'entry-change-line-grid'}
    >
      {!narrow && (
        <>
          <Text size="xs" c="dimmed" style={{ gridColumn: '1 / span 2' }}>
            Before
          </Text>
          <Text size="xs" c="dimmed" style={{ gridColumn: '3 / span 2' }}>
            After
          </Text>
        </>
      )}
      {segments.map((segment, i) =>
        segment.long ? (
          <LongRun key={i} rows={segment.rows} side={segment.long} renderRows={renderRows} />
        ) : (
          <React.Fragment key={i}>{renderRows(segment.rows)}</React.Fragment>
        ),
      )}
    </Box>
  )
}

const WordsChange: React.FC<{ text: Extract<TextDiff, { mode: 'words' }>; side: Side }> = ({
  text,
  side,
}) => (
  <Text size="sm" style={TEXT_STYLE}>
    <MarkedText parts={text.parts} side={side} unit="text" />
  </Text>
)

const SideColumn: React.FC<{ label: string; change: EntryChange; side: Side }> = ({
  label,
  change,
  side,
}) => {
  const value = change[side] ?? { kind: 'empty' }
  const words = change.text?.mode === 'words' ? change.text : undefined
  return (
    <Stack gap={4} miw={0}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      {value.kind === 'date' && words ? (
        <DateValue
          value={value}
          text={<MarkedText parts={words.parts} side={side} unit="text" />}
        />
      ) : words ? (
        <WordsChange text={words} side={side} />
      ) : (
        <Value value={value} alt={change.altText && { text: change.altText, side }} />
      )}
    </Stack>
  )
}

/** A change's undo control and, once undone, what that did. */
interface CardUndo {
  undone: boolean
  /** Why it can't act, when it can't. */
  reason?: string
  /** What else undoing it did, such as comment threads moved. */
  note?: string
  onToggle: () => void
}

const UNDONE_IN_FORM = 'Undone in the form. Save to keep it.'
const ALL_UNDONE_IN_FORM = 'All changes undone in the form. Save to keep them.'
// Undo and redo replace what the form holds at a change with the base's or the saved value, so
// neither acts on a change the form has edited since: the edit would be lost.
const UNSAVED_EDIT_REASON =
  'This change has unsaved edits. Save them, or choose "Discard changes" in the entry\'s menu, on its name, first.'
const UNSAVED_EDITS_REASON =
  'Some of these changes have unsaved edits. Save them, or choose "Discard changes" in the entry\'s menu, on its name, first.'
/** Beside the undo controls, where an undo makes the entry unsaved, in place of a new notice. */
const UNSAVED_IN_FORM = 'Unsaved edits, undos included, apply when you save.'
const NOT_IN_FORM_REASON =
  'The form no longer has the item this change is in, so it can’t be undone here.'

/** One change: its labelled breadcrumb, its kind in a word, and the values on each side. */
const ChangeCard: React.FC<{
  change: EntryChange
  wholeEntry: Side | undefined
  undo?: CardUndo
}> = ({ change, wholeEntry, undo }) => {
  const moved =
    change.kind === 'moved' &&
    change.before?.kind === 'position' &&
    change.after?.kind === 'position'
      ? { from: change.before.position, to: change.after.position, of: change.after.of }
      : undefined
  return (
    <Paper withBorder p="sm" radius="sm" component="li" data-testid="entry-change-card">
      <Group gap="xs" justify="space-between" wrap="nowrap" mb="xs" align="flex-start">
        <Text component="h3" size="sm" fw={500} m={0} miw={0} style={{ overflowWrap: 'anywhere' }}>
          {change.path.join(' › ')}
        </Text>
        <Badge
          size="xs"
          variant="light"
          color="gray"
          leftSection={KIND_BADGES[change.kind].icon}
          style={{ flexShrink: 0 }}
        >
          {KIND_BADGES[change.kind].label}
        </Badge>
      </Group>
      {moved ? (
        <Text size="sm">
          Moved from {ordinal(moved.from)} to {ordinal(moved.to)} of {moved.of}
        </Text>
      ) : wholeEntry ? (
        <Value value={change[wholeEntry] ?? { kind: 'empty' }} />
      ) : change.text?.mode === 'lines' ? (
        <LineRows rows={change.text.rows} />
      ) : change.text?.mode === 'endLineBreak' ? (
        <Text size="sm">
          {change.text.added ? 'Line break added at the end' : 'Line break removed at the end'}
        </Text>
      ) : (
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
          <SideColumn label="Before" change={change} side="before" />
          <SideColumn label="After" change={change} side="after" />
        </SimpleGrid>
      )}
      {change.tooLargeToMark && (
        <Text size="xs" c="dimmed" mt="xs" data-testid="entry-change-unmarked">
          Too many changes to highlight.
        </Text>
      )}
      {undo && (
        <Group gap="xs" mt="xs" wrap="wrap" align="center">
          <ReasonedButton
            reason={undo.reason}
            onClick={undo.onToggle}
            aria-label={`${undo.undone ? EDITOR_ACTIONS.redoChange : EDITOR_ACTIONS.undoChange} to ${change.path.join(' › ')}`}
            data-testid="entry-change-undo"
          >
            {undo.undone ? EDITOR_ACTIONS.redoChange : EDITOR_ACTIONS.undoChange}
          </ReasonedButton>
          <Text size="xs" data-testid="entry-change-undone">
            {undo.undone ? [UNDONE_IN_FORM, undo.note].filter(Boolean).join(' ') : ''}
          </Text>
        </Group>
      )}
    </Paper>
  )
}

/**
 * The summary's place, a status region from the first render on, so a screen reader hears
 * "Loading changes…" and then the summary that replaces it, each once.
 */
const StatusRegion: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <Stack gap={2} role="status" data-testid="entry-changes-status">
    {children}
  </Stack>
)

const REFUSALS = {
  tooLarge: 'This entry is too large to compare here.',
  // A path the user can't read answers 404 too, so this never says the entry doesn't exist.
  notFound: 'This entry can’t be compared here.',
  unreadable: 'This entry couldn’t be read on one side, so it can’t be compared.',
} as const

/**
 * "3 fields changed since main"; whole list items are counted apart from fields:
 * "6 fields changed, 2 items added, 1 item moved since main".
 */
const changeSummary = (changes: readonly EntryChange[], base: string): string => {
  const items = (kind: EntryChange['kind']) =>
    changes.filter((c) => c.item && c.kind === kind).length
  const fields = changes.filter((c) => !c.item).length
  const parts = [
    ...(fields > 0 ? [`${plural(fields, 'field', 'fields')} changed`] : []),
    ...(['added', 'removed', 'moved'] as const).flatMap((kind) => {
      const count = items(kind)
      return count > 0 ? [`${plural(count, 'item', 'items')} ${kind}`] : []
    }),
  ]
  return `${parts.join(', ')} since ${base}`
}

type EntryChangesViewProps = Omit<
  EntryChangesDrawerProps,
  'opened' | 'onClose' | 'onExited' | 'returnFocusTo'
>

/** The conflicts' place: loading, their failure with Retry, or the group; nothing for none. */
const ConflictsSection: React.FC<{
  conflicts: EntryChangesConflicts
  subject: EntryChangesSubject
  referenceTitle?: (id: string) => string | undefined
  undo?: EntryChangesUndo
  noEditReason?: string
  lockedReason?: string
  onEntryDone: (done: EntryChoiceDone) => void
}> = ({ conflicts, subject, referenceTitle, undo, noEditReason, lockedReason, onEntryDone }) => {
  const { data, error, isValidating, reload } = conflicts.state
  const bodyField = useMemo(() => {
    const side =
      data && Object.values(data.versions).find((v) => 'body' in v && v.body !== undefined)
    return side && 'data' in side
      ? (side.bodyFieldName ?? findBodyFieldName(subject.fields))
      : undefined
  }, [data, subject.fields])
  // Regions apply only to the text your saved value holds, so the cards are built against it.
  const saved = noEditReason ? undefined : undo?.saved
  const built = useMemo(
    () => data && buildEntryConflicts(data, subject.fields, bodyField, referenceTitle, saved),
    [data, subject.fields, bodyField, referenceTitle, saved],
  )
  if (data === null) return null
  if (error && !data) {
    return (
      <Alert
        variant="light"
        color="red"
        icon={<IconAlertCircle size={16} />}
        data-testid="conflicts-failed"
      >
        <Stack gap={4} align="flex-start">
          <Text size="sm">Couldn’t load this entry’s conflicts.</Text>
          <Button
            size="compact-sm"
            variant="subtle"
            loading={isValidating}
            onClick={() => void reload()}
          >
            Retry
          </Button>
        </Stack>
      </Alert>
    )
  }
  if (!data || !built) return <LoadingCards />
  return (
    <ConflictsGroup
      data={data}
      conflicts={built}
      adminBaseBranch={conflicts.adminBaseBranch}
      choices={conflicts.choices}
      form={
        !noEditReason && undo?.saved
          ? { value: undo.value, saved: undo.saved, update: undo.update, bodyField }
          : undefined
      }
      onChoose={conflicts.onChoose}
      onEdit={conflicts.onEdit}
      onResolveEntry={conflicts.onResolveEntry}
      onEntryDone={onEntryDone}
      noEditReason={noEditReason}
      lockedReason={lockedReason}
      unsavedEdits={conflicts.unsavedEdits ?? subject.unsavedEdits}
      entryDeleted={subject.status === 'deleted'}
    />
  )
}

/**
 * Where focus goes once an entry-level choice's card is gone: "Restore entry" while the entry stays
 * deleted and the drawer offers it, else the drawer's title.
 */
const focusAfterEntryChoice = (root: HTMLElement | null, entryGone: boolean) => {
  const restore = entryGone
    ? root?.querySelector<HTMLElement>('[data-testid="entry-changes-restore"]')
    : null
  if (restore) return restore.focus()
  const titleId = root?.closest('[role="dialog"]')?.getAttribute('aria-labelledby')
  const title = titleId ? document.getElementById(titleId) : null
  if (!title) return
  title.tabIndex = -1
  title.focus()
}

/**
 * The drawer's body: what an entry-level choice settled, then the entry's conflicts, if any, above
 * its changes, which keep their place in the tree as the conflicts go.
 */
export const EntryChangesView: React.FC<EntryChangesViewProps> = (props) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const [said, setSaid] = useState<{ id: number; message: string; path: string }>()
  // What was said is about the entry it was said on.
  const entryDone = said?.path === props.subject.logicalPath ? said : undefined
  const onEntryDone = (done: EntryChoiceDone) => {
    setSaid((last) => ({
      id: (last?.id ?? 0) + 1,
      message: done.message,
      path: props.subject.logicalPath,
    }))
    focusAfterEntryChoice(rootRef.current, done.entryGone)
  }
  return (
    <div ref={rootRef}>
      {(props.conflicts || entryDone) && (
        <Text size="sm" role="status" mb={entryDone ? 'md' : 0} data-testid="entry-choice-done">
          {entryDone && <span key={entryDone.id}>{entryDone.message}</span>}
        </Text>
      )}
      <Stack gap="lg">
        {props.conflicts && (
          <ConflictsSection
            conflicts={props.conflicts}
            subject={props.subject}
            referenceTitle={props.referenceTitle}
            undo={props.undo}
            noEditReason={props.noEditReason}
            lockedReason={props.lockedReason}
            onEntryDone={onEntryDone}
          />
        )}
        <EntryChangesBody {...props} />
      </Stack>
    </div>
  )
}

/** The changes: their states, then the summary and one card per change. */
const EntryChangesBody: React.FC<EntryChangesViewProps> = ({
  base,
  subject,
  state,
  referenceTitle,
  onOpenEntry,
  pullRequestUrl,
  undo,
  noEditReason,
  lockedReason,
  onDeleteEntry,
  onRestoreEntry,
}) => {
  const { data, error } = state
  const diff = useMemo(
    () =>
      data &&
      computeEntryDiff({
        fields: subject.fields,
        before: data.before,
        after: data.after,
        referenceTitle,
      }),
    [data, subject.fields, referenceTitle],
  )
  // The changes the form still holds: the base against the form's value. A saved change missing
  // from them is undone in the form, so the drawer keeps no undo state of its own.
  const formValue = noEditReason ? undefined : undo?.value
  const heldKeys = useMemo(() => {
    if (!formValue || !data?.before || !data.after) return undefined
    const held = computeEntryDiff({
      fields: subject.fields,
      before: data.before,
      after: sideOfFormValue(formValue, data.after),
      marks: false,
    })
    return new Set(held.changes.map((change) => change.key))
  }, [formValue, data, subject.fields])
  // What taking out an item did to its threads, said beside its undo until it is redone.
  const [notes, setNotes] = useState<Record<string, string>>({})
  // What the last undo or redo did, said once here rather than by every card it touched. `id`
  // re-keys the text, so a second action with the same words is announced too.
  const [announcement, setAnnouncement] = useState<{ id: number; text: string }>()
  const announce = (text: string) => setAnnouncement((last) => ({ id: (last?.id ?? 0) + 1, text }))
  const [restoring, setRestoring] = useState(false)
  const [restoreRefusal, setRestoreRefusal] = useState<RestoreRefusal>()
  useEffect(() => {
    setNotes({})
    setAnnouncement(undefined)
    setRestoreRefusal(undefined)
  }, [subject.logicalPath, undo?.saved])

  // A refusal no retry passes: its reason, and the ways the entry can still be looked at.
  const refusal =
    error?.kind === 'tooLarge' || error?.kind === 'notFound' || error?.kind === 'unreadable'
      ? error.kind
      : undefined
  if (refusal) {
    return (
      <Stack gap="xs" align="flex-start" data-testid={`entry-changes-${refusal}`}>
        <Text size="sm">{REFUSALS[refusal]}</Text>
        <Group gap="md">
          {/* A 404 may be an entry the branch no longer has; only the PR shows it then. */}
          {onOpenEntry && refusal !== 'notFound' && (
            <Button size="compact-sm" variant="subtle" px={0} onClick={onOpenEntry}>
              Open the entry
            </Button>
          )}
          {pullRequestUrl && (
            <Button
              component="a"
              href={pullRequestUrl}
              target="_blank"
              rel="noopener noreferrer"
              size="compact-sm"
              variant="subtle"
              px={0}
              rightSection={<IconExternalLink size={14} aria-hidden />}
            >
              Compare on the pull request
              <VisuallyHidden component="span"> (opens in a new tab)</VisuallyHidden>
            </Button>
          )}
        </Group>
      </Stack>
    )
  }

  const errorNotice = error && (
    <Alert
      variant="light"
      color={error.kind === 'syncing' ? 'yellow' : 'red'}
      icon={
        error.kind === 'syncing' ? <IconAlertTriangle size={16} /> : <IconAlertCircle size={16} />
      }
      data-testid={`entry-changes-${error.kind}`}
    >
      <Stack gap={4} align="flex-start">
        <Text size="sm">
          {error.kind === 'syncing'
            ? `${error.message ?? `This branch is being synced with ${base}. Try again in a moment.`}${
                data ? ' The changes below may be out of date.' : ''
              }`
            : data
              ? 'Couldn’t refresh this entry’s changes. They may be out of date.'
              : 'Couldn’t load this entry’s changes.'}
        </Text>
        <Button
          size="compact-sm"
          variant="subtle"
          loading={state.isValidating}
          onClick={() => void state.reload()}
        >
          Retry
        </Button>
      </Stack>
    </Alert>
  )

  if (!data || !diff) {
    return (
      <Stack gap="sm">
        <StatusRegion>{!errorNotice && <LoadingSummary />}</StatusRegion>
        {errorNotice || <LoadingCards />}
      </Stack>
    )
  }

  const wholeEntry: Side | undefined = !data.before ? 'after' : !data.after ? 'before' : undefined
  const count = diff.changes.length
  const movedFrom = data.before && data.after ? subject.movedFromLabel : undefined
  // A move that changed no value is said by its "Moved from" line alone.
  const summary = !data.before
    ? 'New entry'
    : !data.after
      ? 'Deleted entry'
      : count > 0
        ? changeSummary(diff.changes, base)
        : movedFrom
          ? undefined
          : 'Only formatting changed; no field values differ.'

  // Undo sets an edited entry's values back; an entry type change has no field to set back.
  const typeChanged = diff.changes.some((change) => !canSetBack(change))
  const undoable =
    !!undo && !!heldKeys && !!data.before && !!data.after && count > 0 && !typeChanged
  // The field the diff keys an md/mdx body under, as `computeEntryDiff` picks it.
  const bodySide = data.after ?? data.before
  const bodyField =
    bodySide?.body === undefined
      ? undefined
      : (bodySide.bodyFieldName ?? findBodyFieldName(subject.fields))
  const baseValue = data.before && formValueOfSide(data.before)
  const savedValue = data.after && (undo?.saved ?? formValueOfSide(data.after))
  const isUndone = (change: EntryChange) => !!heldKeys && !heldKeys.has(change.key)
  const allUndone = undoable && diff.changes.every(isUndone)
  // The form holds `change` as neither the side it was last set to has it, the saved value
  // or, once undone, the base's: an edit made since, which an undo or redo would replace.
  const editedSince = (change: EntryChange): boolean =>
    !!undo &&
    !!savedValue &&
    !!baseValue &&
    !holdsAs(undo.value, isUndone(change) ? baseValue : savedValue, change, bodyField)
  const cardUndo = (change: EntryChange): CardUndo | undefined => {
    if (!undoable || !undo || !baseValue || !savedValue) return undefined
    const held = isUndone(change)
    const source = held ? savedValue : baseValue
    const placeable = !!setChangeBack(undo.value, source, change, bodyField)
    // A change the form can't take back, such as one inside an item it no longer has, isn't
    // offered as undone.
    const undone = held && placeable
    return {
      undone,
      reason:
        lockedReason ??
        (!placeable ? NOT_IN_FORM_REASON : editedSince(change) ? UNSAVED_EDIT_REASON : undefined),
      note: undone ? notes[change.key] : undefined,
      onToggle: () => {
        // Taking out an item the branch added moves its threads to the entry, as a Remove does.
        const path =
          !undone && change.item && change.kind === 'added'
            ? canopyPathOf(undo.value, change, bodyField)
            : undefined
        const note = path && undo.threadsWithin && movedThreadsNote(undo.threadsWithin(path))
        setNotes(({ [change.key]: _dropped, ...rest }) =>
          note ? { ...rest, [change.key]: note } : rest,
        )
        const where = change.path.join(' › ')
        announce(
          undone
            ? `Redone: ${where}.`
            : [`Undone: ${where}. Save to keep it.`, note].filter(Boolean).join(' '),
        )
        undo.update((value) => setChangeBack(value, source, change, bodyField) ?? value)
      },
    }
  }
  const sameCollection =
    !!subject.from &&
    subject.from.slice(0, subject.from.lastIndexOf('/')) ===
      subject.logicalPath.slice(0, subject.logicalPath.lastIndexOf('/'))
  const editable = !noEditReason
  const restorable = !!data.before && !data.after && !!onRestoreEntry
  // With one change, its card's "Undo change" is the whole of "Undo all changes".
  const undoAll = undoable && count > 1
  const entryControls = editable && (undoAll || (!data.before && onDeleteEntry) || restorable)
  const restore = async () => {
    if (!onRestoreEntry || restoring) return
    setRestoring(true)
    setRestoreRefusal(undefined)
    try {
      setRestoreRefusal(await onRestoreEntry())
    } finally {
      setRestoring(false)
    }
  }

  return (
    <Stack gap="sm">
      <StatusRegion>
        {movedFrom && (
          <Text size="sm" style={{ overflowWrap: 'anywhere' }} data-testid="entry-changes-moved">
            Moved from {movedFrom}
          </Text>
        )}
        {summary && (
          <Text size="sm" data-testid="entry-changes-summary">
            {summary}
          </Text>
        )}
      </StatusRegion>
      {errorNotice}
      {undoable && (
        <VisuallyHidden role="status" data-testid="entry-changes-announcement">
          {announcement && <span key={announcement.id}>{announcement.text}</span>}
        </VisuallyHidden>
      )}
      {subject.unsavedEdits && !undoable && (
        <Alert
          variant="light"
          color="blue"
          icon={<IconInfoCircle size={16} />}
          data-testid="entry-changes-unsaved"
        >
          <Text size="sm">Unsaved edits aren’t included. Save to include them.</Text>
        </Alert>
      )}
      {noEditReason && (
        <Text size="sm" data-testid="entry-changes-no-edit">
          {noEditReason}
        </Text>
      )}
      {editable && undo && typeChanged && (
        <Text size="sm" data-testid="entry-changes-type-changed">
          This entry’s type changed on this branch, so its changes can’t be undone here.
        </Text>
      )}
      {editable && undo && movedFrom && (
        <Text size="sm" data-testid="entry-changes-move-hint">
          Undoing changes doesn’t move the entry back.
          {sameCollection && ` To move it back, use "${EDITOR_ACTIONS.changeUrl}…".`}
        </Text>
      )}
      {editable && lockedReason && (undoable || entryControls) && (
        <Text size="sm" data-testid="entry-changes-locked">
          {lockedReason}
        </Text>
      )}
      {entryControls && (
        <Group gap="xs" wrap="wrap" align="center">
          {undoAll && undo && baseValue && savedValue && (
            <ReasonedButton
              reason={
                lockedReason ?? (diff.changes.some(editedSince) ? UNSAVED_EDITS_REASON : undefined)
              }
              onClick={() => {
                if (allUndone) {
                  setNotes({})
                  announce('All changes redone in the form.')
                  undo.update((value) => setAllBack(value, savedValue, diff.changes, bodyField))
                  return
                }
                // Taking out the items the branch added moves their threads, as a Remove does.
                const moved = diff.changes.flatMap((change) => {
                  if (isUndone(change) || !change.item || change.kind !== 'added') return []
                  const path = canopyPathOf(undo.value, change, bodyField)
                  const count = path && undo.threadsWithin ? undo.threadsWithin(path) : 0
                  return count > 0 ? [{ key: change.key, count }] : []
                })
                setNotes(
                  Object.fromEntries(
                    moved.map(({ key, count }) => [key, movedThreadsNote(count) ?? '']),
                  ),
                )
                const total = moved.reduce((sum, { count }) => sum + count, 0)
                announce([ALL_UNDONE_IN_FORM, movedThreadsNote(total)].filter(Boolean).join(' '))
                undo.update((value) => setAllBack(value, baseValue, diff.changes, bodyField))
              }}
              data-testid="entry-changes-undo-all"
            >
              {allUndone ? EDITOR_ACTIONS.redoAllChanges : EDITOR_ACTIONS.undoAllChanges}
            </ReasonedButton>
          )}
          {!data.before && onDeleteEntry && (
            <ReasonedButton
              reason={lockedReason}
              onClick={onDeleteEntry}
              danger
              data-testid="entry-changes-delete"
            >
              {EDITOR_ACTIONS.deleteEntry}
            </ReasonedButton>
          )}
          {restorable && (
            <ReasonedButton
              reason={lockedReason}
              onClick={() => void restore()}
              loading={restoring}
              data-testid="entry-changes-restore"
            >
              {EDITOR_ACTIONS.restoreEntry}
            </ReasonedButton>
          )}
        </Group>
      )}
      {undoable && (
        // Its own line, held from the start, so the text arriving with an undo shifts nothing.
        <Text size="xs" mih={20} data-testid="entry-changes-all-undone">
          {allUndone ? ALL_UNDONE_IN_FORM : subject.unsavedEdits ? UNSAVED_IN_FORM : ''}
        </Text>
      )}
      {editable && restoreRefusal && (
        <Alert
          variant="light"
          color={restoreRefusal.tone === 'warning' ? 'yellow' : 'red'}
          icon={
            restoreRefusal.tone === 'warning' ? (
              <IconAlertTriangle size={16} />
            ) : (
              <IconAlertCircle size={16} />
            )
          }
          data-testid="entry-changes-restore-refused"
        >
          <Text size="sm">{restoreRefusal.message}</Text>
        </Alert>
      )}
      {count > 0 && (
        <Stack component="ul" gap="sm" p={0} m={0} style={{ listStyle: 'none' }}>
          {diff.changes.map((change) => (
            <ChangeCard
              key={change.key}
              change={change}
              wholeEntry={wholeEntry}
              undo={editable ? cardUndo(change) : undefined}
            />
          ))}
        </Stack>
      )}
    </Stack>
  )
}

/**
 * A modal right-hand drawer, as the Branches, Comments and Media drawers are: it traps focus,
 * and the form and preview wait behind its backdrop.
 */
export const EntryChangesDrawer: React.FC<EntryChangesDrawerProps> = ({
  opened,
  onClose,
  onExited,
  returnFocusTo,
  ...view
}) => {
  const focusReturn = focusReturnProps(returnFocusTo)
  return (
    <OverlayDrawer
      opened={opened}
      onClose={onClose}
      position="right"
      size={720}
      title={`Changes to ${view.subject.title}`}
      data-testid="entry-changes-drawer"
      {...focusReturn}
      onExitTransitionEnd={() => {
        focusReturn.onExitTransitionEnd?.()
        onExited?.()
      }}
    >
      <EntryChangesView {...view} />
    </OverlayDrawer>
  )
}
