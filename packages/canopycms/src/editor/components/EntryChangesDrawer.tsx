'use client'

/**
 * The "Changes to <title>" drawer: one card per changed field of an entry, its value at the
 * base beside its saved value on the branch. Editor.tsx loads it with `React.lazy`, so the diff
 * model and jsdiff stay out of the editor's first chunk.
 */

import React, { useMemo, useState } from 'react'
import {
  Alert,
  Badge,
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
  type DiffLine,
  type DiffPart,
  type DisplayValue,
  type EntryChange,
  type TextDiff,
} from '../entry-diff'
import type { EntryChangeState } from '../hooks/useBranchChangesData'
import { editorImageSrc } from '../media/editor-image-src'
import { OverlayDrawer } from '../shell/OverlayHeader'
import { focusReturnProps } from '../utils/focus-return'
import { RelativeTime } from './RelativeTime'

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
}

const KIND_BADGES: Record<EntryChange['kind'], { label: string; icon: React.ReactNode }> = {
  added: { label: 'Added', icon: <IconPlus size={10} aria-hidden /> },
  removed: { label: 'Removed', icon: <IconMinus size={10} aria-hidden /> },
  changed: { label: 'Changed', icon: <IconPencil size={10} aria-hidden /> },
  moved: { label: 'Moved', icon: <IconArrowsMove size={10} aria-hidden /> },
}

/** Struck on a tint; the theme's light variants keep text at 4.5:1 in both schemes. */
const REMOVED_STYLE: React.CSSProperties = {
  background: 'var(--mantine-color-red-light)',
  color: 'inherit',
  textDecoration: 'line-through',
}
/** Underlined on a tint. */
const ADDED_STYLE: React.CSSProperties = {
  background: 'var(--mantine-color-green-light)',
  color: 'inherit',
  textDecoration: 'underline',
}
const TEXT_STYLE: React.CSSProperties = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** A run the other side lacks: marked by a strike or underline and by words, never colour alone. */
const Marked: React.FC<{ part: DiffPart }> = ({ part }) => {
  const content = part.value === '' ? <em>blank line</em> : part.value
  if (part.removed) {
    return (
      <del style={REMOVED_STYLE}>
        <VisuallyHidden component="span">Removed: </VisuallyHidden>
        {content}
      </del>
    )
  }
  if (part.added) {
    return (
      <ins style={ADDED_STYLE}>
        <VisuallyHidden component="span">Added: </VisuallyHidden>
        {content}
      </ins>
    )
  }
  return <>{part.value}</>
}

type Side = 'before' | 'after'

const onSide = (side: Side) => (part: DiffPart) => (side === 'before' ? !part.added : !part.removed)

/** One side of a line diff: its unchanged lines, its own changed lines, and the skipped runs. */
const DiffLines: React.FC<{ lines: DiffLine[]; side: Side }> = ({ lines, side }) => (
  <Stack gap={0}>
    {lines.map((line, i) => {
      if (line.kind === 'skipped') {
        return (
          <Text key={i} size="xs" c="dimmed" py={2}>
            {plural(line.count, 'unchanged line', 'unchanged lines')}
          </Text>
        )
      }
      if (line.kind === 'same') {
        return (
          <Text key={i} size="sm" style={TEXT_STYLE}>
            {line.text || ' '}
          </Text>
        )
      }
      if ((line.kind === 'removed') !== (side === 'before')) return null
      return (
        <Text key={i} size="sm" style={TEXT_STYLE}>
          {line.parts.map((part, n) => (
            <Marked key={n} part={part} />
          ))}
        </Text>
      )
    })}
  </Stack>
)

