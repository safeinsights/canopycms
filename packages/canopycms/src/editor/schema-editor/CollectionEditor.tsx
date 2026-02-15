'use client'

/**
 * CollectionEditor - Modal for creating/editing collections.
 *
 * Collections are containers for content items with:
 * - name: Machine-readable identifier (e.g., "posts", "pages")
 * - label: Human-readable display name
 * - entries: Array of entry types defining what content can be created
 *
 * When creating a collection, at least one entry type is required.
 * When editing, only name and label can be changed (entry types are managed separately).
 */

import { useState, useCallback, useEffect } from 'react'
import {
  Modal,
  Stack,
  TextInput,
  Group,
  Button,
  Alert,
  Text,
  Paper,
  ActionIcon,
  Menu,
  Divider,
  Badge,
} from '@mantine/core'
import {
  IconAlertCircle,
  IconPlus,
  IconDotsVertical,
  IconTrash,
  IconEdit,
  IconStar,
} from '@tabler/icons-react'

import type { ContentFormat } from '../../config'
import type {
  CreateCollectionInput,
  UpdateCollectionInput,
  CreateEntryTypeInput,
} from '../../schema/schema-store-types'
import type { LogicalPath } from '../../paths/types'
import { EntryTypeEditor } from './EntryTypeEditor'
import { ConfirmDeleteModal } from '../components/ConfirmDeleteModal'

// ============================================================================
// Types
// ============================================================================

export interface CollectionFormData {
  name: string
  label: string
  entries: CreateEntryTypeInput[]
}

/** Existing entry type info for edit mode */
export interface ExistingEntryType {
  name: string
  label?: string
  format: ContentFormat
  fields: string
  default?: boolean
  maxItems?: number
  /** Number of entries using this type (for locking validation) */
  usageCount?: number
}

/** Collection info for edit mode */
export interface ExistingCollection {
  name: string
  label?: string
  logicalPath: LogicalPath
  entries: ExistingEntryType[]
}

export interface CollectionEditorProps {
  /** Whether the modal is open */
  isOpen: boolean
  /** Collection being edited (null for create mode) */
  editingCollection: ExistingCollection | null
  /** Parent path for nested collections (only used in create mode) */
  parentPath?: LogicalPath
  /** Available schema keys from the registry */
  availableSchemas: string[]
  /** Called when save is clicked for collection create/update */
  onSave: (data: CreateCollectionInput | UpdateCollectionInput, isNew: boolean) => void
  /** Called when an entry type is added (edit mode only) */
  onAddEntryType?: (collectionPath: LogicalPath, entryType: CreateEntryTypeInput) => void
  /** Called when an entry type is updated (edit mode only) */
  onUpdateEntryType?: (
    collectionPath: LogicalPath,
    entryTypeName: string,
    updates: Partial<CreateEntryTypeInput>,
  ) => void
  /** Called when an entry type is removed (edit mode only) */
  onRemoveEntryType?: (collectionPath: LogicalPath, entryTypeName: string) => void
  /** Called when modal is closed */
  onClose: () => void
  /** Whether a save operation is in progress */
  isSaving?: boolean
  /** Error message to display */
  error?: string | null
}

// ============================================================================
// Component
// ============================================================================

