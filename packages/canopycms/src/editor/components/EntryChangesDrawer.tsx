'use client'

/**
 * The "Changes to <title>" drawer: one card per changed field of an entry, its value at the
 * base beside its saved value on the branch. LazyEntryChangesDrawer loads it, so the diff model
 * and jsdiff stay out of the editor's first chunk.
 */

import React, { useMemo, useState } from 'react'
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Group,
  List,
  Paper,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  VisuallyHidden,
} from '@mantine/core'
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowsMove,
  IconInfoCircle,
  IconMinus,
  IconPencil,
  IconPhotoOff,
  IconPlus,
} from '@tabler/icons-react'

import type { BranchChangeEntry } from '../../api/branch-changes'
import type { FieldConfig } from '../../config'
import { EDITOR_THUMBNAIL_WIDTHS } from '../../assets/editor-thumbnail-widths'
import { useAssetContext } from '../context'
import {
  computeEntryDiff,
  type DiffPart,
  type DiffRow,
  type DisplayValue,
  type EntryChange,
  type TextDiff,
} from '../entry-diff'
import type { EntryChangeState } from '../hooks/useBranchChangesData'
import { editorImageSrc } from '../media/editor-image-src'
import { formatRelativeTime } from '../relative-time'
import { OverlayDrawer } from '../shell/OverlayHeader'
import { focusReturnProps } from '../utils/focus-return'

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
}

const KIND_BADGES: Record<EntryChange['kind'], { label: string; icon: React.ReactNode }> = {
  added: { label: 'Added', icon: <IconPlus size={10} aria-hidden /> },
  removed: { label: 'Removed', icon: <IconMinus size={10} aria-hidden /> },
  changed: { label: 'Changed', icon: <IconPencil size={10} aria-hidden /> },
  moved: { label: 'Moved', icon: <IconArrowsMove size={10} aria-hidden /> },
}

/**
 * Struck on a tint at least 1.3:1 from the card in either scheme, with text kept at 4.5:1 on it:
 * `red.2` in light, `red.6` at 30% over the dark card.
 */
const REMOVED_STYLE: React.CSSProperties = {
  background:
    'light-dark(var(--mantine-color-red-2), color-mix(in srgb, var(--mantine-color-red-6) 30%, transparent))',
  color: 'inherit',
  textDecoration: 'line-through',
  textDecorationThickness: 2,
}
/** Underlined on a tint, measured as REMOVED_STYLE's: `green.3`, or `green.6` at 30%. */
const ADDED_STYLE: React.CSSProperties = {
  background:
    'light-dark(var(--mantine-color-green-3), color-mix(in srgb, var(--mantine-color-green-6) 30%, transparent))',
  color: 'inherit',
  textDecoration: 'underline',
  textDecorationThickness: 2,
}
const TEXT_STYLE: React.CSSProperties = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }
/** Long text on one side only is cut to this many lines once it has more than LONG_TEXT_LINES. */
const COLLAPSED_LINES = 50
const LONG_TEXT_LINES = 200
/** Above this share of a line's text changed, one prefix names the whole line instead of each run. */
const WHOLE_LINE_SHARE = 0.6

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const ordinal = (n: number): string => {
  const tens = n % 100
  const suffix =
    tens >= 11 && tens <= 13 ? 'th' : (({ 1: 'st', 2: 'nd', 3: 'rd' } as const)[n % 10] ?? 'th')
  return `${n}${suffix}`
}

type Side = 'before' | 'after'
type Mark = 'removed' | 'added'
interface Run {
  value: string
  mark?: Mark
}

/**
 * `side`'s runs of `parts`, a marked run joined to the next of its mark across whitespace alone,
 * so a screen reader hears one removal, not one per word.
 */
const sideRuns = (parts: readonly DiffPart[], side: Side): Run[] => {
  const runs: Run[] = []
  for (const part of parts) {
    if (side === 'before' ? part.added : part.removed) continue
    const mark: Mark | undefined = part.removed ? 'removed' : part.added ? 'added' : undefined
    const last = runs[runs.length - 1]
    const gap = runs[runs.length - 2]
    if (mark && last && last.mark === mark) {
      last.value += part.value
    } else if (mark && last && !last.mark && /^\s+$/.test(last.value) && gap?.mark === mark) {
      runs.pop()
      gap.value += last.value + part.value
    } else {
      runs.push({ value: part.value, ...(mark && { mark }) })
    }
  }
  return runs
}

