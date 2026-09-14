'use client'

/** Modal for creating a new entry: replaces window.prompt with entry-type selection, slug entry, and validation. */

import { useState, useEffect, useRef } from 'react'
import { Modal, Stack, TextInput, Group, Button, Alert, Text, Select } from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'

import { parseSlug } from '../../paths/validation'

/** Slug the form is seeded with each time the modal opens. */
const DEFAULT_SLUG = 'untitled'

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
  /**
   * Slugs already taken in the target collection (from the already-loaded
   * entries list). Lets the client flag an obvious collision early with a
   * clear message; the server is still the authority, and without this
   * check an entry type with no required fields would silently succeed via
   * an update path instead of erroring.
   */
  existingSlugs?: Set<string>
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
  existingSlugs,
}: EntryCreateModalProps) {
  const getDefaultEntryTypeName = () => {
    if (selectedEntryTypeName) return selectedEntryTypeName
    if (entryTypes.length === 1) return entryTypes[0].name
    const defaultType = entryTypes.find((et) => et.default)
    return defaultType?.name || entryTypes[0]?.name || ''
  }

  const [slug, setSlug] = useState(DEFAULT_SLUG)
  const [entryTypeName, setEntryTypeName] = useState(getDefaultEntryTypeName())
  const [validationError, setValidationError] = useState<string | null>(null)

  // Seeds the form once per open, on the closed -> open transition. Keys on
  // `isOpen` alone, not on `entryTypes`/`selectedEntryTypeName`: `entryTypes`
  // is an array callers build inline, a fresh identity on every parent
  // render, so keying on it would silently reset the form on every
  // re-render while the modal is open. Do not add those props back to the
  // dep array below.
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setSlug(DEFAULT_SLUG)
      setEntryTypeName(getDefaultEntryTypeName())
      setValidationError(null)
    }
    wasOpenRef.current = isOpen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  // Validate slug format.
  //
  // Delegates to `parseSlug` rather than restating its rule: the server refuses to CREATE an
  // entry whose slug fails it (api/content.ts and ContentStore.write's [SLUG] guards), and the
  // static build fails outright on one that slipped through (static/index.ts's
  // assertRoutableSlugs). A second, hand-maintained copy of the charset/length/separator rules
  // here could only ever drift out of agreement with the boundary that actually decides.
  //
  // Imported from '../../paths/validation' directly, NOT the `paths` barrel, which pulls
  // node:fs into the browser bundle (pnpm lint:bundle enforces this).
  const validateSlug = (value: string): string | null => {
    if (!value.trim()) {
      return 'Slug cannot be empty'
    }
    const parsed = parseSlug(value)
    if (!parsed.ok) {
      return parsed.error
    }
    // `parseSlug` lowercases before testing, so it accepts 'My-Post' and hands back 'my-post'.
    // Keep the field itself strict: the value typed here is what the duplicate check below and
    // the create request are keyed on, so silently normalizing would let 'My-Post' sail past a
    // collision with an existing 'my-post' and land as a 409 from the server instead of an
    // inline message here.
    if (parsed.slug !== value) {
      return 'Slug must be lowercase'
    }
    if (existingSlugs?.has(value)) {
      return 'An entry with this slug already exists'
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
