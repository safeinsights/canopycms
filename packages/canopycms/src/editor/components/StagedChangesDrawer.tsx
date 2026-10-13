'use client'

import React, { useCallback, useEffect, useReducer, useRef } from 'react'
import { Badge, Button, Drawer, Fieldset, Group, Text, Title } from '@mantine/core'
import { openConfirm } from '../utils/confirm-modal'
import { focusReturnProps } from '../utils/focus-return'

export interface StagedChangesDrawerProps {
  opened: boolean
  /** Closes the drawer. Called directly when clean, only after a confirmed discard when dirty, and never while saving. */
  onClose: () => void
  title: string
  description: string
  size: number
  isDirty: boolean
  isSaving: boolean
  /** Whether the viewer may save; without it the save bar never renders. */
  canEdit: boolean
  saveLabel: string
  onSave: () => void
  onDiscard: () => void
  /** A modal of the panel's own is open: the drawer yields Escape to it (Mantine listens for Escape on window, capture phase). */
  childModalOpen?: boolean
  /** Runs once the close transition has finished; see `useOpeningKey`. */
  onExited?: () => void
  /** Names the element that takes focus after the drawer closes, for an opener that unmounted (a menu item). */
  returnFocusTo?: () => HTMLElement | null
  children: React.ReactNode
}

/**
 * A key that changes each time the drawer finishes closing. A panel keyed with it, and passing
 * `onExited` through, gets fresh state for each opening, as the drawer's own children do. A
 * reopen during the close transition cancels it, so that opening keeps the previous state.
 */
export function useOpeningKey(): { key: number; onExited: () => void } {
  const [key, onExited] = useReducer((n: number) => n + 1, 0)
  return { key, onExited }
}

/** Asks the browser to confirm a reload or navigation, for exactly as long as `isDirty` holds. */
function useBeforeUnloadWhileDirty(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Chrome before 119 shows the prompt only when returnValue is set.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])
}

/**
 * The drawer shell for an admin panel that stages edits and saves them as one batch
 * (groups, permissions). Staged edits exist only in the panel's state, so the shell keeps
 * them from being lost unnoticed: a title badge and a sticky save bar while dirty, a
 * discard confirm on close and on the save bar's Discard changes, and a `beforeunload` prompt.
 */
export const StagedChangesDrawer: React.FC<StagedChangesDrawerProps> = ({
  opened,
  onClose,
  title,
  description,
  size,
  isDirty,
  isSaving,
  canEdit,
  saveLabel,
  onSave,
  onDiscard,
  childModalOpen = false,
  onExited,
  returnFocusTo,
  children,
}) => {
  // A ref, not state: @mantine/modals runs the confirm's onClose inside its reducer, during
  // render, where setting another component's state draws a React warning. While the confirm is open the
  // drawer still hears Escape, so requestClose must ignore it.
  const confirmOpenRef = useRef(false)
  useBeforeUnloadWhileDirty(isDirty)

  const confirmDiscard = useCallback((body: string, onConfirm: () => void) => {
    confirmOpenRef.current = true
    openConfirm({
      title: 'Discard unsaved changes?',
      children: <Text size="sm">{body}</Text>,
      labels: { confirm: 'Discard changes', cancel: 'Keep editing' },
      confirmProps: { color: 'red' },
      onConfirm,
      // Mantine calls onClose for every exit, the confirm included.
      onClose: () => {
        confirmOpenRef.current = false
      },
    })
  }, [])

  const requestClose = useCallback(() => {
    // The save is already on its way to the server; discarding now could not stop it.
    if (isSaving || confirmOpenRef.current) return
    if (!isDirty) {
      onClose()
      return
    }
    confirmDiscard('Closing now drops the changes you have not saved.', () => {
      onDiscard()
      onClose()
    })
  }, [isDirty, isSaving, onClose, onDiscard, confirmDiscard])

  const requestDiscard = useCallback(() => {
    if (isSaving || confirmOpenRef.current) return
    confirmDiscard('Discarding drops the changes you have not saved.', onDiscard)
  }, [isSaving, onDiscard, confirmDiscard])

  const { onExitTransitionEnd: returnFocus, ...focusReturn } = focusReturnProps(returnFocusTo)

  return (
    <Drawer
      opened={opened}
      onClose={requestClose}
      closeOnEscape={!childModalOpen}
      {...focusReturn}
      onExitTransitionEnd={() => {
        returnFocus?.()
        onExited?.()
      }}
      position="right"
      title={
        <div>
          <Group gap="xs">
            <Title order={4}>{title}</Title>
            {isDirty && (
              <Badge color="orange" variant="light">
                Unsaved changes
              </Badge>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            {description}
          </Text>
        </div>
      }
      padding="md"
      size={size}
      overlayProps={{ blur: 2 }}
    >
      {/* Inert while saving: the reload after a save replaces the panel's state, so an edit
          made meanwhile would vanish with the panel marked clean. */}
      <Fieldset variant="unstyled" disabled={isSaving} aria-busy={isSaving}>
        {children}
      </Fieldset>

      {canEdit && isDirty && (
        // The drawer's content box is the scroll container, so a sticky bar stays in view
        // however long the panel's list grows.
        <Group
          justify="space-between"
          py="sm"
          gap="sm"
          style={{
            position: 'sticky',
            bottom: 0,
            zIndex: 1,
            background: 'var(--mantine-color-body)',
            borderTop: '1px solid var(--mantine-color-default-border)',
          }}
        >
          <Text size="sm" c="dimmed">
            Changes take effect only after you save.
          </Text>
          <Group gap="sm">
            <Button
              size="sm"
              variant="subtle"
              color="neutral"
              onClick={requestDiscard}
              disabled={isSaving}
            >
              Discard changes
            </Button>
            <Button size="sm" onClick={onSave} loading={isSaving} disabled={isSaving}>
              {saveLabel}
            </Button>
          </Group>
        </Group>
      )}
    </Drawer>
  )
}