const WHITESPACE_MARKS: Record<string, { shown: string; said: string }> = {
  ' ': { shown: '·', said: 'space' },
  '\t': { shown: '→', said: 'tab' },
  '\n': { shown: '⏎', said: 'line break' },
}

/** A run's text; whitespace alone shows a mark for each character, said in words. */
const RunText: React.FC<{ value: string }> = ({ value }) => {
  if (value === '') return <em>blank line</em>
  if (!/^\s+$/.test(value)) return <>{value}</>
  const chars = [...value]
  return (
    <>
      <span aria-hidden>{chars.map((c) => WHITESPACE_MARKS[c]?.shown ?? c).join('')}</span>
      <VisuallyHidden component="span">
        {chars.map((c) => WHITESPACE_MARKS[c]?.said ?? 'space').join(', ')}
      </VisuallyHidden>
    </>
  )
}

const MARK_WORDS: Record<Mark, { start: string; end: string; line: string }> = {
  removed: { start: 'Removed: ', end: ', end of removal', line: 'Removed line: ' },
  added: { start: 'Added: ', end: ', end of addition', line: 'Added line: ' },
}

/**
 * One side's text with its runs marked by a strike or an underline and by words, never colour
 * alone. A line mostly changed says so once, up front, instead of run by run.
 */
const MarkedText: React.FC<{ parts: readonly DiffPart[]; side: Side; unit: 'line' | 'text' }> = ({
  parts,
  side,
  unit,
}) => {
  const runs = sideRuns(parts, side)
  const total = runs.reduce((n, run) => n + run.value.length, 0)
  const marked = runs.reduce((n, run) => n + (run.mark ? run.value.length : 0), 0)
  const mark: Mark = side === 'before' ? 'removed' : 'added'
  const whole = marked > 0 && (total === 0 || marked / total > WHOLE_LINE_SHARE)
  return (
    <>
      {whole && (
        <VisuallyHidden component="span">
          {unit === 'line' ? MARK_WORDS[mark].line : MARK_WORDS[mark].start}
        </VisuallyHidden>
      )}
      {runs.map((run, i) => {
        if (!run.mark) return <React.Fragment key={i}>{run.value}</React.Fragment>
        const Tag = run.mark === 'removed' ? 'del' : 'ins'
        return (
          <Tag key={i} style={run.mark === 'removed' ? REMOVED_STYLE : ADDED_STYLE}>
            {!whole && (
              <VisuallyHidden component="span">{MARK_WORDS[run.mark].start}</VisuallyHidden>
            )}
            <RunText value={run.value} />
            {!whole && <VisuallyHidden component="span">{MARK_WORDS[run.mark].end}</VisuallyHidden>}
          </Tag>
        )
      })}
    </>
  )
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

/**
 * A line diff as aligned rows, so Before and After stay level however many lines one side adds:
 * from `md`, two columns with an empty cell opposite a line the other side lacks; below it, one
 * column with − and + gutters.
 */
const LineRows: React.FC<{ rows: readonly DiffRow[] }> = ({ rows }) => (
  <>
    <Box visibleFrom="md" style={LINE_GRID} data-testid="entry-change-line-grid">
      <Text size="xs" c="dimmed" style={{ gridColumn: '1 / span 2' }}>
        Before
      </Text>
      <Text size="xs" c="dimmed" style={{ gridColumn: '3 / span 2' }}>
        After
      </Text>
      {rows.map((row, i) => {
        if (row.kind === 'skipped') {
          return <Skipped key={i} count={row.count} style={{ gridColumn: '1 / -1' }} />
        }
        if (row.kind === 'same') {
          const text = row.text || ' '
          return (
            <React.Fragment key={i}>
              <Gutter />
              <Text size="sm" style={TEXT_STYLE}>
                {text}
              </Text>
              <Gutter />
              <Text size="sm" style={TEXT_STYLE}>
                {text}
              </Text>
            </React.Fragment>
          )
        }
        return (
          <React.Fragment key={i}>
            <Gutter sign={row.before ? '−' : undefined} />
            <Text size="sm" style={TEXT_STYLE}>
              {row.before ? <MarkedText parts={row.before} side="before" unit="line" /> : null}
            </Text>
            <Gutter sign={row.after ? '+' : undefined} />
            <Text size="sm" style={TEXT_STYLE}>
              {row.after ? <MarkedText parts={row.after} side="after" unit="line" /> : null}
            </Text>
          </React.Fragment>
        )
      })}
    </Box>
    <Box
      hiddenFrom="md"
      style={{ ...LINE_GRID, gridTemplateColumns: '1rem minmax(0, 1fr)' }}
      data-testid="entry-change-line-list"
    >
      {rows.flatMap((row, i) => {
        if (row.kind === 'skipped') {
          return [<Skipped key={i} count={row.count} style={{ gridColumn: '1 / -1' }} />]
        }
        if (row.kind === 'same') {
          return [
            <Gutter key={`${i}g`} />,
            <Text key={i} size="sm" style={TEXT_STYLE}>
              {row.text || ' '}
            </Text>,
          ]
        }
        return (['before', 'after'] as const).flatMap((side) => {
          const parts = row[side]
          if (!parts) return []
          return [
            <Gutter key={`${i}${side}g`} sign={side === 'before' ? '−' : '+'} />,
            <Text key={`${i}${side}`} size="sm" style={TEXT_STYLE}>
              <MarkedText parts={parts} side={side} unit="line" />
            </Text>,
          ]
        })
      })}
    </Box>
  </>
)

const WordsChange: React.FC<{ text: Extract<TextDiff, { mode: 'words' }>; side: Side }> = ({
  text,
  side,
}) => (
  <Text size="sm" style={TEXT_STYLE}>
    <MarkedText parts={text.parts} side={side} unit="text" />
  </Text>
)

const THUMBNAIL_SIZE = EDITOR_THUMBNAIL_WIDTHS.listRow / 2

/** An image's thumbnail beside its name, which says what it is; an icon if it won't load. */
const Thumbnail: React.FC<{ src: string }> = ({ src }) => {
  const { baseUrl } = useAssetContext()
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <IconPhotoOff
        size={THUMBNAIL_SIZE}
        stroke={1.5}
        aria-hidden
        style={{ flexShrink: 0, color: 'var(--mantine-color-dimmed)' }}
      />
    )
  }
  return (
    <img
      src={editorImageSrc(src, baseUrl, { width: EDITOR_THUMBNAIL_WIDTHS.listRow })}
      alt=""
      width={THUMBNAIL_SIZE}
      height={THUMBNAIL_SIZE}
      onError={() => setFailed(true)}
      style={{ objectFit: 'cover', borderRadius: 4, flexShrink: 0 }}
    />
  )
}

