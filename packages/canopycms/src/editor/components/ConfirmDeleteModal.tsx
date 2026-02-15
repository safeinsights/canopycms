'use client'

import { Modal, Button, Text, Group, Stack } from '@mantine/core'

export interface ConfirmDeleteModalProps {
  isOpen: boolean
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onClose: () => void
  loading?: boolean
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
}: ConfirmDeleteModalProps) {
  return (
    <Modal
      opened={isOpen}
      onClose={onClose}
      title={title}
      centered
      size="md"
    >
      <Stack gap="md">
        <Text size="sm">{message}</Text>

        <Group justify="flex-end" gap="sm">
          <Button
            variant="default"
            onClick={onClose}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            color="red"
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
