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
  /** Opens the popover; `returnFocusTo` takes focus when it closes, in place of its opener. */
  open: (returnFocusTo?: () => HTMLElement | null) => void
  /** The field's wrapper, which orders the menu as the form reads. */
  element: () => HTMLElement | null
}

export interface FormComments {
  /** Registers a field's popover under its canopy path; returns the unregister. */
  register: (canopyPath: string, opener: FieldCommentOpener) => () => void
  get: (canopyPath: string) => FieldCommentOpener | undefined
  /** Records the field that last took focus, which "Comment on …" names; `undefined` forgets it. */
  noteFocus: (canopyPath: string | undefined) => void
  lastFocused: () => string | undefined
  subscribe: (listener: () => void) => () => void
}

/** One form's field comment popovers, for its "Comments in this form" menu and shortcut. */
export const createFormComments = (): FormComments => {
  const openers = new Map<string, FieldCommentOpener>()
  const listeners = new Set<() => void>()
  let lastFocused: string | undefined
  const notify = () => listeners.forEach((listener) => listener())
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
    noteFocus: (canopyPath) => {
      if (lastFocused === canopyPath) return
      lastFocused = canopyPath
      notify()
    },
    lastFocused: () => lastFocused,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const FormCommentsContext = createContext<FormComments | null>(null)

export const useFormComments = (): FormComments | null => useContext(FormCommentsContext)

/** The shortcut's label for tooltips and the menu, in the platform's modifier. */
export const commentsShortcutLabel = (): string => (modKeyLabel() === '⌘' ? '⌘⌥M' : 'Ctrl+Alt+M')

/** The shortcut for `aria-keyshortcuts`. */
export const commentsAriaKeyShortcuts = (): string =>
  modKeyLabel() === '⌘' ? 'Meta+Alt+M' : 'Control+Alt+M'

const FIELD_SCOPE_SELECTOR = '[data-field-comments]'

/** Focus is in an overlay other than one holding this form, so the shortcut leaves it be. */
const inOtherOverlay = (active: Element | null, form: Element): boolean => {
  const dialog = active?.closest('[role="dialog"]')
  if (dialog && !dialog.contains(form)) return true
  return Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).some(
    (modal) => !modal.contains(form),
  )
}

const openThreadsText = (count: number): string =>
  count === 1 ? '1 open thread' : `${count} open threads`

interface FieldThreadsSummary {
  canopyPath: string
  subject: string
  open: number
  total: number
}

export interface FormCommentsMenuProps {
  /** Every thread on the branch; the menu counts this entry's field threads. */
  comments: CommentThread[]
  entryPath: string
}

/**
 * The form's one keyboard route to field comments: a menu listing the fields with threads that
 * opens each one's popover, and can start a thread on the field last focused. Mod+Alt+M opens the
 * focused field's popover, or this menu when focus is elsewhere in the editor.
 */