/** Text on one side only; more than LONG_TEXT_LINES lines show COLLAPSED_LINES until asked. */
const LongText: React.FC<{ text: string }> = ({ text }) => {
  const [expanded, setExpanded] = useState(false)
  const lines = text.split('\n')
  const collapsed = !expanded && lines.length > LONG_TEXT_LINES
  return (
    <Stack gap={4} align="flex-start">
      <Text size="sm" style={TEXT_STYLE}>
        {collapsed ? lines.slice(0, COLLAPSED_LINES).join('\n') : text}
      </Text>
      {collapsed && (
        <Button size="compact-sm" variant="subtle" onClick={() => setExpanded(true)}>
          Show all {lines.length} lines
        </Button>
      )}
    </Stack>
  )
}

/** A value as the form would show it: titles for references, file names for images. */
const Value: React.FC<{ value: DisplayValue; alt?: { text: TextDiff; side: Side } }> = ({
  value,
  alt,
}) => {
  switch (value.kind) {
    case 'empty':
      return (
        <Text size="sm" c="dimmed">
          Not set
        </Text>
      )
    case 'text':
      return <LongText text={value.text} />
    case 'number':
      return <Text size="sm">{value.value.toLocaleString()}</Text>
    case 'boolean':
      return <Text size="sm">{value.value ? 'Yes' : 'No'}</Text>
    case 'date':
      return <DateValue value={value} />
    case 'select':
      return <Text size="sm">{value.label}</Text>
    case 'reference':
      return value.title !== undefined ? (
        <Text size="sm">{value.title}</Text>
      ) : (
        <Text size="sm" c="dimmed">
          Entry unavailable
        </Text>
      )
    case 'image':
      return (
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <Thumbnail key={value.src} src={value.src} />
          <Stack gap={0} miw={0}>
            <Text size="sm" style={TEXT_STYLE}>
              {value.name}
            </Text>
            {value.alt && (
              <Text size="xs" style={TEXT_STYLE}>
                <Text span size="xs" c="dimmed">
                  Alt text:{' '}
                </Text>
                {alt?.text.mode === 'words' ? (
                  <MarkedText parts={alt.text.parts} side={alt.side} unit="text" />
                ) : (
                  value.alt
                )}
              </Text>
            )}
          </Stack>
        </Group>
      )
    case 'position':
      return (
        <Text size="sm">
          {ordinal(value.position)} of {value.of}
        </Text>
      )
    case 'list':
      return (
        <List size="sm" spacing={4}>
          {value.items.map((item, i) => (
            <List.Item key={i}>
              <Value value={item} />
            </List.Item>
          ))}
        </List>
      )
    case 'fields':
      return (
        <Stack gap={6}>
          {value.fields.map((field, i) => (
            <div key={i}>
              <Text size="xs" fw={500}>
                {field.label}
              </Text>
              <Value value={field.value} />
            </div>
          ))}
        </Stack>
      )
    case 'raw':
      return (
        <Text size="xs" ff="monospace" style={TEXT_STYLE}>
          {value.text}
        </Text>
      )
  }
}

