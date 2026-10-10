'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Drawer, Group, Text, Title } from '@mantine/core'
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
  children: React.ReactNode
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
  children,
}) => {
  const [confirmOpen, setConfirmOpen] = useState(false)
  useBeforeUnloadWhileDirty(isDirty)

  const requestClose = useCallback(() => {
    if (!isDirty) {
      onClose()
      return
    }
    setConfirmOpen(true)
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
      onClose: () => setConfirmOpen(false),
    })
  }, [isDirty, onClose, onDiscard])

  return (
    <Drawer
      opened={opened}
      onClose={requestClose}
      closeOnEscape={!confirmOpen && !childModalOpen}
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
      {children}

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
