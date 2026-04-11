/**
 * MDXEditor toolbar button for inserting entry links.
 *
 * Opens a modal with a searchable list of entries. When the user selects
 * an entry, inserts [Entry Title](entry:CONTENT_ID) into the editor.
 *
 * Must be rendered inside an MDXEditor toolbar (uses usePublisher from gurx).
 */

import React, { useState, useMemo } from 'react'
import {
  ActionIcon,
  Combobox,
  Group,
  InputBase,
  Modal,
  Stack,
  Text,
  useCombobox,
} from '@mantine/core'
import { IconFileSymlink } from '@tabler/icons-react'
import { useEntryLinkContext, type EntryLinkOption } from './EntryLinkContext'

interface InsertEntryLinkProps {
  /** MDXEditor's insertMarkdown function, obtained via usePublisher(insertMarkdown$) */
  onInsert: (markdown: string) => void
}

export const InsertEntryLink: React.FC<InsertEntryLinkProps> = ({ onInsert }) => {
  const [opened, setOpened] = useState(false)
  const [search, setSearch] = useState('')
  const { entries } = useEntryLinkContext()
  const combobox = useCombobox({
    onDropdownClose: () => combobox.resetSelectedOption(),
  })

  const filtered = useMemo(() => {
    if (!search) return entries
    const lower = search.toLowerCase()
    return entries.filter(
      (e) =>
        e.label.toLowerCase().includes(lower) ||
        e.slug?.toLowerCase().includes(lower) ||
        e.collectionName?.toLowerCase().includes(lower),
    )
  }, [entries, search])

  // Group entries by collection
  const grouped = useMemo(() => {
    const groups = new Map<string, EntryLinkOption[]>()
    for (const entry of filtered) {
      const key = entry.collectionName ?? entry.collectionPath ?? 'Root'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(entry)
    }
    return groups
  }, [filtered])

  const handleSelect = (entry: EntryLinkOption) => {
    const rawText = entry.label || entry.slug || 'Link'
    // Escape backslashes first, then markdown-special characters in link text
    const linkText = rawText.replace(/\\/g, '\\\\').replace(/([[\]()])/g, '\\$1')
    const markdown = `[${linkText}](entry:${entry.contentId})`
    onInsert(markdown)
    setOpened(false)
    setSearch('')
  }

  return (
    <>
      <ActionIcon
        variant="subtle"
        size="sm"
        color="gray"
        title="Insert entry link"
        data-testid="insert-entry-link-button"
        onClick={() => setOpened(true)}
      >
        <IconFileSymlink size={16} />
      </ActionIcon>

      <Modal
        opened={opened}
        onClose={() => {
          setOpened(false)
          setSearch('')
        }}
        title="Link to Entry"
        size="md"
      >
        <Stack gap="sm">
          <Combobox
            store={combobox}
            onOptionSubmit={(val) => {
              const entry = entries.find((e) => e.contentId === val)
              if (entry) handleSelect(entry)
            }}
          >
            <Combobox.Target>
              <InputBase
                placeholder="Search entries..."
                data-testid="entry-link-search"
                value={search}
                onChange={(event) => {
                  setSearch(event.currentTarget.value)
                  combobox.openDropdown()
                  combobox.updateSelectedOptionIndex()
                }}
                onClick={() => combobox.openDropdown()}
                onFocus={() => combobox.openDropdown()}
                onBlur={() => combobox.closeDropdown()}
                rightSection={<Combobox.Chevron />}
                rightSectionPointerEvents="none"
              />
            </Combobox.Target>

            <Combobox.Dropdown>
              <Combobox.Options mah={300} style={{ overflowY: 'auto' }}>
                {filtered.length === 0 ? (
                  <Combobox.Empty>No entries found</Combobox.Empty>
                ) : (
                  Array.from(grouped.entries()).map(([groupName, groupEntries]) => (
                    <Combobox.Group key={groupName} label={groupName}>
                      {groupEntries.map((entry) => (
                        <Combobox.Option key={entry.contentId} value={entry.contentId}>
                          <Group gap="xs">
                            <div>
                              <Text size="sm">{entry.label}</Text>
                              {entry.slug && (
                                <Text size="xs" c="dimmed">
                                  {entry.slug}
                                </Text>
                              )}
                            </div>
                          </Group>
                        </Combobox.Option>
                      ))}
                    </Combobox.Group>
                  ))
                )}
              </Combobox.Options>
            </Combobox.Dropdown>
          </Combobox>
        </Stack>
      </Modal>
    </>
  )
}
