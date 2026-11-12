'use client'

/**
 * How the "Show changes" drawer shows a value and a text change, shared by its change cards and its
 * conflict cards: marked text, values as the form would show them, and the drawer's reasoned button.
 */

import React, { useEffect, useRef, useState } from 'react'
import { Button, Group, List, Stack, Text, Tooltip, VisuallyHidden } from '@mantine/core'
import { IconPhotoOff } from '@tabler/icons-react'

import { EDITOR_THUMBNAIL_WIDTHS } from '../../assets/editor-thumbnail-widths'
import { useAssetContext } from '../context'
import type { DiffPart, DisplayValue, TextDiff } from '../entry-diff'
import { editorImageSrc } from '../media/editor-image-src'
import { formatRelativeTime } from '../relative-time'

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
export const TEXT_STYLE: React.CSSProperties = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }
/** Long text on one side only is cut to this many lines once it has more than LONG_TEXT_LINES. */
const COLLAPSED_LINES = 50
const LONG_TEXT_LINES = 200
/** Above this share of a line's text changed, one prefix names the whole line instead of each run. */
const WHOLE_LINE_SHARE = 0.6

export const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`

export const ordinal = (n: number): string => {
  const tens = n % 100
  const suffix =
    tens >= 11 && tens <= 13 ? 'th' : (({ 1: 'st', 2: 'nd', 3: 'rd' } as const)[n % 10] ?? 'th')
  return `${n}${suffix}`
}

export type Side = 'before' | 'after'
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
  if (value === '') return <em>(blank line)</em>
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
export const MarkedText: React.FC<{
  parts: readonly DiffPart[]
  side: Side
  unit: 'line' | 'text'
}> = ({ parts, side, unit }) => {
  const runs = sideRuns(parts, side)
  const total = runs.reduce((n, run) => n + run.value.length, 0)
  const marked = runs.reduce((n, run) => n + (run.mark ? run.value.length : 0), 0)
  const mark: Mark = side === 'before' ? 'removed' : 'added'
  const whole = runs.some((run) => run.mark) && (total === 0 || marked / total > WHOLE_LINE_SHARE)
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
        const style = run.mark === 'removed' ? REMOVED_STYLE : ADDED_STYLE
        // Whitespace alone, or a blank line's label, has nothing for a line to cross.
        const shown = /^\s*$/.test(run.value) ? { ...style, textDecoration: 'none' } : style
        return (
          <Tag key={i} style={shown}>
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
  const firstNew = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (expanded) firstNew.current?.focus()
  }, [expanded])
  const lines = text.split('\n')
  const long = lines.length > LONG_TEXT_LINES
  const collapsed = !expanded && long
  return (
    <Stack gap={4} align="flex-start">
      <Text size="sm" style={TEXT_STYLE}>
        {!long ? (
          text
        ) : (
          <>
            {lines.slice(0, COLLAPSED_LINES).join('\n')}
            {expanded && (
              <>
                {'\n'}
                <span ref={firstNew} tabIndex={-1}>
                  {lines.slice(COLLAPSED_LINES).join('\n')}
                </span>
              </>
            )}
          </>
        )}
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
export const Value: React.FC<{ value: DisplayValue; alt?: { text: TextDiff; side: Side } }> = ({
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
 * place the editor shows a date absolute first and relative after. A day has no relative form: it
 * may be a future event, and a past one is not hours ago.
 */
export const DateValue: React.FC<{
  value: Extract<DisplayValue, { kind: 'date' }>
  text?: React.ReactNode
}> = ({ value, text }) => (
  <Stack gap={0}>
    <Text size="sm" style={TEXT_STYLE}>
      {text ?? value.text}
    </Text>
    {!value.dateOnly && (
      <Text size="xs" c="dimmed">
        {formatRelativeTime(value.iso)}
      </Text>
    )}
  </Stack>
)

/**
 * A drawer control that, given a `reason`, stays focusable but doesn't act, its Tooltip saying
 * why (`data-disabled` keeps the Tooltip working on focus and touch).
 */
export const ReasonedButton: React.FC<{
  reason?: string
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
  loading?: boolean
  'aria-label'?: string
  'data-testid'?: string
}> = ({ reason, onClick, danger, ...props }) => (
  <Tooltip label={reason} disabled={!reason} multiline maw={280} position="bottom-start">
    <Button
      size="compact-sm"
      variant="subtle"
      {...(danger && { color: 'red', c: 'var(--canopy-danger-text)' })}
      {...props}
      onClick={() => {
        if (!reason) onClick()
      }}
      data-disabled={reason ? true : undefined}
      aria-disabled={reason ? true : undefined}
    />
  </Tooltip>
)
