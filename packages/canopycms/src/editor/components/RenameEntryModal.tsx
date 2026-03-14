'use client'

/**
 * RenameEntryModal - Modal for renaming entry slugs.
 *
 * Allows changing the slug (middle segment) of an entry filename.
 * The content ID is preserved, so drafts and references remain intact.
 */

import { useState, useEffect } from 'react'
import { Modal, Stack, TextInput, Group, Button, Alert, Text } from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'

export interface RenameEntryModalProps {
  /** Whether the modal is open */
  isOpen: boolean
  /** Current entry label for display */
  entryLabel: string
  /** Current slug value */
  currentSlug: string
  /** Called when save is clicked */
  onSave: (newSlug: string) => Promise<void>
  /** Called when modal is closed */
  onClose: () => void
  /** Whether a save operation is in progress */
  isSaving?: boolean
  /** Error message to display */
  error?: string | null
}

export function RenameEntryModal({
  isOpen,
  entryLabel,
  currentSlug,
  onSave,
  onClose,
  isSaving = false,
  error = null,
}: RenameEntryModalProps) {
  const [newSlug, setNewSlug] = useState(currentSlug)
  const [validationError, setValidationError] = useState<string | null>(null)

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setNewSlug(currentSlug)
      setValidationError(null)
    }
  }, [isOpen, currentSlug])

  // Validate slug format
  const validateSlug = (slug: string): string | null => {
    if (!slug.trim()) {
      return 'Slug cannot be empty'
    }
    if (slug.includes('/')) {
      return 'Slug cannot contain slashes'
    }
    // Simple validation - lowercase, alphanumeric + hyphens
    if (!/^[a-z0-9][-a-z0-9]*$/.test(slug)) {
      return 'Slug must start with letter/number and contain only lowercase letters, numbers, and hyphens'
    }
    if (slug.length > 64) {
      return 'Slug must be 64 characters or less'
    }
    return null
  }

  const handleSlugChange = (value: string) => {
    setNewSlug(value)
    setValidationError(validateSlug(value))
  }

  const handleSave = async () => {
    const validation = validateSlug(newSlug)
    if (validation) {
      setValidationError(validation)
      return
    }
    if (newSlug === currentSlug) {
      onClose()
      return
    }
    await onSave(newSlug)
  }

  const canSave = !validationError && newSlug.trim() !== '' && newSlug !== currentSlug && !isSaving

  return (
    <Modal
      opened={isOpen}
      onClose={onClose}
      title={<Text fw={600}>Rename Entry</Text>}
      size="md"
      closeOnClickOutside={!isSaving}
      closeOnEscape={!isSaving}
    >
      <Stack gap="md" data-testid="rename-entry-modal">
        {error && (
          <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
            {error}
          </Alert>
        )}

        <Text size="sm" c="dimmed">
          Renaming "{entryLabel}"
        </Text>

        <TextInput
          label="Slug"
          description="URL-friendly identifier (lowercase, alphanumeric + hyphens)"
          value={newSlug}
          onChange={(e) => handleSlugChange(e.currentTarget.value)}
          error={validationError}
          placeholder="my-entry-slug"
          required
          disabled={isSaving}
          data-autofocus
          data-testid="rename-slug-input"
        />

        <Text size="xs" c="dimmed">
          Current: <code>{currentSlug}</code>
          {newSlug !== currentSlug && (
            <>
              {' → '}
              New: <code>{newSlug}</code>
            </>
          )}
        </Text>

        <Group justify="flex-end" gap="sm">
          <Button variant="subtle" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={isSaving} disabled={!canSave} data-testid="rename-entry-submit">
            Rename
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
