'use client'

import React, { useCallback, useEffect, useReducer, useRef } from 'react'
import { Badge, Button, Drawer, Fieldset, Group, Text, Title } from '@mantine/core'
import { modals } from '@mantine/modals'

export interface StagedChangesDrawerProps {
  opened: boolean
  /** Closes the drawer. Called directly when clean, and only after a confirmed discard when dirty. */
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
  children: React.ReactNode
}

/**
 * A key that changes each time the drawer finishes closing. A panel keyed with it, and passing
 * `onExited` through, holds its state for exactly one opening, the same lifetime the drawer gives
 * its own children.
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
 * discard confirm on close, and a `beforeunload` prompt.
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
  children,
}) => {
  // A ref, not state: @mantine/modals runs the confirm's onClose inside its reducer, during
  // render, where setting another component's state is an error. While the confirm is open the
  // drawer still hears Escape, so requestClose must ignore it.
  const confirmOpenRef = useRef(false)
  useBeforeUnloadWhileDirty(isDirty)

  const requestClose = useCallback(() => {
    // The save is already on its way to the server; discarding now could not stop it.
    if (isSaving || confirmOpenRef.current) return
    if (!isDirty) {
      onClose()
      return
    }
    confirmOpenRef.current = true
    modals.openConfirmModal({
      title: 'Discard unsaved changes?',
      children: <Text size="sm">Closing now drops the changes you have not saved.</Text>,
      labels: { confirm: 'Discard', cancel: 'Keep editing' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        onDiscard()
        onClose()
      },
      // Mantine calls onClose for every exit, the confirm included.
      onClose: () => {
        confirmOpenRef.current = false
      },
    })
  }, [isDirty, isSaving, onClose, onDiscard])

  return (
    <Drawer
      opened={opened}
      onClose={requestClose}
      closeOnEscape={!childModalOpen}
      onExitTransitionEnd={onExited}
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
            borderTop: '1px solid var(--mantine-color-gray-3)',
          }}
        >
          <Text size="sm" c="dimmed">
            Changes take effect only after you save.
          </Text>
          <Group gap="sm">
            <Button variant="subtle" color="neutral" onClick={onDiscard} disabled={isSaving}>
              Discard Changes
            </Button>
            <Button onClick={onSave} loading={isSaving} disabled={isSaving}>
              {saveLabel}
            </Button>
          </Group>
        </Group>
      )}
    </Drawer>
  )
}
