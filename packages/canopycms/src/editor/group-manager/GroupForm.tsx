'use client'

/**
 * Modal form for creating/editing groups
 */

import React from 'react'
import { Button, Group, Modal, Paper, Stack, Text, TextInput, Textarea } from '@mantine/core'
import type { InternalGroup, GroupFormData } from './types'

export interface GroupFormProps {
  isOpen: boolean
  editingGroup: InternalGroup | null
  formData: GroupFormData
  onFormChange: (data: Partial<GroupFormData>) => void
  onSave: () => void
  onClose: () => void
}

export const GroupForm: React.FC<GroupFormProps> = ({
  isOpen,
  editingGroup,
  formData,
  onFormChange,
  onSave,
  onClose,
}) => {
  return (
    <Modal
      opened={isOpen}
      onClose={onClose}
      title={editingGroup ? 'Edit Group' : 'Create Group'}
    >
      <Stack gap="md">
        {editingGroup && (
          <div>
            <Text size="sm" fw={500} mb={4}>
              ID (system-generated)
            </Text>
            <Paper p="xs" withBorder bg="gray.0">
              <Text size="sm" ff="monospace" c="dimmed">
                {editingGroup.id}
              </Text>
            </Paper>
          </div>
        )}
        <TextInput
          label="Group Name"
          placeholder="e.g., Content Editors"
          value={formData.name}
          onChange={(e) => onFormChange({ name: e.target.value })}
          required
        />
        <Textarea
          label="Description"
          placeholder="Optional description"
          value={formData.description}
          onChange={(e) => onFormChange({ description: e.target.value })}
          rows={3}
        />
        <Group justify="flex-end" gap="sm">
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSave}>{editingGroup ? 'Save' : 'Create'}</Button>
        </Group>
      </Stack>
    </Modal>
  )
}