/**
 * A date in full, in the viewer's time zone: a comparison needs the value, so this is the one
 * place the editor shows a date absolute first and relative after.
 */
const DateValue: React.FC<{
  value: Extract<DisplayValue, { kind: 'date' }>
  text?: React.ReactNode
}> = ({ value, text }) => (
  <Stack gap={0}>
    <Text size="sm" style={TEXT_STYLE}>
      {text ?? value.text}
    </Text>
    <Text size="xs" c="dimmed">
      {formatRelativeTime(value.dateOnly ? `${value.iso}T00:00:00` : value.iso)}
    </Text>
  </Stack>
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

/** One change: its labelled breadcrumb, its kind in a word, and the values on each side. */
const ChangeCard: React.FC<{ change: EntryChange; wholeEntry: Side | undefined }> = ({
  change,
  wholeEntry,
}) => {
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
    </Paper>
  )
}

const LoadingCards: React.FC = () => (
  <Stack gap="sm" data-testid="entry-changes-loading" aria-busy="true">
    <VisuallyHidden>Loading changes…</VisuallyHidden>
    <Skeleton height={22} width="45%" />
    {[0, 1, 2].map((i) => (
      <Skeleton key={i} height={96} radius="sm" />
    ))}
  </Stack>
)

const REFUSALS = {
  tooLarge: 'This entry is too large to compare here.',
  notFound: 'This entry isn’t on this branch or its base.',
  unreadable: 'This entry couldn’t be read on one side, so it can’t be compared.',
} as const

/** "3 fields changed since main", "2 fields changed, 1 item moved since main". */
const changeSummary = (changes: readonly EntryChange[], base: string): string => {
  const moved = changes.filter((c) => c.kind === 'moved').length
  const changed = changes.length - moved
  const parts = [
    ...(changed > 0 ? [`${plural(changed, 'field', 'fields')} changed`] : []),
    ...(moved > 0 ? [`${plural(moved, 'item', 'items')} moved`] : []),
  ]
  return `${parts.join(', ')} since ${base}`
}

/** The drawer's body: its states, then the summary and one card per change. */
export const EntryChangesView: React.FC<
  Omit<EntryChangesDrawerProps, 'opened' | 'onClose' | 'onExited' | 'returnFocusTo'>
> = ({ base, subject, state, referenceTitle, onOpenEntry, pullRequestUrl }) => {
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

  // A refusal no retry passes: its reason, and the ways the entry can still be looked at.
  const refusal =
    error?.kind === 'tooLarge' || error?.kind === 'notFound' || error?.kind === 'unreadable'
      ? error.kind
      : undefined
  if (refusal) {
    return (
      <Stack gap="xs" align="flex-start" data-testid={`entry-changes-${refusal}`}>
        <Text size="sm">{REFUSALS[refusal]}</Text>
        <Group gap="xs">
          {onOpenEntry && (
            <Button size="compact-sm" variant="subtle" onClick={onOpenEntry}>
              Open the entry
            </Button>
          )}
          {pullRequestUrl && (
            <Anchor href={pullRequestUrl} target="_blank" rel="noopener noreferrer" size="sm">
              Compare on the pull request
            </Anchor>
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
    return <Stack gap="sm">{errorNotice || <LoadingCards />}</Stack>
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

  return (
    <Stack gap="sm">
      {errorNotice}
      <Stack gap={2}>
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
      </Stack>
      {subject.unsavedEdits && (
        <Alert
          variant="light"
          color="blue"
          icon={<IconInfoCircle size={16} />}
          data-testid="entry-changes-unsaved"
        >
          <Text size="sm">Unsaved edits aren’t included. Save to include them.</Text>
        </Alert>
      )}
      {count > 0 && (
        <Stack component="ul" gap="sm" p={0} m={0} style={{ listStyle: 'none' }}>
          {diff.changes.map((change) => (
            <ChangeCard key={change.key} change={change} wholeEntry={wholeEntry} />
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
