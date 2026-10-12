'use client'

import React, {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Badge, Button, Menu, Text, Tooltip } from '@mantine/core'
import { useHotkeys } from '@mantine/hooks'
import { IconChevronDown, IconMessages } from '@tabler/icons-react'
import type { CommentThread } from '../../comment-store'
import { modKeyLabel } from '../platform'

/** A field's comment popover, as the form-level keyboard route reaches it. */
interface FieldCommentOpener {
  /** The field's breadcrumb, as its control names it. */
  subject: string
  /** Opens the popover; `returnFocusTo` stands in for its opener unless a click closes it. */
  open: (returnFocusTo?: () => HTMLElement | null) => void
  /** The field's wrapper, which orders the menu as the form reads. */
  element: () => HTMLElement | null
}

export interface FormComments {
  /** Registers a field's popover under its canopy path; returns the unregister. */
  register: (canopyPath: string, opener: FieldCommentOpener) => () => void
  get: (canopyPath: string) => FieldCommentOpener | undefined
  /** Every registered field, in the form's order. */
  fields: () => Array<FieldCommentOpener & { canopyPath: string }>
  /** Records the field that last took focus, which "Comment on …" names; `undefined` forgets it. */
  noteFocus: (canopyPath: string | undefined) => void
  lastFocused: () => string | undefined
  /** Bumped whenever the fields or the field last focused change, for `useSyncExternalStore`. */
  version: () => number
  subscribe: (listener: () => void) => () => void
}

const byFormOrder = (a: HTMLElement | null, b: HTMLElement | null): number => {
  if (!a || !b || a === b) return 0
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
}