const TextChange: React.FC<{ text: TextDiff; side: Side }> = ({ text, side }) =>
  text.mode === 'lines' ? (
    <DiffLines lines={text.lines} side={side} />
  ) : (
    <Text size="sm" style={TEXT_STYLE}>
      {text.parts.filter(onSide(side)).map((part, n) => (
        <Marked key={n} part={part} />
      ))}
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

/** A value as the form would show it: titles for references, file names for images. */
const Value: React.FC<{ value: DisplayValue }> = ({ value }) => {
  switch (value.kind) {
    case 'empty':
      return (
        <Text size="sm" c="dimmed">
          Not set
        </Text>
      )
    case 'text':
      return (
        <Text size="sm" style={TEXT_STYLE}>
          {value.text}
        </Text>
      )
    case 'number':
      return <Text size="sm">{value.value.toLocaleString()}</Text>
    case 'boolean':
      return <Text size="sm">{value.value ? 'Yes' : 'No'}</Text>
    case 'date':
      // A date-only value is read as local midnight.
      return <RelativeTime size="sm" iso={value.dateOnly ? `${value.iso}T00:00:00` : value.iso} />
    case 'select':
      return <Text size="sm">{value.label}</Text>
    case 'reference':
      return value.title !== undefined ? (
        <Text size="sm">{value.title}</Text>
      ) : (
        <Text size="sm">
          Unknown entry{' '}
          <Text span size="xs" c="dimmed">
            {value.id}
          </Text>
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
              <Text size="xs" c="dimmed" style={TEXT_STYLE}>
                Alt text: {value.alt}
              </Text>
            )}
          </Stack>
        </Group>
      )
    case 'position':
      return <Text size="sm">Position {value.position}</Text>
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

const SideColumn: React.FC<{ label: string; change: EntryChange; side: Side }> = ({
  label,
  change,
  side,
}) => {
  const value = change[side]
  return (
    <Stack gap={4} miw={0}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      {change.text ? (
        <TextChange text={change.text} side={side} />
      ) : (
        <Value value={value ?? { kind: 'empty' }} />
      )}
    </Stack>
  )
}

/** One change: its labelled breadcrumb, its kind in a word, and the values on each side. */
const ChangeCard: React.FC<{ change: EntryChange; wholeEntry: Side | undefined }> = ({
  change,
  wholeEntry,
}) => (
  <Paper withBorder p="sm" radius="sm" component="li" data-testid="entry-change-card">
    <Group gap="xs" justify="space-between" wrap="nowrap" mb="xs" align="flex-start">
      <Text size="sm" fw={500} miw={0} style={{ overflowWrap: 'anywhere' }}>
        {change.path.join(' › ')}
      </Text>
      {!wholeEntry && (
        <Badge
          size="xs"
          variant="light"
          color="gray"
          leftSection={KIND_BADGES[change.kind].icon}
          style={{ flexShrink: 0 }}
        >
          {KIND_BADGES[change.kind].label}
        </Badge>
      )}
    </Group>
    {wholeEntry ? (
      <Value value={change[wholeEntry] ?? { kind: 'empty' }} />
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

const LoadingCards: React.FC = () => (
  <Stack gap="sm" data-testid="entry-changes-loading" aria-busy="true">
    <Skeleton height={14} width="45%" />
    {[0, 1, 2].map((i) => (
      <Skeleton key={i} height={96} radius="sm" />
    ))}
  </Stack>
)

/** The drawer's body: its states, then the summary and one card per change. */
export const EntryChangesView: React.FC<Omit<EntryChangesDrawerProps, 'opened' | 'onClose'>> = ({
  base,
  subject,
  state,
  referenceTitle,
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

  const errorNotice = error && (
    <>
      {error.kind === 'tooLarge' || error.kind === 'unavailable' ? (
        <Text size="sm" data-testid={`entry-changes-${error.kind}`}>
          {error.kind === 'tooLarge'
            ? 'This entry is too large to compare here.'
            : 'This entry can’t be compared.'}
        </Text>
      ) : (
        <Alert
          variant="light"
          color={error.kind === 'syncing' ? 'yellow' : 'red'}
          icon={
            error.kind === 'syncing' ? (
              <IconAlertTriangle size={16} />
            ) : (
              <IconAlertCircle size={16} />
            )
          }
          data-testid={`entry-changes-${error.kind}`}
        >
          <Stack gap={4} align="flex-start">
            <Text size="sm">
              {error.kind === 'syncing'
                ? (error.message ??
                  `This branch is being synced with ${base}. Try again in a moment.`)
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
      )}
    </>
  )

  // A refusal no retry passes replaces what was shown; any other error keeps it beneath.
  const refused = error?.kind === 'tooLarge' || error?.kind === 'unavailable'
  if (!data || !diff || refused) {
    return <Stack gap="sm">{errorNotice ?? <LoadingCards />}</Stack>
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
        ? `${plural(count, 'field', 'fields')} changed since ${base}`
        : movedFrom
          ? undefined
          : 'Only formatting changed; no field values differ.'

  return (
    <Stack gap="sm">
      {errorNotice}
      <Stack gap={2}>
        {movedFrom && (
          <Text size="sm" data-testid="entry-changes-moved">
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
