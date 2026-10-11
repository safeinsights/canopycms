'use client'

/** Modal for adding an entry: entry-type selection, a title that seeds the slug, and the slug. */

import { useState, useEffect, useRef } from 'react'
import { Modal, Stack, TextInput, Group, Button, Alert, Text, Select } from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'

import type { EntryTypeUnavailable } from '../../config'
import { slugFromTitle, validateEntrySlug } from '../slug'
import { unavailableSchemaRefs } from '../unavailable-entry-type'
import { UnavailableTypeMessage } from './UnavailableTypeMessage'

export interface EntryType {
  name: string
  label?: string
  format: 'json' | 'md' | 'mdx' | 'yaml'
  default?: boolean
  maxItems?: number
  /** An unavailable type is never offered: it has no schema to create an entry against. */
  unavailable?: EntryTypeUnavailable
  /** Data path of the field that titles an entry of this type; its presence adds the Title input. */
  titleField?: readonly string[]
}

export interface EntryCreateModalProps {
  /** Whether the modal is open */
  isOpen: boolean
  /** Collection name for display */
  collectionLabel: string
  /** The collection's entry types (if more than one is available, show selector) */
  entryTypes: EntryType[]
  /** Pre-selected entry type (if specified) */
  selectedEntryTypeName?: string
  /** Called when the form is submitted; `title` is given only for a type with a `titleField`. */
  onCreate: (slug: string, entryTypeName: string, title?: string) => Promise<void>
  /** Called when modal is closed */
  onClose: () => void
  /** Whether a create operation is in progress */
  isCreating?: boolean
  /** Error message to display */
  error?: string | null
  /**
   * Slugs already taken in the target collection (from the already-loaded
   * entries list). Lets the client flag an obvious collision early with a
   * clear message; the server is still the authority, and without this
   * check an entry type with no required fields would silently succeed via
   * an update path instead of erroring.
   */
  existingSlugs?: Set<string>
  /** The URL path the entry will be served at, shown under the slug; undefined when it has no page. */
  previewPath?: (slug: string, entryTypeName: string) => string | undefined
}

