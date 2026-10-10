'use client'

import type { ReactNode } from 'react'
import { Modal, Button, Text, Group, Stack } from '@mantine/core'

export interface ConfirmDeleteModalProps {
  isOpen: boolean
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onClose: () => void
  loading?: boolean
  /** Rendered between the message and the buttons. */
  children?: ReactNode
}

/**
 * Confirmation modal for delete operations.
 * Provides a clear warning UI with red/danger theme.
 */
export function ConfirmDeleteModal({
  isOpen,
  title,
  message,
  confirmLabel = 'Delete',
  onConfirm,
  onClose,
  loading = false,
  children,
}: ConfirmDeleteModalProps) {
  return (
    <Modal opened={isOpen} onClose={onClose} title={title} centered size="md">
      <Stack gap="md" data-testid="confirm-delete-modal">
        <Text size="sm">{message}</Text>
        {children}

        <Group justify="flex-end" gap="sm">
          <Button size="sm" variant="default" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            size="sm"
            color="red"
            onClick={onConfirm}
            loading={loading}
            data-testid="confirm-delete-submit"
          >
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
