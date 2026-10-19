'use client'

import React from 'react'

import { Alert, Badge, Group, type ComboboxItem } from '@mantine/core'
import { IconAlertTriangle, IconCheck } from '@tabler/icons-react'

import type { ReferenceOption } from './use-reference-options'

/** The badge on a picked or offered entry whose own form hides it from search. */
export const HIDDEN_FROM_SEARCH = 'Hidden from search'

export const HiddenFromSearchBadge: React.FC = () => (
  <Badge variant="light" color="yellow" size="sm" tt="none" style={{ flexShrink: 0 }}>
    {HIDDEN_FROM_SEARCH}
  </Badge>
)

/**
 * A reference Select's `renderOption`: the label, with the badge on a hidden entry. Draws the
 * check mark itself, since a custom option replaces Mantine's.
 */
export function referenceOptionRenderer(options: readonly ReferenceOption[]) {
  const hiddenValues = new Set(options.flatMap((o) => (o.noindex ? [o.value] : [])))
  return function ReferenceOptionLabel({
    option,
    checked,
  }: {
    option: ComboboxItem
    checked?: boolean
  }) {
    const hidden = hiddenValues.has(option.value)
    return (
      <Group gap={6} wrap="nowrap" w="100%">
        <IconCheck aria-hidden size={14} style={{ visibility: checked ? 'visible' : 'hidden' }} />
        <span style={{ flex: 1, minWidth: 0 }}>{option.label}</span>
        {hidden && <HiddenFromSearchBadge />}
      </Group>
    )
  }
}

/** A pick whose target is hidden from search, as the note names it. */
export interface HiddenPick {
  label: string
  fieldLabel: string
}

const quoted = (label: string) => `‘${label}’`

const listNames = (names: string[]): string =>
  names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

/**
 * One sentence per noindex field label, since entry types can label that field differently:
 * "‘A’ has “Hide from search engines” turned on, so pages that list only visible entries won't
 * show it."
 * @internal Exported for tests.
 */
export function hiddenPickSentences(picks: readonly HiddenPick[]): string[] {
  const byField = new Map<string, string[]>()
  for (const pick of picks) {
    byField.set(pick.fieldLabel, [...(byField.get(pick.fieldLabel) ?? []), quoted(pick.label)])
  }
  return [...byField].map(([fieldLabel, names]) => {
    const one = names.length === 1
    return (
      `${listNames(names)} ${one ? 'has' : 'have'} “${fieldLabel}” turned on, so pages ` +
      `that list only visible entries won't show ${one ? 'it' : 'them'}.`
    )
  })
}

/**
 * The yellow note above a reference field's input or list, under its heading. It warns rather
 * than filters: an editor may be lining up an entry that is about to go public.
 */
export const HiddenPicksNote: React.FC<{ picks: readonly HiddenPick[] }> = ({ picks }) => {
  if (picks.length === 0) return null
  return (
    <Alert
      color="yellow"
      icon={<IconAlertTriangle size={16} />}
      p="xs"
      data-testid="reference-hidden-note"
    >
      {hiddenPickSentences(picks).map((sentence) => (
        <div key={sentence}>{sentence}</div>
      ))}
    </Alert>
  )
}