export function EntryCreateModal({
  isOpen,
  collectionLabel,
  entryTypes: allEntryTypes,
  selectedEntryTypeName,
  onCreate,
  onClose,
  isCreating = false,
  error = null,
  existingSlugs,
  previewPath,
}: EntryCreateModalProps) {
  const entryTypes = allEntryTypes.filter((et) => !et.unavailable)
  const skippedSchemaRefs = unavailableSchemaRefs(allEntryTypes)
  // Only when nothing is left to create: a collection with some usable types shows them alone.
  const nothingToCreate = entryTypes.length === 0 && skippedSchemaRefs.length > 0
  // A collection that holds only collections has no entry type to add, available or not.
  const noEntryTypes = allEntryTypes.length === 0

  const getDefaultEntryTypeName = () => {
    const selectedIsUnavailable = allEntryTypes.some(
      (et) => et.name === selectedEntryTypeName && et.unavailable,
    )
    if (selectedEntryTypeName && !selectedIsUnavailable) return selectedEntryTypeName
    if (entryTypes.length === 1) return entryTypes[0].name
    const defaultType = entryTypes.find((et) => et.default)
    return defaultType?.name || entryTypes[0]?.name || ''
  }

  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  // Once the slug is typed by hand, the title stops rewriting it.
  const [slugEdited, setSlugEdited] = useState(false)
  const [titleTouched, setTitleTouched] = useState(false)
  const [slugTouched, setSlugTouched] = useState(false)
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [entryTypeName, setEntryTypeName] = useState(getDefaultEntryTypeName())

  // Seeds the form once per open, on the closed -> open transition. Keys on
  // `isOpen` alone, not on `entryTypes`/`selectedEntryTypeName`: `entryTypes`
  // is an array callers build inline, a fresh identity on every parent
  // render, so keying on it would silently reset the form on every
  // re-render while the modal is open. Do not add those props back to the
  // dep array below.
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setTitle('')
      setSlug('')
      setSlugEdited(false)
      setTitleTouched(false)
      setSlugTouched(false)
      setSubmitAttempted(false)
      setEntryTypeName(getDefaultEntryTypeName())
    }
    wasOpenRef.current = isOpen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const selectedType = entryTypes.find((et) => et.name === entryTypeName)
  const typeLabel = selectedType?.label || selectedType?.name || ''
  const hasTitle = !!selectedType?.titleField

  // Errors stay quiet until the user has typed, so a fresh form does not open on a red field.
  const showErrors = submitAttempted || titleTouched || slugTouched
  const slugError = validateEntrySlug(slug, { existingSlugs })
  const titleError = hasTitle && !title.trim() ? 'Enter a title' : null

  const handleTitleChange = (value: string) => {
    setTitle(value)
    setTitleTouched(true)
    if (!slugEdited) setSlug(slugFromTitle(value))
  }

  const handleSlugChange = (value: string) => {
    setSlug(value)
    setSlugEdited(true)
    setSlugTouched(true)
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (isCreating || !entryTypeName) return
    setSubmitAttempted(true)
    if (slugError || titleError) return
    await onCreate(slug, entryTypeName, hasTitle ? title.trim() : undefined)
  }

  const slugPath = previewPath?.(slug || 'your-slug', entryTypeName)

  return (
    <Modal
      opened={isOpen}
      onClose={onClose}
      title={<Text fw={600}>Add entry to {collectionLabel}</Text>}
      size="md"
      closeOnClickOutside={!isCreating}
      closeOnEscape={!isCreating}
    >
      {noEntryTypes ? (
        <Stack gap="md" data-testid="create-entry-modal">
          <Alert color="yellow" icon={<IconAlertCircle size={16} />} data-testid="no-entry-types">
            {collectionLabel} holds only collections, so there is no entry type to add.
          </Alert>
          <Group justify="flex-end">
            <Button size="sm" variant="subtle" onClick={onClose}>
              Close
            </Button>
          </Group>
        </Stack>
      ) : (
        <form onSubmit={handleSubmit} noValidate>
          <Stack gap="md" data-testid="create-entry-modal">
            {error && (
              <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
                {error}
              </Alert>
            )}

            {nothingToCreate && (
              <Alert
                color="yellow"
                icon={<IconAlertCircle size={16} />}
                data-testid="no-creatable-types"
              >
                <UnavailableTypeMessage schemaRefs={skippedSchemaRefs} />
              </Alert>
            )}

            {entryTypes.length > 1 && (
              <Select
                label="Entry type"
                value={entryTypeName}
                onChange={(value) => setEntryTypeName(value || '')}
                data={entryTypes.map((et) => ({
                  value: et.name,
                  label: et.label || et.name,
                }))}
                required
                disabled={isCreating}
                searchable
                placeholder="Select an entry type"
              />
            )}

            {entryTypes.length === 1 && (
              <Text size="sm" c="dimmed">
                Entry type: <strong>{typeLabel}</strong>
              </Text>
            )}

            {hasTitle && (
              <TextInput
                label="Title"
                value={title}
                onChange={(e) => handleTitleChange(e.currentTarget.value)}
                error={showErrors ? titleError : null}
                required
                disabled={isCreating}
                data-autofocus
                data-testid="entry-title-input"
              />
            )}

            <TextInput
              label="Slug"
              description={
                slugPath ? `URL path: ${slugPath}` : 'Lowercase letters, numbers and hyphens'
              }
              value={slug}
              onChange={(e) => handleSlugChange(e.currentTarget.value)}
              error={showErrors ? slugError : null}
              placeholder="my-entry-slug"
              required
              disabled={isCreating}
              data-autofocus={hasTitle ? undefined : true}
              data-testid="entry-slug-input"
            />

            <Group justify="flex-end" gap="sm">
              <Button size="sm" variant="subtle" onClick={onClose} disabled={isCreating}>
                Cancel
              </Button>
              <Button
                size="sm"
                type="submit"
                loading={isCreating}
                disabled={!entryTypeName}
                data-testid="create-entry-submit"
              >
                Add entry
              </Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  )
}