/** One form's field comment popovers, for its "Field comments" menu and shortcut. */
export const createFormComments = (): FormComments => {
  const openers = new Map<string, FieldCommentOpener>()
  const listeners = new Set<() => void>()
  let lastFocused: string | undefined
  let version = 0
  const notify = () => {
    version += 1
    listeners.forEach((listener) => listener())
  }
  return {
    register: (canopyPath, opener) => {
      openers.set(canopyPath, opener)
      notify()
      return () => {
        if (openers.get(canopyPath) !== opener) return
        openers.delete(canopyPath)
        notify()
      }
    },
    get: (canopyPath) => openers.get(canopyPath),
    fields: () =>
      [...openers]
        .map(([canopyPath, opener]) => ({ ...opener, canopyPath }))
        .sort((a, b) => byFormOrder(a.element(), b.element())),
    noteFocus: (canopyPath) => {
      if (lastFocused === canopyPath) return
      lastFocused = canopyPath
      notify()
    },
    lastFocused: () => lastFocused,
    version: () => version,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const FormCommentsContext = createContext<FormComments | null>(null)

export const useFormComments = (): FormComments | null => useContext(FormCommentsContext)

/** The shortcut's label for tooltips, in the platform's modifier. */
export const commentsShortcutLabel = (): string => (modKeyLabel() === '⌘' ? '⌘⌥M' : 'Ctrl+Alt+M')

/** The shortcut for `aria-keyshortcuts`. */
export const commentsAriaKeyShortcuts = (): string =>
  modKeyLabel() === '⌘' ? 'Meta+Alt+M' : 'Control+Alt+M'

const FIELD_SCOPE_SELECTOR = '[data-field-comments]'

/** One letter of a script other than Latin; AltGr symbols such as "µ" are Common, not letters of one. */
const NON_LATIN_LETTER = /^(?![\p{Script=Latin}\p{Script=Common}])\p{L}$/u

/** Focus is in another overlay, or a modal not holding this form is open, so the shortcut leaves it be. */
const inOtherOverlay = (active: Element | null, form: Element): boolean => {
  const dialog = active?.closest('[role="dialog"]')
  if (dialog && !dialog.contains(form)) return true
  return Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).some(
    (modal) => !modal.contains(form),
  )
}

const openThreadsText = (count: number): string =>
  count === 1 ? '1 open thread' : `${count} open threads`

export interface FormCommentsMenuProps {
  /** Every thread on the branch; the menu counts this entry's field threads. */
  comments: CommentThread[]
  entryPath: string
}

/**
 * The form's one keyboard route to field comments: a menu listing the fields with threads, the
 * field last focused, and every field, each opening that field's popover. Mod+Alt+M opens
 * the focused field's popover, or this menu when focus is elsewhere in the editor.
 */
export const FormCommentsMenu: React.FC<FormCommentsMenuProps> = ({ comments, entryPath }) => {
  const formComments = useFormComments()
  const [opened, setOpened] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Re-renders on every registration, so counts and lists follow the fields mounted now.
  useSyncExternalStore(
    formComments?.subscribe ?? noopSubscribe,
    formComments?.version ?? noVersion,
    noVersion,
  )

  const counts = useMemo(() => {
    const byPath = new Map<string, { open: number; total: number }>()
    for (const thread of comments) {
      if (thread.type !== 'field' || thread.entryPath !== entryPath || !thread.canopyPath) continue
      const count = byPath.get(thread.canopyPath) ?? { open: 0, total: 0 }
      count.total += 1
      if (!thread.resolved) count.open += 1
      byPath.set(thread.canopyPath, count)
    }
    return byPath
  }, [comments, entryPath])

  const onShortcut = (event: KeyboardEvent) => {
    const form = triggerRef.current?.closest('[data-form-renderer]')
    if (!formComments || !form) return
    const active = document.activeElement
    if (inOtherOverlay(active, form)) return
    event.preventDefault()
    const field = active && form.contains(active) ? active.closest(FIELD_SCOPE_SELECTOR) : null
    const path = field?.getAttribute('data-canopy-field')
    const opener = path ? formComments.get(path) : undefined
    if (opener) opener.open()
    else {
      triggerRef.current?.scrollIntoView?.({ block: 'nearest' })
      setOpened(true)
    }
  }

  useHotkeys(
    [
      [
        'mod+alt+M',
        (event) => {
          // ⌥ turns M into another character on macOS, so there the key matches by position.
          if (modKeyLabel() === '⌘' && event.metaKey) onShortcut(event)
        },
        { preventDefault: false, usePhysicalKeys: true },
      ],
      [
        'mod+alt+M',
        (event) => {
          // Elsewhere by character: AltGr reads as Ctrl+Alt, and AltGr+M types a character
          // on some layouts, which this leaves alone.
          if (modKeyLabel() !== '⌘') onShortcut(event)
        },
        { preventDefault: false },
      ],
      [
        'mod+alt+M',
        (event) => {
          // A layout whose letters aren't Latin, such as Cyrillic or Greek, matches by position.
          if (
            modKeyLabel() !== '⌘' &&
            NON_LATIN_LETTER.test(event.key) &&
            !event.getModifierState?.('AltGraph')
          )
            onShortcut(event)
        },
        { preventDefault: false, usePhysicalKeys: true },
      ],
    ],
    // `[]` ignores no tags and `true` fires from contenteditable, so it works while typing.
    [],
    true,
  )

  if (!formComments) return null

  // Counts only fields mounted now, which the menu can open.
  const openCount = [...counts].reduce(
    (sum, [path, { open }]) => (formComments.get(path) ? sum + open : sum),
    0,
  )
  // The menu item is gone once the popover opens, so its trigger stands in as the opener.
  const openField = (opener: FieldCommentOpener) => opener.open(() => triggerRef.current)

  return (
    <Menu opened={opened} onChange={setOpened} position="bottom-end" withinPortal shadow="sm">
      <Tooltip label={`Field comments (${commentsShortcutLabel()})`} withinPortal disabled={opened}>
        <Menu.Target>
          <Button
            ref={triggerRef}
            variant="subtle"
            color="gray"
            // The theme's text colour, not a palette shade: a fixed shade is unreadable on one scheme.
            c="var(--mantine-color-text)"
            size="compact-sm"
            leftSection={<IconMessages size={16} aria-hidden />}
            rightSection={
              <>
                {openCount > 0 && (
                  <Badge
                    size="sm"
                    variant="light"
                    color="orange"
                    c="var(--mantine-color-text)"
                    aria-hidden
                    mr={4}
                  >
                    {openCount}
                  </Badge>
                )}
                <IconChevronDown size={14} aria-hidden />
              </>
            }
            aria-label={
              openCount > 0 ? `Field comments (${openThreadsText(openCount)})` : 'Field comments'
            }
            aria-keyshortcuts={commentsAriaKeyShortcuts()}
            data-testid="form-comments-menu-button"
          >
            Field comments
          </Button>
        </Menu.Target>
      </Tooltip>
      <Menu.Dropdown
        data-testid="form-comments-menu"
        maw={420}
        mah="min(480px, 70vh)"
        style={{ overflowY: 'auto' }}
      >
        <MenuItems formComments={formComments} counts={counts} openField={openField} />
      </Menu.Dropdown>
    </Menu>
  )
}

/** The menu's items, built only while its dropdown is mounted: every field, in form order. */
const MenuItems: React.FC<{
  formComments: FormComments
  counts: Map<string, { open: number; total: number }>
  openField: (opener: FieldCommentOpener) => void
}> = ({ formComments, counts, openField }) => {
  const allFields = formComments.fields()
  const withThreads = allFields.flatMap((field) => {
    const count = counts.get(field.canopyPath)
    return count ? [{ field, ...count }] : []
  })
  const lastFocusedPath = formComments.lastFocused()
  const lastFocused = lastFocusedPath ? formComments.get(lastFocusedPath) : undefined
  const otherFields = allFields.filter((field) => field.canopyPath !== lastFocusedPath)
  return (
    <>
      <Menu.Label>Fields with comments</Menu.Label>
      {withThreads.length === 0 ? (
        <Text size="xs" c="dimmed" px="sm" pb="xs">
          No field has comments yet.
        </Text>
      ) : (
        withThreads.map(({ field, open }) => (
          <Menu.Item
            key={field.canopyPath}
            onClick={() => openField(field)}
            data-testid={`form-comments-field-${field.canopyPath}`}
          >
            <Text size="sm" lineClamp={2}>
              {field.subject}
            </Text>
            <Text size="xs" c="dimmed">
              {open > 0 ? openThreadsText(open) : 'Resolved'}
            </Text>
          </Menu.Item>
        ))
      )}
      <Menu.Divider />
      {lastFocused && (
        <Menu.Item
          onClick={() => openField(lastFocused)}
          data-testid="form-comments-comment-on-focused"
        >
          <Text size="sm" lineClamp={2}>
            Comment on {lastFocused.subject}
          </Text>
        </Menu.Item>
      )}
      {/* Every field, so one with nothing focusable of its own, such as a read-only toggle or
        a group, is still reachable. */}
      <Menu.Label>{lastFocused ? 'Comment on another field' : 'Comment on a field'}</Menu.Label>
      {otherFields.map((field) => (
        <Menu.Item
          key={field.canopyPath}
          onClick={() => openField(field)}
          data-testid={`form-comments-any-field-${field.canopyPath}`}
        >
          <Text size="sm" lineClamp={2}>
            {field.subject}
          </Text>
        </Menu.Item>
      ))}
    </>
  )
}

const noopSubscribe = () => () => {}
const noVersion = (): number => 0
