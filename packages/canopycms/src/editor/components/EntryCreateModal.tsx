'use client'

/**
 * EntryCreateModal - Modal for creating new entries.
 *
 * Replaces window.prompt with a proper UI for:
 * - Selecting entry type (if multiple types available)
 * - Entering slug for new entry
 * - Validation and error handling
 */

import { useState, useEffect } from 'react'
import { Modal, Stack, TextInput, Group, Button, Alert, Text, Select } from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'

export interface EntryType {
  name: string
  label?: string
  format: 'json' | 'md' | 'mdx' | 'yaml'
  default?: boolean
  maxItems?: number
}

export interface EntryCreateModalProps {
  /** Whether the modal is open */
  isOpen: boolean
  /** Collection name for display */
  collectionLabel: string
  /** Available entry types (if multiple, show selector) */
  entryTypes: EntryType[]
  /** Pre-selected entry type (if specified) */
  selectedEntryTypeName?: string
  /** Called when create is clicked */
  onCreate: (slug: string, entryTypeName: string) => Promise<void>
  /** Called when modal is closed */
  onClose: () => void
  /** Whether a create operation is in progress */
  isCreating?: boolean
  /** Error message to display */
  error?: string | null
}

export function EntryCreateModal({
  isOpen,
  collectionLabel,
  entryTypes,
  selectedEntryTypeName,
  onCreate,
  onClose,
  isCreating = false,
  error = null,
}: EntryCreateModalProps) {
  // Helper to get default or first entry type
  const getDefaultEntryTypeName = () => {
    if (selectedEntryTypeName) return selectedEntryTypeName
    if (entryTypes.length === 1) return entryTypes[0].name
    // Find entry type marked as default
    const defaultType = entryTypes.find((et) => et.default)
    return defaultType?.name || entryTypes[0]?.name || ''
  }

  const [slug, setSlug] = useState('untitled')
  const [entryTypeName, setEntryTypeName] = useState(getDefaultEntryTypeName())
  const [validationError, setValidationError] = useState<string | null>(null)

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setSlug('untitled')
      setEntryTypeName(getDefaultEntryTypeName())
      setValidationError(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, selectedEntryTypeName, entryTypes])

  // Validate slug format
  const validateSlug = (value: string): string | null => {
    if (!value.trim()) {
      return 'Slug cannot be empty'
    }
    if (value.includes('/')) {
      return 'Slug cannot contain slashes'
    }
    // Simple validation - lowercase, alphanumeric + hyphens
    if (!/^[a-z0-9][-a-z0-9]*$/.test(value)) {
      return 'Slug must start with letter/number and contain only lowercase letters, numbers, and hyphens'
    }
    if (value.length > 64) {
      return 'Slug must be 64 characters or less'
    }
    return null
  }

  const handleSlugChange = (value: string) => {
    setSlug(value)
    setValidationError(validateSlug(value))
  }

  const handleCreate = async () => {
    const validation = validateSlug(slug)
    if (validation) {
      setValidationError(validation)
      return
    }
    if (!entryTypeName) {
      setValidationError('Please select an entry type')
      return
    }
    await onCreate(slug, entryTypeName)
  }

  const canCreate = !validationError && slug.trim() !== '' && entryTypeName !== '' && !isCreating

  const selectedType = entryTypes.find((et) => et.name === entryTypeName)
  const typeLabel = selectedType?.label || selectedType?.name || ''

  return (
    <Modal
      opened={isOpen}
      onClose={onClose}
      title={<Text fw={600}>Create New Entry</Text>}
      size="md"
      closeOnClickOutside={!isCreating}
      closeOnEscape={!isCreating}
    >
      <Stack gap="md" data-testid="create-entry-modal">
        {error && (
          <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
            {error}
          </Alert>
        )}

        <Text size="sm" c="dimmed">
          Creating in: {collectionLabel}
        </Text>

        {entryTypes.length > 1 && (
          <Select
            label="Entry Type"
            description="Select the type of entry to create"
            value={entryTypeName}
            onChange={(value) => setEntryTypeName(value || '')}
            data={entryTypes.map((et) => ({
              value: et.name,
              label: et.label || et.name,
            }))}
            required
            disabled={isCreating}
            searchable
            placeholder="Select entry type..."
          />
        )}

        {entryTypes.length === 1 && (
          <Text size="sm" c="dimmed">
            Entry type: <strong>{typeLabel}</strong>
          </Text>
        )}

        <TextInput
          label="Slug"
          description="URL-friendly identifier (lowercase, alphanumeric + hyphens)"
          value={slug}
          onChange={(e) => handleSlugChange(e.currentTarget.value)}
          error={validationError}
          placeholder="my-entry-slug"
          required
          disabled={isCreating}
          data-autofocus
          data-testid="entry-slug-input"
        />

        <Text size="xs" c="dimmed">
          Preview: <code>{slug}</code>
        </Text>

        <Group justify="flex-end" gap="sm">
          <Button variant="subtle" onClick={onClose} disabled={isCreating}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            loading={isCreating}
            disabled={!canCreate}
            data-testid="create-entry-submit"
          >
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
