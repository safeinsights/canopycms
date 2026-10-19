'use client'

import React, { useEffect, useRef, useState } from 'react'

import { Alert, Button, Paper, Select, Skeleton, Stack, Text } from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'

import { useFieldCommentControl } from '../comments/field-comment-context'
import { ExpandAllButton } from './ExpandAllButton'
import { groupDescriptionProps } from './FieldDescription'
import { FieldLabel } from './FieldLabel'
import { ItemList } from './ItemList'
import { useItemExpansion } from './item-expansion'
import { useListItemKeys } from './list-item-keys'
import {
  extractId,
  unlistedReferenceLabel,
  useReferenceOptions,
  type ReferenceOption,
} from './use-reference-options'

export interface ReferenceListFieldProps {
  /** Base for the description's id. */
  id: string
  label: string
  description?: string
  required?: boolean
  /** Offered as given; without them, options load from the API. */
  options?: ReferenceOption[]
  collections?: string[]
  entryTypes?: string[]
  displayField?: string
  branch?: string
  /** The stored items: ids, or a resolved read's `{ id, … }`. */
  value: readonly unknown[]
  /** Always given ids. */
  onChange: (next: string[]) => void
  path: Array<string | number>
  /** The list's canopy path, which picks its comment control. */
  canopyPath: string
  readOnly?: boolean
  /** Names the entry being edited; another entry starts with the default rows open. */
  resetKey: string
  /** The most picks the list holds; the Add control gives way to a note at it. */
  maxItems?: number
  /** The validation error on item `index`, if any. */
  itemError?: (index: number) => string | undefined
  /** Called after Remove takes item `index` out, so the caller can offer Undo. */
  onRemoved?: (index: number, id: string, title: string) => void
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many)

/**
 * A `list: true` reference field: one collapsible row per pick, in stored order, reordered by drag
 * or the row menu. A row's body repoints that pick in place; an Add control under the rows appends
 * and keeps focus, so several picks are several choices in a row. Neither control offers an entry
 * another row holds, so no edit makes a duplicate. Comments attach to the whole field: a string
 * item carries no item key for a thread to follow through a move.
 */
