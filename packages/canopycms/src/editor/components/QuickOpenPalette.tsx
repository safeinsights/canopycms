'use client'

/** Mod+P palette: type part of an entry's title or slug, pick it with the keyboard or mouse. */

import { useEffect, useMemo, useState } from 'react'
import { Combobox, Highlight, Modal, ScrollArea, Text, TextInput, useCombobox } from '@mantine/core'
import { useHotkeys } from '@mantine/hooks'
import { IconSearch } from '@tabler/icons-react'

import { filterEntries, groupEntriesByCollection } from '../entry-search'
import { modKeyLabel } from '../platform'

/** Marks an overlay the palette may replace; Editor closes it as the palette opens. */
export const QUICK_OPEN_REPLACES_ATTR = 'data-quick-open-replaces'

/**
 * True while a modal or drawer (never a popover) other than one marked with `QUICK_OPEN_REPLACES_ATTR` is open.
 * Overlays share one z-index and stack in DOM order, and the palette mounts first, so it would
 * open hidden underneath and take the keyboard from the dialog the user is working in.
 */
const otherOverlayOpen = () =>
  Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).some(
    (dialog) => !dialog.closest(`[${QUICK_OPEN_REPLACES_ATTR}]`),
  )

/** Options rendered at once; the rest are reached by typing more. */
const MAX_OPTIONS = 50

/** @internal Exported for tests and stories. */
export interface QuickOpenEntry {
  path: string
  label: string
  slug?: string
  collectionPath?: string
  collectionName?: string
}

export interface QuickOpenPaletteProps {
  opened: boolean
  onOpen: () => void
  onClose: () => void
  entries: ReadonlyArray<QuickOpenEntry>
  /** Display name for a collection heading; the collection's own name when absent, none when ''. */
  collectionLabel?: (collectionPath: string) => string | undefined
  onSelect: (path: string) => void
}

export function QuickOpenPalette({
  opened,
  onOpen,
  onClose,
  entries,
  collectionLabel,
  onSelect,
}: QuickOpenPaletteProps) {
  // `[]` ignores no tags and `true` fires from contenteditable, so the shortcut works from inside
  // a text field or the MDX editor.
  useHotkeys(
    [
      [
        'mod+P',
        (event) => {
          // Mantine's `mod` is Ctrl or ⌘ everywhere; on macOS Ctrl+P moves the caret up a line.
          if (modKeyLabel() === '⌘' && !event.metaKey) return
          // Keeps the browser's print dialog shut, even when the palette can't open.
          event.preventDefault()
          if (!otherOverlayOpen()) onOpen()
        },
        { preventDefault: false },
      ],
    ],
    [],
    true,
  )

  const [query, setQuery] = useState('')
  const [wasOpened, setWasOpened] = useState(opened)
  if (opened !== wasOpened) {
    setWasOpened(opened)
    if (!opened) setQuery('')
  }

  // Always open: the options are the palette's body, not a dropdown below a field.
  const combobox = useCombobox({ opened: true })
  const { selectFirstOption } = combobox

  const matches = useMemo(() => filterEntries(entries, query), [entries, query])
  const shown = useMemo(() => matches.slice(0, MAX_OPTIONS), [matches])
  const groups = useMemo(
    () => groupEntriesByCollection(shown, collectionLabel),
    [shown, collectionLabel],
  )

  // Enter right after typing opens the best match, so the first option is always armed. Deferred
  // a tick: on opening, the modal's portal and the options list mount after this effect.
  useEffect(() => {
    if (!opened) return
    const timer = setTimeout(selectFirstOption, 0)
    return () => clearTimeout(timer)
  }, [opened, query, selectFirstOption])

  const handleSubmit = (path: string) => {
    onSelect(path)
    onClose()
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Open entry"
      size="lg"
      yOffset="10vh"
      // Its own dialog lingers through the close transition; Mod+P may reopen it meanwhile.
      {...{ [QUICK_OPEN_REPLACES_ATTR]: true }}
    >
      <Combobox store={combobox} onOptionSubmit={handleSubmit}>
        <Combobox.EventsTarget
          withExpandedAttribute
          // The combobox marks its input so a window-level Escape handler ignores it while a
          // dropdown is open. There is no dropdown here, so Escape must reach the modal.
          data-mantine-stop-propagation={false}
        >
          <TextInput
            role="combobox"
            aria-label="Search entries"
            aria-autocomplete="list"
            placeholder="Type an entry title or slug"
            leftSection={<IconSearch size={14} aria-hidden />}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            data-autofocus
            data-testid="quick-open-input"
          />
        </Combobox.EventsTarget>

        <Combobox.Options mt="sm" aria-label="Entries">
          <ScrollArea.Autosize mah={360} type="scroll" scrollbars="y">
            {matches.length === 0 ? (
              <Text size="sm" c="dimmed" p="xs" data-testid="quick-open-empty">
                No entries match “{query}”.
              </Text>
            ) : (
              groups.map((group, index) => (
                <Combobox.Group label={group.heading || undefined} key={index}>
                  {group.entries.map((entry) => (
                    <Combobox.Option
                      value={entry.path}
                      key={entry.path}
                      data-testid="quick-open-option"
                    >
                      <Highlight highlight={query.trim()} size="sm">
                        {entry.label}
                      </Highlight>
                      {/* Inherits the option's colour, so it stays legible on the armed option's fill. */}
                      {entry.slug && (
                        <Text size="xs" style={{ opacity: 0.75 }}>
                          {entry.slug}
                        </Text>
                      )}
                    </Combobox.Option>
                  ))}
                </Combobox.Group>
              ))
            )}
          </ScrollArea.Autosize>
        </Combobox.Options>

        {matches.length > MAX_OPTIONS && (
          <Text size="xs" c="dimmed" mt="xs">
            Showing {MAX_OPTIONS} of {matches.length}. Keep typing to narrow the list.
          </Text>
        )}
      </Combobox>
    </Modal>
  )
}
