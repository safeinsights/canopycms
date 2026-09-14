'use client'

/**
 * EntryTypeEditor - Modal for creating/editing entry types within a collection.
 *
 * An entry type has a name (machine-readable id), label, format (md/mdx/json/
 * yaml), schema (registry key for field definitions), a default flag, and an
 * optional maxItems limit (1 behaves like a singleton).
 */

import { useState, useCallback, useEffect } from 'react'
import {
  Modal,
  Stack,
  TextInput,
  Select,
  Switch,
  NumberInput,
  Group,
  Button,
  Text,
  Alert,
  Tooltip,
} from '@mantine/core'
import { IconAlertCircle, IconLock } from '@tabler/icons-react'

import type { ContentFormat } from '../../config'
import type { CreateEntryTypeInput, UpdateEntryTypeInput } from '../../schema/schema-store-types'

export interface EntryTypeFormData {
  name: string
  label: string
  format: ContentFormat
  schema: string
  default: boolean
  maxItems: number | undefined
}

export interface EntryTypeEditorProps {
  isOpen: boolean
  /** Entry type being edited (null for create mode) */
  editingEntryType: {
    name: string
    label?: string
    format: ContentFormat
    schema: string
    default?: boolean
    maxItems?: number
    usageCount?: number
  } | null
  /** Available schema keys from the registry */
  availableSchemas: string[]
  /** Existing entry type names in the collection (for duplicate validation) */
  existingEntryTypeNames?: string[]
  onSave: (data: CreateEntryTypeInput | UpdateEntryTypeInput, isNew: boolean) => void
  onClose: () => void
  isSaving?: boolean
  error?: string | null
}

const FORMAT_OPTIONS: { value: ContentFormat; label: string }[] = [
  { value: 'json', label: 'JSON' },
  { value: 'yaml', label: 'YAML' },
  { value: 'md', label: 'Markdown' },
  { value: 'mdx', label: 'MDX' },
]

