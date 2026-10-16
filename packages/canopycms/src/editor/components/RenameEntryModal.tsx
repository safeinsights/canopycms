'use client'

/**
 * "Change URL": changes an entry's slug, the middle segment of its file name, which sets its URL.
 * Its name stays, since it comes from its title field. The content ID is preserved, so drafts and
 * references remain intact.
 */

import { useState } from 'react'
import { Modal, Stack, TextInput, Group, Button, Alert, Text } from '@mantine/core'
import { IconAlertCircle, IconAlertTriangle } from '@tabler/icons-react'

import { validateEntrySlug } from '../slug'
import { focusReturnProps } from '../utils/focus-return'
import { EDITOR_ACTIONS } from '../copy'

export interface RenameEntryModalProps {
  /** Whether the modal is open */
  isOpen: boolean
  /** Current entry label for display */
  entryLabel: string
  /** The label of the field the entry's name comes from (`titleFieldLabel`), if it has one. */
  titleFieldLabel?: string
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
  /** A rename whose outcome is unknown, shown in yellow in place of `error` */
  warning?: string | null
  /** Slugs held by the other entries of the collection; the entry's own slug is never a clash. */
  existingSlugs?: ReadonlySet<string>
  /** The URL path the entry will be served at for a slug; undefined when it has no page. */
  previewPath?: (slug: string) => string | undefined
  /** Where focus goes once it closes; Mantine's default, the element focused at open, without it. */
  returnFocusTo?: () => HTMLElement | null
}

export function RenameEntryModal({
  isOpen,
  entryLabel,
  titleFieldLabel,
  currentSlug,
  onSave,
  onClose,
  isSaving = false,
  error = null,
  warning = null,
  existingSlugs,
  previewPath,
  returnFocusTo,
}: RenameEntryModalProps) {
  const [newSlug, setNewSlug] = useState(currentSlug)
  const [touched, setTouched] = useState(false)

  // Reset state when modal opens (adjust state during render instead of effect)
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen)
  const [prevSlug, setPrevSlug] = useState(currentSlug)
  if (isOpen !== prevIsOpen || currentSlug !== prevSlug) {
    setPrevIsOpen(isOpen)
    setPrevSlug(currentSlug)
    if (isOpen) {
      setNewSlug(currentSlug)
      setTouched(false)
    }
  }

  const validationError = validateEntrySlug(newSlug, { existingSlugs, currentSlug })

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (isSaving) return
    setTouched(true)
    if (validationError) return
    if (newSlug === currentSlug) {
      onClose()
      return
    }
    await onSave(newSlug)
  }

  const slugPath = previewPath?.(newSlug || 'your-slug')

  return (
    <Modal
      opened={isOpen}
      onClose={onClose}
      title={<Text fw={600}>{EDITOR_ACTIONS.changeUrl}</Text>}
      size="md"
      closeOnClickOutside={!isSaving}
      closeOnEscape={!isSaving}
      {...focusReturnProps(returnFocusTo)}
    >
      <form onSubmit={handleSubmit} noValidate>
        <Stack gap="md" data-testid="rename-entry-modal">
          {warning ? (
            <Alert icon={<IconAlertTriangle size={16} />} color="yellow" variant="light">
              {warning}
            </Alert>
          ) : (
            error && (
              <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
                {error}
              </Alert>
            )
          )}

          <Text size="sm" c="dimmed" data-testid="change-url-help">
            This changes the URL and file name of “{entryLabel}”, not its name, which comes from its{' '}
            {titleFieldLabel ? `“${titleFieldLabel}” field` : 'title field'}. Edit that field in the
            form to change the name.
          </Text>

          <TextInput
            label="Slug"
            description={
              slugPath ? `URL path: ${slugPath}` : 'Lowercase letters, numbers and hyphens'
            }
            value={newSlug}
            onChange={(e) => {
              setNewSlug(e.currentTarget.value)
              setTouched(true)
            }}
            error={touched ? validationError : null}
            placeholder="my-entry-slug"
            required
            disabled={isSaving}
            data-autofocus
            data-testid="rename-slug-input"
          />

          <Group justify="flex-end" gap="sm">
            <Button size="sm" variant="subtle" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button
              size="sm"
              type="submit"
              loading={isSaving}
              disabled={newSlug === currentSlug}
              data-testid="rename-entry-submit"
            >
              {EDITOR_ACTIONS.changeUrl}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  )
}