export const FormCommentsMenu: React.FC<FormCommentsMenuProps> = ({ comments, entryPath }) => {
  const formComments = useFormComments()
  const [opened, setOpened] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const lastFocusedPath = useSyncExternalStore(
    formComments?.subscribe ?? noopSubscribe,
    formComments?.lastFocused ?? noLastFocused,
    noLastFocused,
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
  const openCount = useMemo(
    () => [...counts.values()].reduce((sum, count) => sum + count.open, 0),
    [counts],
  )

  useHotkeys(
    [
      [
        'mod+alt+M',
        (event) => {
          // Mantine's `mod` is Ctrl or ⌘ everywhere; on macOS the shortcut is ⌘⌥M only.
          if (modKeyLabel() === '⌘' && !event.metaKey) return
          const form = triggerRef.current?.closest('[data-form-renderer]')
          if (!formComments || !form) return
          const active = document.activeElement
          if (inOtherOverlay(active, form)) return
          event.preventDefault()
          const field =
            active && form.contains(active) ? active.closest(FIELD_SCOPE_SELECTOR) : null
          const path = field?.getAttribute('data-canopy-field')
          const opener = path ? formComments.get(path) : undefined
          if (opener) opener.open()
          else {
            triggerRef.current?.scrollIntoView?.({ block: 'nearest' })
            setOpened(true)
          }
        },
        // `M` by position: ⌥ turns it into another character on macOS.
        { preventDefault: false, usePhysicalKeys: true },
      ],
    ],
    // `[]` ignores no tags and `true` fires from contenteditable, so it works while typing.
    [],
    true,
  )

  if (!formComments) return null

  // Read when the menu renders open, so it lists the fields mounted now, in the form's order.
  const fields: FieldThreadsSummary[] = []
  if (opened) {
    for (const [canopyPath, count] of counts) {
      const opener = formComments.get(canopyPath)
      if (opener) fields.push({ canopyPath, subject: opener.subject, ...count })
    }
    fields.sort((a, b) => {
      const elA = formComments.get(a.canopyPath)?.element()
      const elB = formComments.get(b.canopyPath)?.element()
      if (!elA || !elB) return 0
      return elA.compareDocumentPosition(elB) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    })
  }
  const lastFocused = lastFocusedPath ? formComments.get(lastFocusedPath) : undefined
  // The menu item is gone once the popover opens, so its trigger stands in as the opener.
  const openField = (opener: FieldCommentOpener) => opener.open(() => triggerRef.current)
  const shortcut = commentsShortcutLabel()

  return (
    <Menu opened={opened} onChange={setOpened} position="bottom-end" withinPortal shadow="sm">
      <Tooltip label={`Comments in this form (${shortcut})`} withinPortal disabled={opened}>
        <Menu.Target>
          <Button
            ref={triggerRef}
            variant="subtle"
            color="gray"
            c="gray.8"
            size="compact-sm"
            leftSection={<IconMessages size={16} aria-hidden />}
            rightSection={
              <>
                {openCount > 0 && (
                  <Badge size="sm" variant="light" color="orange" c="dark.7" aria-hidden mr={4}>
                    {openCount}
                  </Badge>
                )}
                <IconChevronDown size={14} aria-hidden />
              </>
            }
            aria-label={
              openCount > 0
                ? `Comments in this form (${openThreadsText(openCount)} on fields)`
                : 'Comments in this form'
            }
            aria-keyshortcuts={commentsAriaKeyShortcuts()}
            data-testid="form-comments-menu-button"
          >
            Comments in this form
          </Button>
        </Menu.Target>
      </Tooltip>
      <Menu.Dropdown data-testid="form-comments-menu" maw={420}>
        <Menu.Label>Fields with comments</Menu.Label>
        {fields.length === 0 ? (
          <Text size="xs" c="dimmed" px="sm" pb="xs">
            No field has comments yet.
          </Text>
        ) : (
          fields.map((field) => {
            const opener = formComments.get(field.canopyPath)
            return (
              <Menu.Item
                key={field.canopyPath}
                onClick={() => opener && openField(opener)}
                data-testid={`form-comments-field-${field.canopyPath}`}
              >
                <Text size="sm" lineClamp={2}>
                  {field.subject}
                </Text>
                <Text size="xs" c="dimmed">
                  {field.open > 0 ? openThreadsText(field.open) : 'Resolved'}
                </Text>
              </Menu.Item>
            )
          })
        )}
        <Menu.Divider />
        {lastFocused ? (
          <Menu.Item
            onClick={() => openField(lastFocused)}
            rightSection={
              <Text size="xs" c="dimmed">
                {shortcut}
              </Text>
            }
            data-testid="form-comments-comment-on-field"
          >
            <Text size="sm" lineClamp={2}>
              Comment on {lastFocused.subject}
            </Text>
          </Menu.Item>
        ) : (
          // Focusable, so the reason is read; Mantine's `disabled` would skip it.
          <Menu.Item
            aria-disabled
            closeMenuOnClick={false}
            data-testid="form-comments-comment-on-field"
          >
            <Text size="sm">Comment on a field</Text>
            <Text size="xs" c="dimmed">
              Focus a field first, or press {shortcut} in it.
            </Text>
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  )
}

const noopSubscribe = () => () => {}
const noLastFocused = (): string | undefined => undefined
