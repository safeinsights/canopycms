'use client'

import React, { useRef, useState } from 'react'

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
  VisuallyHidden,
} from '@mantine/core'
import { useIsomorphicEffect } from '@mantine/hooks'
import { IconChevronsDown, IconChevronsUp, IconListTree } from '@tabler/icons-react'

/** The padding of the scroller the form sits in, which `EditorPanes` sets; 0 where unset. */
const PANE_PADDING = 'var(--canopy-form-pane-padding, 0px)'

/** Below this header width "Outline" shows its icon alone, so the controls never clip. */
const COMPACT_WIDTH = 280

/** Space kept between the header and a field scrolled up to it. */
const SCROLL_GAP = 8

/** The nearest ancestor that scrolls vertically, which the header sticks within. */
const scrollerOf = (element: HTMLElement): HTMLElement | undefined => {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') return node
  }
  return undefined
}

/** A field in the outline, holding its rows, or an inline group holding its fields. */
export interface OutlineNode {
  label: string
  /** The canopy path to focus; absent for an inline group, which is not a field. */
  path?: string
  /** A row's second value, shown dimmed beside its label. */
  secondary?: string
  children?: OutlineNode[]
}

export interface FormHeaderProps {
  title: string
  /** The entry type's label, shown as a badge. */
  typeLabel?: string
  outline: OutlineNode[]
  /** Scrolls to and focuses the field at `path`. */
  onSelect: (path: string) => void
  /** Set when the form has a list or block field, so expanding and collapsing has a target. */
  onExpandAll?: (expanded: boolean) => void
}

/**
 * One level of the outline as a list. A row's name leads with its field's label ("Page sections ›
 * Hero, Welcome"), so rows of two lists are told apart by ear.
 */
const OutlineList: React.FC<{
  nodes: OutlineNode[]
  /** The field these nodes are rows of. */
  field?: string
  nested?: boolean
  onChoose: (path: string) => void
}> = ({ nodes, field, nested = false, onChoose }) => (
  <ul style={{ listStyle: 'none', margin: 0, paddingLeft: nested ? 16 : 0 }}>
    {nodes.map((node, idx) => {
      const name = node.secondary ? `${node.label}, ${node.secondary}` : node.label
      return (
        <li key={node.path ?? `group-${idx}`}>
          {node.path === undefined ? (
            <Text size="xs" fw={600} c="dimmed" px="xs" pt={6} pb={2}>
              {node.label}
            </Text>
          ) : (
            <UnstyledButton
              onClick={() => onChoose(node.path as string)}
              aria-label={field ? `${field} › ${name}` : undefined}
              display="block"
              w="100%"
              py={4}
              px="xs"
              style={{ borderRadius: 'var(--mantine-radius-sm)' }}
              className="canopy-outline-item"
              data-testid="form-outline-item"
            >
              <Text size="sm" truncate="end" fw={field ? undefined : 500}>
                {node.label}
                {node.secondary && (
                  <Text span c="dimmed" size="sm">
                    {' '}
                    {node.secondary}
                  </Text>
                )}
              </Text>
            </UnstyledButton>
          )}
          {node.children && node.children.length > 0 && (
            <OutlineList
              nodes={node.children}
              field={node.path === undefined ? undefined : node.label}
              nested
              onChoose={onChoose}
            />
          )}
        </li>
      )
    })}
  </ul>
)

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
  const [compact, setCompact] = useState(false)
  const headerRef = useRef<HTMLDivElement>(null)

  // Its scroller pads its scroll edge by the header's height and a gap, so a field scrolled to the
  // top, as `scrollIntoView` does, lands below the header rather than under it.
  useIsomorphicEffect(() => {
    const header = headerRef.current
    if (!header) return
    const scroller = scrollerOf(header)
    const previous = scroller?.style.scrollPaddingTop ?? ''
    const measure = () => {
      if (scroller) scroller.style.scrollPaddingTop = `${header.offsetHeight + SCROLL_GAP}px`
      setCompact(header.clientWidth > 0 && header.clientWidth < COMPACT_WIDTH)
    }
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined
    observer?.observe(header)
    return () => {
      observer?.disconnect()
      if (scroller) scroller.style.scrollPaddingTop = previous
    }
  }, [])

  return (
    <Box
      ref={headerRef}
      data-testid="form-header"
      style={{
        // Bleeds over the form pane's padding, so it spans the pane and sticks to its very top.
        position: 'sticky',
        top: `calc(-1 * ${PANE_PADDING})`,
        zIndex: 3,
        margin: `calc(-1 * ${PANE_PADDING}) calc(-1 * ${PANE_PADDING}) 0`,
        padding: `8px ${PANE_PADDING}`,
        backgroundColor: 'var(--canopy-surface-muted)',
        borderBottom: '1px solid var(--mantine-color-default-border)',
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
            size="sm"
            tt="none"
            // Gives way before the title in a narrow pane.
            style={{ flexShrink: 2, minWidth: 0 }}
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
            // Focus enters the list; Escape hands it back to "Outline" (`closeOnEscape`). A chosen
            // field takes it instead, so closing returns it nowhere.
            trapFocus
            returnFocus={false}
          >
            {/* One element either way, so focus survives the width change; shut while wide. */}
            <Tooltip label="Outline" disabled={!compact} opened={compact ? undefined : false}>
              <Popover.Target>
                <Button
                  variant="subtle"
                  color="gray"
                  c="dimmed"
                  size="compact-sm"
                  px={compact ? 6 : undefined}
                  leftSection={<IconListTree size={14} aria-hidden />}
                  styles={compact ? { section: { marginInlineEnd: 0 } } : undefined}
                  onClick={() => setOutlineOpen((open) => !open)}
                  data-testid="form-outline-button"
                >
                  {compact ? <VisuallyHidden>Outline</VisuallyHidden> : 'Outline'}
                </Button>
              </Popover.Target>
            </Tooltip>
            <Popover.Dropdown p={4}>
              <ScrollArea.Autosize mah={400} type="auto">
                <nav aria-label="Outline" data-testid="form-outline">
                  <OutlineList
                    nodes={outline}
                    onChoose={(path) => {
                      setOutlineOpen(false)
                      onSelect(path)
                    }}
                  />
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
          background-color: var(--canopy-surface-muted);
        }
      `}</style>
    </Box>
  )
}
