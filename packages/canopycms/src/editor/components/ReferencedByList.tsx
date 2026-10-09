'use client'

import { Anchor, List, Text } from '@mantine/core'
import type { EntryReferencedBy } from '../../api/entries'
import type { LogicalPath } from '../../paths/types'

export interface ReferencedByListProps {
  referencedBy: EntryReferencedBy
  /** Opens a referencing entry in the editor. */
  onOpenEntry: (entryPath: LogicalPath) => void
}

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
  return (
    <List size="sm" spacing={4} data-testid="referenced-by-list">
      {entries.map((entry) => {
        const via = [
          ...(entry.fields.length > 0 ? [entry.fields.join(', ')] : []),
          ...(entry.links.length > 0 ? [`linked from ${entry.links.join(', ')}`] : []),
        ].join('; ')
        return (
          <List.Item key={entry.entryPath}>
            <Anchor
              component="button"
              type="button"
              size="sm"
              onClick={() => onOpenEntry(entry.entryPath)}
            >
              {entry.title}
            </Anchor>{' '}
            <Text span size="xs" c="dimmed">
              ({via})
            </Text>
          </List.Item>
        )
      })}
      {hiddenCount > 0 && (
        <List.Item>
          <Text span size="sm" c="dimmed">
            {entries.length > 0 ? 'and ' : ''}
            {pluralEntries(hiddenCount)} you can&apos;t view
          </Text>
        </List.Item>
      )}
    </List>
  )
}
