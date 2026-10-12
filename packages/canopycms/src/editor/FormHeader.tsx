'use client'

import React, { useState } from 'react'

import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Popover,
  ScrollArea,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core'
import { IconChevronsDown, IconChevronsUp, IconListTree } from '@tabler/icons-react'

/** The padding of the scroller the form sits in, set by `EditorPanes`; none elsewhere. */
const PANE_PADDING = 'var(--canopy-form-pane-padding, 0px)'

/** One line of the outline: a field, or a row of a list or block field, one level down. */
export interface OutlineItem {
  label: string
  /** The canopy path to focus; absent for a group heading, which is not a field. */
  path?: string
  /** A row's second value, shown dimmed beside its label. */
  secondary?: string
  depth: 0 | 1
}

export interface FormHeaderProps {
  title: string
  /** The entry type's label, shown as a badge. */
  typeLabel?: string
  outline: OutlineItem[]
  /** Scrolls to and focuses the field at `path`. */
  onSelect: (path: string) => void
  /** Set when the form has a list or block field, so expanding and collapsing has a target. */
  onExpandAll?: (expanded: boolean) => void
}

/**
 * The form's sticky header: which entry this is, an outline of its fields to jump to, and
 * Expand all / Collapse all for every list and block field in it.
 */
export const FormHeader: React.FC<FormHeaderProps> = ({
  title,
  typeLabel,
  outline,
  onSelect,
  onExpandAll,
}) => {
  const [outlineOpen, setOutlineOpen] = useState(false)

  return (
    <Box
      data-testid="form-header"
      style={{
        // Bleeds over the form pane's padding, so it spans the pane and sticks to its very top.
        position: 'sticky',
        top: `calc(-1 * ${PANE_PADDING})`,
        zIndex: 3,
        margin: `calc(-1 * ${PANE_PADDING}) calc(-1 * ${PANE_PADDING}) 0`,
        padding: `8px ${PANE_PADDING}`,
        backgroundColor: 'var(--mantine-color-gray-1)',
        borderBottom: '1px solid var(--mantine-color-gray-3)',
      }}
    >
      <Group gap="xs" wrap="nowrap">
        <Text fw={600} size="sm" truncate="end" style={{ minWidth: 0 }}>
          {title}
        </Text>
        {typeLabel && (
          <Badge
            variant="light"
            color="gray"
            c="gray.8"
            size="sm"
            tt="none"
            style={{ flexShrink: 0 }}
          >
            {typeLabel}
          </Badge>
        )}
        <Group gap={4} wrap="nowrap" ml="auto" style={{ flexShrink: 0 }}>
          <Popover
            opened={outlineOpen}
            onChange={setOutlineOpen}
            position="bottom-end"
            width={300}
            shadow="md"
            withinPortal
            // Focus enters the list, and Escape hands it back to "Outline". A chosen field takes it
            // instead, so nothing returns it on close.
            trapFocus
            returnFocus={false}
          >
            <Popover.Target>
              <Button
                variant="subtle"
                color="gray"
                c="dimmed"
                size="compact-sm"
                leftSection={<IconListTree size={14} aria-hidden />}
                onClick={() => setOutlineOpen((open) => !open)}
                data-testid="form-outline-button"
              >
                Outline
              </Button>
            </Popover.Target>
            <Popover.Dropdown p={4}>
              <ScrollArea.Autosize mah={400} type="auto">
                <nav aria-label="Outline" data-testid="form-outline">
                  {outline.map((item, idx) =>
                    item.path === undefined ? (
                      <Text
                        key={`heading-${idx}`}
                        size="xs"
                        fw={600}
                        c="dimmed"
                        px="xs"
                        pt={6}
                        pb={2}
                      >
                        {item.label}
                      </Text>
                    ) : (
                      <UnstyledButton
                        key={item.path}
                        onClick={() => {
                          setOutlineOpen(false)
                          onSelect(item.path as string)
                        }}
                        display="block"
                        w="100%"
                        py={4}
                        pr="xs"
                        pl={item.depth === 1 ? 28 : 'xs'}
                        style={{ borderRadius: 'var(--mantine-radius-sm)' }}
                        className="canopy-outline-item"
                        data-testid="form-outline-item"
                      >
                        <Text size="sm" truncate="end" fw={item.depth === 0 ? 500 : undefined}>
                          {item.label}
                          {item.secondary && (
                            <Text span c="dimmed" size="sm">
                              {' '}
                              {item.secondary}
                            </Text>
                          )}
                        </Text>
                      </UnstyledButton>
                    ),
                  )}
                </nav>
              </ScrollArea.Autosize>
            </Popover.Dropdown>
          </Popover>
          {onExpandAll && (
            <>
              <Tooltip label="Expand all lists">
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label="Expand all lists"
                  onClick={() => onExpandAll(true)}
                  data-testid="form-expand-all"
                >
                  <IconChevronsDown size={16} aria-hidden />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Collapse all lists">
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label="Collapse all lists"
                  onClick={() => onExpandAll(false)}
                  data-testid="form-collapse-all"
                >
                  <IconChevronsUp size={16} aria-hidden />
                </ActionIcon>
              </Tooltip>
            </>
          )}
        </Group>
      </Group>
      <style>{`
        .canopy-outline-item:hover, .canopy-outline-item:focus-visible {
          background-color: var(--mantine-color-gray-1);
        }
      `}</style>
    </Box>
  )
}