export const ReferenceListField: React.FC<ReferenceListFieldProps> = ({
  id,
  label,
  description,
  required,
  options: staticOptions,
  collections,
  entryTypes,
  displayField = 'title',
  branch = 'main',
  value,
  onChange,
  path,
  canopyPath,
  readOnly = false,
  resetKey,
  maxItems,
  itemError,
  onRemoved,
}) => {
  const commentControl = useFieldCommentControl(canopyPath)
  const { options, loading, error, retry } = useReferenceOptions({
    staticOptions,
    collections,
    entryTypes,
    displayField,
    branch,
  })
  const ids = value.map(extractId)
  const keysFor = useListItemKeys()
  const itemKeys = keysFor(ids, 'references')
  // A collapsed row already names its entry; it opens only to swap that entry.
  const expansion = useItemExpansion(itemKeys, resetKey, { rowsStartOpen: false })
  const [announcement, setAnnouncement] = useState<{ message: string }>()
  const [addSearch, setAddSearch] = useState('')
  // The pick that reaches `maxItems` unmounts the focused Add control; its note takes focus instead.
  const capNoteRef = useRef<HTMLParagraphElement>(null)
  const focusCapNoteRef = useRef(false)
  useEffect(() => {
    if (!focusCapNoteRef.current) return
    focusCapNoteRef.current = false
    capNoteRef.current?.focus()
  })

  const labels = new Map(options.map((option) => [option.value, option.label]))
  // Until options settle, a title is unknown rather than unlisted, and after a failed load: either
  // way the id is all there is to show (a Remove's Undo toast names it).
  const titleOf = (index: number): string => {
    const itemId = ids[index]
    if (!itemId) return 'No entry picked'
    return (
      labels.get(itemId) ??
      (loading || error ? itemId : unlistedReferenceLabel(value[index], itemId))
    )
  }

  const picked = new Set(ids)
  const atCap = maxItems !== undefined && ids.length >= maxItems

  /** Row `index`'s choices: every option no other row holds, plus its own pick. */
  const rowOptions = (index: number): ReferenceOption[] => {
    const own = ids[index]
    const elsewhere = new Set(ids.filter((_, i) => i !== index))
    const offered = options.filter((option) => option.value === own || !elsewhere.has(option.value))
    return own && !labels.has(own) ? [...offered, { value: own, label: titleOf(index) }] : offered
  }

  const emit = (next: string[]) => {
    if (!readOnly) onChange(next)
  }

  const add = (pick: string) => {
    if (picked.has(pick) || atCap) return
    const count = ids.length + 1
    setAnnouncement({
      message: `${labels.get(pick) ?? pick} added, position ${count} of ${count}.`,
    })
    setAddSearch('')
    if (maxItems !== undefined && count >= maxItems) focusCapNoteRef.current = true
    emit([...ids, pick])
  }

  const capNote =
    maxItems === undefined
      ? undefined
      : ids.length > maxItems
        ? `${ids.length} picked, but at most ${maxItems} ${plural(maxItems, 'is', 'are')} allowed. Remove ${ids.length - maxItems} to save.`
        : `${ids.length} of ${maxItems} picked. Open a row to swap its entry, or remove one to add another.`

  return (
    <Paper
      withBorder
      p="md"
      shadow="xs"
      {...groupDescriptionProps(id, description)}
      role="group"
      aria-label={label}
      data-removal-focus
      tabIndex={-1}
      data-testid={`reference-list-${canopyPath}`}
    >
      <Stack gap="sm">
        <FieldLabel
          label={label}
          required={required}
          description={description}
          descriptionBaseId={id}
          commentControl={commentControl}
          actions={ids.length > 1 && <ExpandAllButton expansion={expansion} />}
        />
        {error && (
          <Alert
            icon={<IconAlertCircle size={16} />}
            color="red"
            title="Couldn't load the entries to pick from"
            data-testid="reference-list-error"
          >
            <Stack gap={4} align="flex-start">
              <Text size="sm">{error}</Text>
              <Button variant="light" size="xs" onClick={retry}>
                Retry
              </Button>
            </Stack>
          </Alert>
        )}
        <ItemList
          items={value}
          itemKeys={itemKeys}
          path={path}
          readOnly={readOnly}
          expansion={expansion}
          announcement={announcement}
          summarize={(_, idx) =>
            loading ? { title: 'Loading…', pending: true } : { title: titleOf(idx) }
          }
          hasErrors={itemError ? (idx) => itemError(idx) !== undefined : undefined}
          onMove={(from, to) => {
            if (from === to || to < 0 || to >= ids.length) return
            const next = [...ids]
            const [moved] = next.splice(from, 1)
            next.splice(to, 0, moved)
            emit(next)
          }}
          onRemove={(idx) => {
            if (readOnly) return
            const title = titleOf(idx)
            emit(ids.filter((_, i) => i !== idx))
            onRemoved?.(idx, ids[idx], title)
          }}
          renderItem={(_, idx) =>
            loading ? (
              <Skeleton height={36} />
            ) : (
              <Select
                label="Entry"
                data={rowOptions(idx)}
                value={ids[idx] || null}
                readOnly={readOnly}
                rightSection={readOnly ? <span /> : undefined}
                onChange={(next) => {
                  if (!next || next === ids[idx]) return
                  const updated = [...ids]
                  updated[idx] = next
                  emit(updated)
                }}
                error={itemError?.(idx)}
                // No `selectFirstOptionOnChange` here: with the row's own title in the box every
                // option shows, so Enter would repoint the row to the first.
                searchable
                allowDeselect={false}
                nothingFoundMessage="No entries match"
                size="sm"
                data-testid="reference-list-row-select"
              />
            )
          }
        />
        {!loading && ids.length === 0 && (
          <Text size="sm" c="dimmed">
            {readOnly ? 'Nothing picked.' : 'Nothing picked yet.'}
          </Text>
        )}
        {!readOnly &&
          (atCap ? (
            <Text
              ref={capNoteRef}
              tabIndex={-1}
              size="sm"
              c="dimmed"
              data-testid="reference-list-cap"
            >
              {capNote}
            </Text>
          ) : loading ? (
            <Skeleton height={36} data-testid="reference-list-add-pending" />
          ) : error ? null : (
            <Select
              aria-label={`Add to ${label}`}
              placeholder="Search to add an entry"
              data={options.filter((option) => !picked.has(option.value))}
              value={null}
              searchValue={addSearch}
              onSearchChange={setAddSearch}
              onChange={(next) => {
                if (next) add(next)
              }}
              searchable
              // So typing part of a title and pressing Enter picks it.
              selectFirstOptionOnChange
              nothingFoundMessage={
                options.length > 0 && options.every((option) => picked.has(option.value))
                  ? 'Every entry is already picked'
                  : 'No entries match'
              }
              size="sm"
              data-testid="reference-list-add"
            />
          ))}
      </Stack>
    </Paper>
  )
}