export function CollectionEditor({
  isOpen,
  editingCollection,
  parentPath,
  availableSchemas,
  onSave,
  onAddEntryType,
  onUpdateEntryType,
  onRemoveEntryType,
  onClose,
  isSaving = false,
  error = null,
}: CollectionEditorProps) {
  const isEditMode = editingCollection !== null

  // Form state
  const [formData, setFormData] = useState<CollectionFormData>({
    name: '',
    label: '',
    entries: [],
  })

  // Slug field state (edit mode only)
  const [slug, setSlug] = useState('')

  // Local validation error
  const [validationError, setValidationError] = useState<string | null>(null)

  // Entry type editor state
  const [entryTypeEditorOpen, setEntryTypeEditorOpen] = useState(false)
  const [editingEntryType, setEditingEntryType] = useState<ExistingEntryType | null>(null)
  const [editingEntryTypeIndex, setEditingEntryTypeIndex] = useState<number | null>(null)

  // Delete entry type confirmation state
  const [deleteEntryTypeModalOpen, setDeleteEntryTypeModalOpen] = useState(false)
  const [deletingEntryType, setDeletingEntryType] = useState<{
    entryType: ExistingEntryType | CreateEntryTypeInput
    index: number
  } | null>(null)

  // Reset form when modal opens or editing item changes
  useEffect(() => {
    if (isOpen) {
      if (editingCollection) {
        setFormData({
          name: editingCollection.name,
          label: editingCollection.label || '',
          entries: [], // Entry types are managed separately in edit mode
        })
        // Extract slug from logical path (e.g., "content/posts.abc123" → "posts")
        const pathParts = editingCollection.logicalPath.split('/')
        const lastPart = pathParts[pathParts.length - 1]
        const slugPart = lastPart?.split('.')[0] || ''
        setSlug(slugPart)
      } else {
        setFormData({
          name: '',
          label: '',
          entries: [],
        })
        setSlug('')
      }
      setValidationError(null)
    }
  }, [isOpen, editingCollection])

  // Update a form field
  const updateField = useCallback(
    <K extends keyof CollectionFormData>(field: K, value: CollectionFormData[K]) => {
      setFormData((prev) => ({ ...prev, [field]: value }))
      setValidationError(null)
    },
    [],
  )

  // Validate form
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
    if (!isEditMode && formData.entries.length === 0) {
      setValidationError('At least one entry type is required')
      return false
    }
    return true
  }, [formData, isEditMode])

  // Handle save
  const handleSave = useCallback(() => {
    if (!validate()) return

    if (isEditMode) {
      // Only include changed fields for update
      const updates: UpdateCollectionInput = {}
      if (formData.name !== (editingCollection?.name || '')) {
        updates.name = formData.name.trim() || undefined
      }
      if (formData.label !== (editingCollection?.label || '')) {
        updates.label = formData.label || undefined
      }
      // Include slug if changed
      const pathParts = editingCollection?.logicalPath.split('/') || []
      const lastPart = pathParts[pathParts.length - 1]
      const currentSlug = lastPart?.split('.')[0] || ''
      if (slug && slug !== currentSlug) {
        updates.slug = slug
      }
      onSave(updates, false)
    } else {
      // Create new collection
      const createData: CreateCollectionInput = {
        name: formData.name.trim(),
        entries: formData.entries,
      }
      if (formData.label.trim()) {
        createData.label = formData.label.trim()
      }
      if (parentPath) {
        createData.parentPath = parentPath
      }
      onSave(createData, true)
    }
  }, [formData, slug, isEditMode, editingCollection, parentPath, validate, onSave])

  // Entry type management (create mode)
  const handleOpenAddEntryType = useCallback(() => {
    setEditingEntryType(null)
    setEditingEntryTypeIndex(null)
    setEntryTypeEditorOpen(true)
  }, [])

  const handleOpenEditEntryType = useCallback((entryType: ExistingEntryType, index: number) => {
    setEditingEntryType(entryType)
    setEditingEntryTypeIndex(index)
    setEntryTypeEditorOpen(true)
  }, [])

  const handleEntryTypeSave = useCallback(
    (data: CreateEntryTypeInput | Partial<CreateEntryTypeInput>, isNew: boolean) => {
      if (isEditMode && editingCollection) {
        // In edit mode, delegate to parent handlers
        if (isNew) {
          onAddEntryType?.(editingCollection.logicalPath, data as CreateEntryTypeInput)
        } else if (editingEntryType) {
          onUpdateEntryType?.(editingCollection.logicalPath, editingEntryType.name, data)
        }
      } else {
        // In create mode, manage entries locally
        if (isNew) {
          setFormData((prev) => ({
            ...prev,
            entries: [...prev.entries, data as CreateEntryTypeInput],
          }))
        } else if (editingEntryTypeIndex !== null) {
          setFormData((prev) => ({
            ...prev,
            entries: prev.entries.map((e, i) =>
              i === editingEntryTypeIndex ? { ...e, ...data } : e,
            ),
          }))
        }
      }
      setEntryTypeEditorOpen(false)
      setEditingEntryType(null)
      setEditingEntryTypeIndex(null)
    },
    [
      isEditMode,
      editingCollection,
      editingEntryType,
      editingEntryTypeIndex,
      onAddEntryType,
      onUpdateEntryType,
    ],
  )

  const handleRemoveEntryType = useCallback(
    (entryType: ExistingEntryType | CreateEntryTypeInput, index: number) => {
      setDeletingEntryType({ entryType, index })
      setDeleteEntryTypeModalOpen(true)
    },
    [],
  )

  const confirmRemoveEntryType = useCallback(() => {
    if (!deletingEntryType) return

    const { entryType, index } = deletingEntryType

    if (isEditMode && editingCollection) {
      onRemoveEntryType?.(editingCollection.logicalPath, entryType.name)
    } else {
      setFormData((prev) => ({
        ...prev,
        entries: prev.entries.filter((_, i) => i !== index),
      }))
    }

    setDeleteEntryTypeModalOpen(false)
    setDeletingEntryType(null)
  }, [deletingEntryType, isEditMode, editingCollection, onRemoveEntryType])

  // Get entry types to display
  const displayEntryTypes: (ExistingEntryType | CreateEntryTypeInput)[] = isEditMode
    ? editingCollection?.entries || []
    : formData.entries

  const displayError = error || validationError

  return (
    <>
      <Modal
        opened={isOpen}
        onClose={onClose}
        title={isEditMode ? `Edit Collection: ${editingCollection?.name}` : 'Create Collection'}
        size="lg"
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

          {/* Name - metadata field in .collection.json, independent of directory slug */}
          <TextInput
            label="Name"
            description="Machine-readable identifier (e.g., posts, pages, articles)"
            placeholder="posts"
            value={formData.name}
            onChange={(e) => updateField('name', e.target.value)}
            required={!isEditMode}
          />

          {/* Label */}
          <TextInput
            label="Label"
            description="Human-readable display name"
            placeholder="Blog Posts"
            value={formData.label}
            onChange={(e) => updateField('label', e.target.value)}
          />

          {/* Slug - only shown in edit mode */}
          {isEditMode && (
            <TextInput
              label="Slug"
              description="Directory name (filesystem path). Changing this renames the directory."
              placeholder="posts"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value)
                setValidationError(null)
              }}
            />
          )}

          {parentPath && !isEditMode && (
            <Text size="sm" c="dimmed">
              This collection will be created inside: <strong>{parentPath}</strong>
            </Text>
          )}

          {/* Entry Types Section */}
          <Divider label="Entry Types" labelPosition="left" mt="md" />

          {displayEntryTypes.length === 0 ? (
            <Paper p="md" withBorder>
              <Text c="dimmed" ta="center" size="sm">
                No entry types defined. Add at least one entry type to define what content can be
                created in this collection.
              </Text>
            </Paper>
          ) : (
            <Stack gap="xs">
              {displayEntryTypes.map((entryType, index) => (
                <Paper key={entryType.name} p="sm" withBorder>
                  <Group justify="space-between" wrap="nowrap">
                    <Group gap="sm">
                      <div>
                        <Group gap="xs">
                          <Text fw={500} size="sm">
                            {entryType.name}
                          </Text>
                          {entryType.default && (
                            <Badge size="xs" color="blue" leftSection={<IconStar size={10} />}>
                              Default
                            </Badge>
                          )}
                          {entryType.maxItems === 1 && (
                            <Badge size="xs" color="gray">
                              Singleton
                            </Badge>
                          )}
                        </Group>
                        <Text size="xs" c="dimmed">
                          {entryType.format.toUpperCase()} · {entryType.fields}
                          {entryType.label && ` · "${entryType.label}"`}
                        </Text>
                      </div>
                    </Group>
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target>
                        <ActionIcon variant="subtle" size="sm">
                          <IconDotsVertical size={16} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          leftSection={<IconEdit size={14} />}
                          onClick={() =>
                            handleOpenEditEntryType(entryType as ExistingEntryType, index)
                          }
                        >
                          Edit
                        </Menu.Item>
                        <Menu.Divider />
                        <Menu.Item
                          leftSection={<IconTrash size={14} />}
                          color="red"
                          onClick={() => handleRemoveEntryType(entryType, index)}
                          disabled={displayEntryTypes.length === 1}
                        >
                          Remove
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Group>
                </Paper>
              ))}
            </Stack>
          )}

          <Button
            variant="light"
            leftSection={<IconPlus size={16} />}
            onClick={handleOpenAddEntryType}
          >
            Add Entry Type
          </Button>

          {/* Actions */}
          <Group justify="flex-end" gap="sm" mt="md">
            <Button variant="subtle" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={isSaving}>
              {isEditMode ? 'Save Changes' : 'Create Collection'}
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Entry Type Editor Modal */}
      <EntryTypeEditor
        isOpen={entryTypeEditorOpen}
        editingEntryType={editingEntryType}
        availableSchemas={availableSchemas}
        existingEntryTypeNames={displayEntryTypes.map((et) => et.name)}
        onSave={handleEntryTypeSave}
        onClose={() => {
          setEntryTypeEditorOpen(false)
          setEditingEntryType(null)
          setEditingEntryTypeIndex(null)
        }}
      />

      {/* Delete Entry Type Confirmation Modal */}
      <ConfirmDeleteModal
        isOpen={deleteEntryTypeModalOpen}
        title="Remove Entry Type"
        message={
          deletingEntryType &&
          'usageCount' in deletingEntryType.entryType &&
          deletingEntryType.entryType.usageCount
            ? `This entry type is used by ${deletingEntryType.entryType.usageCount} ${deletingEntryType.entryType.usageCount === 1 ? 'entry' : 'entries'}. Removing it will prevent editing those entries. Are you sure you want to remove this entry type?`
            : 'Are you sure you want to remove this entry type? This cannot be undone.'
        }
        confirmLabel="Remove Entry Type"
        onConfirm={confirmRemoveEntryType}
        onClose={() => {
          setDeleteEntryTypeModalOpen(false)
          setDeletingEntryType(null)
        }}
      />
    </>
  )
}

export default CollectionEditor