export function EntryTypeEditor({
  isOpen,
  editingEntryType,
  availableSchemas,
  existingEntryTypeNames = [],
  onSave,
  onClose,
  isSaving = false,
  error = null,
}: EntryTypeEditorProps) {
  const isEditMode = editingEntryType !== null
  const usageCount = editingEntryType?.usageCount ?? 0
  const isLocked = isEditMode && usageCount > 0

  const [formData, setFormData] = useState<EntryTypeFormData>({
    name: '',
    label: '',
    format: 'json',
    schema: '',
    default: false,
    maxItems: undefined,
  })

  const [validationError, setValidationError] = useState<string | null>(null)

  /* eslint-disable react-hooks/set-state-in-effect -- intentional: sync form state from props on open */
  useEffect(() => {
    if (isOpen) {
      if (editingEntryType) {
        setFormData({
          name: editingEntryType.name,
          label: editingEntryType.label || '',
          format: editingEntryType.format,
          schema: editingEntryType.schema,
          default: editingEntryType.default || false,
          maxItems: editingEntryType.maxItems,
        })
      } else {
        setFormData({
          name: '',
          label: '',
          format: 'json',
          schema: availableSchemas[0] || '',
          default: false,
          maxItems: undefined,
        })
      }
      setValidationError(null)
    }
  }, [isOpen, editingEntryType, availableSchemas])
  /* eslint-enable react-hooks/set-state-in-effect */

  const updateField = useCallback(
    <K extends keyof EntryTypeFormData>(field: K, value: EntryTypeFormData[K]) => {
      setFormData((prev) => ({ ...prev, [field]: value }))
      setValidationError(null)
    },
    [],
  )

  const validate = useCallback((): boolean => {
    if (!isEditMode && !formData.name.trim()) {
      setValidationError('Name is required')
      return false
    }
    if (!isEditMode && !/^[a-z][a-z0-9-]*$/.test(formData.name)) {
      setValidationError(
        'Name must start with a letter and contain only lowercase letters, numbers, and hyphens',
      )
      return false
    }
    if (formData.name.length > 64) {
      setValidationError('Name must be 64 characters or less')
      return false
    }
    if (!isEditMode && existingEntryTypeNames.includes(formData.name.trim())) {
      setValidationError('Entry type with this name already exists in this collection')
      return false
    }
    if (!formData.schema) {
      setValidationError('Schema is required')
      return false
    }
    return true
  }, [formData, isEditMode, existingEntryTypeNames])

  const handleSave = useCallback(() => {
    if (!validate()) return

    if (isEditMode) {
      const updates: UpdateEntryTypeInput = {}
      if (formData.label !== (editingEntryType?.label || '')) {
        updates.label = formData.label || undefined
      }
      if (formData.format !== editingEntryType?.format) {
        updates.format = formData.format
      }
      if (formData.schema !== editingEntryType?.schema) {
        updates.schema = formData.schema
      }
      if (formData.default !== (editingEntryType?.default || false)) {
        updates.default = formData.default
      }
      if (formData.maxItems !== editingEntryType?.maxItems) {
        updates.maxItems = formData.maxItems
      }
      onSave(updates, false)
    } else {
      const createData: CreateEntryTypeInput = {
        name: formData.name.trim(),
        format: formData.format,
        schema: formData.schema,
      }
      if (formData.label.trim()) {
        createData.label = formData.label.trim()
      }
      if (formData.default) {
        createData.default = true
      }
      if (formData.maxItems !== undefined) {
        createData.maxItems = formData.maxItems
      }
      onSave(createData, true)
    }
  }, [formData, isEditMode, editingEntryType, validate, onSave])

  const schemaOptions = availableSchemas.map((key) => ({
    value: key,
    label: key,
  }))

  const displayError = error || validationError

  return (
    <Modal
      opened={isOpen}
      onClose={onClose}
      title={isEditMode ? `Edit Entry Type: ${editingEntryType?.name}` : 'Add Entry Type'}
      size="md"
    >
      <Stack gap="md">
        {displayError && (
          <Alert
            icon={<IconAlertCircle size={16} />}
            color="red"
            title="Error"
            withCloseButton
            onClose={() => setValidationError(null)}
          >
            {displayError}
          </Alert>
        )}

        <TextInput
          label="Name"
          description="Machine-readable identifier (e.g., post, page, article)"
          placeholder="post"
          value={formData.name}
          onChange={(e) => updateField('name', e.target.value)}
          disabled={isEditMode}
          required={!isEditMode}
        />

        <TextInput
          label="Label"
          description="Human-readable display name"
          placeholder="Blog Post"
          value={formData.label}
          onChange={(e) => updateField('label', e.target.value)}
        />

        {/* Format */}
        <Tooltip
          label={
            isLocked
              ? `Cannot change format: ${usageCount} ${usageCount === 1 ? 'entry' : 'entries'} use this type`
              : ''
          }
          disabled={!isLocked}
          withinPortal
        >
          <Select
            label="Format"
            description={
              isLocked
                ? `Locked (${usageCount} ${usageCount === 1 ? 'entry' : 'entries'} exist)`
                : 'Content file format'
            }
            data={FORMAT_OPTIONS}
            value={formData.format}
            onChange={(value) => value && updateField('format', value as ContentFormat)}
            allowDeselect={false}
            disabled={isLocked}
            rightSection={isLocked ? <IconLock size={14} /> : undefined}
          />
        </Tooltip>

        {/* Schema */}
        <Tooltip
          label={
            isLocked
              ? `Cannot change schema: ${usageCount} ${usageCount === 1 ? 'entry' : 'entries'} use this type`
              : ''
          }
          disabled={!isLocked}
          withinPortal
        >
          <Select
            label="Schema"
            description={
              isLocked
                ? `Locked (${usageCount} ${usageCount === 1 ? 'entry' : 'entries'} exist)`
                : 'Field definitions for this entry type'
            }
            data={schemaOptions}
            value={formData.schema}
            onChange={(value) => value && updateField('schema', value)}
            searchable
            required
            placeholder="Select a schema"
            disabled={isLocked}
            rightSection={isLocked ? <IconLock size={14} /> : undefined}
          />
        </Tooltip>

        <Switch
          label="Default entry type"
          description="Use this type when adding new items to the collection"
          checked={formData.default}
          onChange={(e) => updateField('default', e.currentTarget.checked)}
        />

        <NumberInput
          label="Max Items"
          description="Limit number of items (leave empty for unlimited, use 1 for singleton-like behavior)"
          placeholder="Unlimited"
          value={formData.maxItems ?? ''}
          onChange={(value) =>
            updateField('maxItems', typeof value === 'number' ? value : undefined)
          }
          min={1}
          allowNegative={false}
          allowDecimal={false}
        />

        {formData.maxItems === 1 && (
          <Text size="xs" c="dimmed">
            With maxItems=1, this entry type behaves like a singleton (e.g., homepage, settings)
          </Text>
        )}

        <Group justify="flex-end" gap="sm" mt="md">
          <Button variant="subtle" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={isSaving}>
            {isEditMode ? 'Save Changes' : 'Add Entry Type'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

export default EntryTypeEditor
