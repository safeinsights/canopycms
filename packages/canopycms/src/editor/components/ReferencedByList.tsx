'use client'

import type { CSSProperties } from 'react'
import { Anchor, Box, Stack, Text } from '@mantine/core'
import type { EntryReferencedBy } from '../../api/entries'
import type { LogicalPath } from '../../paths/types'

export interface ReferencedByListProps {
  referencedBy: EntryReferencedBy
  /** Opens a referencing entry in the editor. */
  onOpenEntry: (entryPath: LogicalPath) => void
}

// `anywhere`, unlike `break-word`, also lowers the min-content width, so an unbroken
// title or slug narrows to the dialog instead of widening it into a horizontal scroll.
const wrapAnywhere: CSSProperties = { overflowWrap: 'anywhere' }

const pluralEntries = (n: number) => `${n} ${n === 1 ? 'entry' : 'entries'}`

/** The delete dialog's message once the server has refused a delete over references. */
export function referencedDeleteMessage({ entries, hiddenCount }: EntryReferencedBy): string {
  const count = entries.length + hiddenCount
  return (
    `This entry is referenced by ${count} other ${count === 1 ? 'entry' : 'entries'}. ` +
    `Deleting it leaves ${count === 1 ? 'that reference' : 'those references'} pointing at ` +
    'nothing. This cannot be undone.'
  )
}

/** The entries a delete would leave pointing at nothing, as far as the user may see them. */
export function ReferencedByList({ referencedBy, onOpenEntry }: ReferencedByListProps) {
  const { entries, hiddenCount } = referencedBy
  // Not Mantine's `List`: its items are `white-space: nowrap` around a column
  // `inline-flex`, which cannot narrow to the dialog and splits a title from its label.
  return (
    <Stack
      component="ul"
      gap={6}
      m={0}
      p={0}
      style={{ listStyle: 'none' }}
      data-testid="referenced-by-list"
    >
      {entries.map((entry) => {
        const via = [
          ...(entry.fields.length > 0 ? [entry.fields.join(', ')] : []),
          ...(entry.links.length > 0 ? [`linked from ${entry.links.join(', ')}`] : []),
        ].join('; ')
        return (
          <Box component="li" key={entry.entryPath}>
            <Anchor
              component="button"
              type="button"
              size="sm"
              ta="start"
              style={wrapAnywhere}
              onClick={() => onOpenEntry(entry.entryPath)}
            >
              {entry.title}
            </Anchor>
            <Text size="xs" c="dimmed" style={wrapAnywhere}>
              ({via})
            </Text>
          </Box>
        )
      })}
      {hiddenCount > 0 && (
        <Box component="li">
          <Text size="sm" c="dimmed">
            {entries.length > 0 ? 'and ' : ''}
            {pluralEntries(hiddenCount)} you can&apos;t view
          </Text>
        </Box>
      )}
    </Stack>
  )
}
