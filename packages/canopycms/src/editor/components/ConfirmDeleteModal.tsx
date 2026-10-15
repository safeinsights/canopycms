'use client'

import type { ReactNode } from 'react'
import { Modal, Button, Text, Group, Stack } from '@mantine/core'
import { focusReturnProps } from '../utils/focus-return'

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
  /** Where focus goes once it closes; Mantine's default, the element focused at open, without it. */
  returnFocusTo?: () => HTMLElement | null
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
  returnFocusTo,
}: ConfirmDeleteModalProps) {
  return (
    <Modal
      opened={isOpen}
      onClose={onClose}
      title={title}
      centered
      size="md"
      closeButtonProps={{ disabled: loading }}
      closeOnEscape={!loading}
      closeOnClickOutside={!loading}
      {...focusReturnProps(returnFocusTo)}
    >
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
