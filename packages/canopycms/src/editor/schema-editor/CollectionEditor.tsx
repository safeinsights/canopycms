'use client'

/**
 * CollectionEditor - Modal for creating/editing collections.
 *
 * A collection has a name (machine-readable id), label (display name), and
 * entries (entry types defining what content can be created). Create mode
 * requires at least one entry type; edit mode only allows changing name and
 * label (entry types are managed separately).
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
import { getErrorMessage } from '../../utils/error'
import type { SchemaOpResult } from '../hooks/useSchemaManager'

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
  schema: string
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
  isOpen: boolean
  /** Collection being edited (null for create mode) */
  editingCollection: ExistingCollection | null
  /** Parent path for nested collections (only used in create mode) */
  parentPath?: LogicalPath
  /** Available schema keys from the registry */
  availableSchemas: string[]
  /** Called when save is clicked for collection create/update */
  onSave: (data: CreateCollectionInput | UpdateCollectionInput, isNew: boolean) => void
  /** Called when an entry type is added (edit mode only); resolves to the save result */
  onAddEntryType?: (
    collectionPath: LogicalPath,
    entryType: CreateEntryTypeInput,
  ) => Promise<SchemaOpResult>
  /** Called when an entry type is updated (edit mode only); resolves to the save result */
  onUpdateEntryType?: (
    collectionPath: LogicalPath,
    entryTypeName: string,
    updates: Partial<CreateEntryTypeInput>,
  ) => Promise<SchemaOpResult>
  /** Called when an entry type is removed (edit mode only) */
  onRemoveEntryType?: (
    collectionPath: LogicalPath,
    entryTypeName: string,
  ) => Promise<SchemaOpResult> | void
  onClose: () => void
  isSaving?: boolean
  error?: string | null
}

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

  const [formData, setFormData] = useState<CollectionFormData>({
    name: '',
    label: '',
    entries: [],
  })

  // Slug field state (edit mode only)
  const [slug, setSlug] = useState('')

  const [validationError, setValidationError] = useState<string | null>(null)

  const [entryTypeEditorOpen, setEntryTypeEditorOpen] = useState(false)
  const [editingEntryType, setEditingEntryType] = useState<ExistingEntryType | null>(null)
  const [editingEntryTypeIndex, setEditingEntryTypeIndex] = useState<number | null>(null)
  const [entryTypeSaving, setEntryTypeSaving] = useState(false)
  const [entryTypeError, setEntryTypeError] = useState<string | null>(null)

  const [deleteEntryTypeModalOpen, setDeleteEntryTypeModalOpen] = useState(false)
  const [deletingEntryType, setDeletingEntryType] = useState<{
    entryType: ExistingEntryType | CreateEntryTypeInput
    index: number
  } | null>(null)

  useEffect(() => {
    if (isOpen) {
      if (editingCollection) {
        setFormData({
          name: editingCollection.name,
          label: editingCollection.label || '',
          entries: [], // Entry types are managed separately in edit mode
        })
        // Slug is the logical path's last segment before its embedded id (e.g. "posts.abc123" -> "posts").
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

  const updateField = useCallback(
    <K extends keyof CollectionFormData>(field: K, value: CollectionFormData[K]) => {
      setFormData((prev) => ({ ...prev, [field]: value }))
      setValidationError(null)
    },
    [],
  )

  const validate = useCallback((): boolean => {
    if (!formData.name.trim()) {
      setValidationError('Name is required')
      return false
    }
    // Enforced in both create and edit mode: the server rejects unsafe
    // names too, but this validates for immediate feedback.
    if (!/^[a-z][a-z0-9-]*$/.test(formData.name)) {
      setValidationError(
        'Name must start with a letter and contain only lowercase letters, numbers, and hyphens',
      )
      return false
    }
    if (formData.name.length > 64) {
      setValidationError('Name must be 64 characters or less')
      return false
    }
    if (!isEditMode && formData.entries.length === 0) {
      setValidationError('At least one entry type is required')
      return false
    }
    return true
  }, [formData, isEditMode])

  const handleSave = useCallback(() => {
    if (!validate()) return

    if (isEditMode) {
      const updates: UpdateCollectionInput = {}
      if (formData.name !== (editingCollection?.name || '')) {
        updates.name = formData.name.trim() || undefined
      }
      if (formData.label !== (editingCollection?.label || '')) {
        updates.label = formData.label || undefined
      }
      const pathParts = editingCollection?.logicalPath.split('/') || []
      const lastPart = pathParts[pathParts.length - 1]
      const currentSlug = lastPart?.split('.')[0] || ''
      if (slug && slug !== currentSlug) {
        updates.slug = slug
      }
      onSave(updates, false)
    } else {
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

  const handleOpenAddEntryType = useCallback(() => {
    setEditingEntryType(null)
    setEditingEntryTypeIndex(null)
    setEntryTypeError(null)
    setEntryTypeEditorOpen(true)
  }, [])

  const handleOpenEditEntryType = useCallback((entryType: ExistingEntryType, index: number) => {
    setEditingEntryType(entryType)
    setEditingEntryTypeIndex(index)
    setEntryTypeError(null)
    setEntryTypeEditorOpen(true)
  }, [])

  const handleEntryTypeSave = useCallback(
    async (data: CreateEntryTypeInput | Partial<CreateEntryTypeInput>, isNew: boolean) => {
      if (isEditMode && editingCollection) {
        setEntryTypeSaving(true)
        setEntryTypeError(null)
        try {
          // Absent props (optional chaining short-circuits to `undefined`) are
          // treated as success — there's nothing to report back for them.
          const result = isNew
            ? await onAddEntryType?.(editingCollection.logicalPath, data as CreateEntryTypeInput)
            : editingEntryType
              ? await onUpdateEntryType?.(
                  editingCollection.logicalPath,
                  editingEntryType.name,
                  data,
                )
              : undefined
          if (result && !result.ok) {
            setEntryTypeError(result.error)
            return
          }
        } catch (err) {
          // Last resort: onAddEntryType/onUpdateEntryType return result objects
          // by contract and aren't expected to throw; guards a caller violating it.
          setEntryTypeError(getErrorMessage(err))
          return
        } finally {
          setEntryTypeSaving(false)
        }
      } else {
        // In create mode, manage entries locally (no server round trip)
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

          {/* Name is metadata in .collection.json, independent of the directory slug */}
          <TextInput
            label="Name"
            description="Machine-readable identifier (e.g., posts, pages, articles)"
            placeholder="posts"
            value={formData.name}
            onChange={(e) => updateField('name', e.target.value)}
            required
          />

          <TextInput
            label="Label"
            description="Human-readable display name"
            placeholder="Blog Posts"
            value={formData.label}
            onChange={(e) => updateField('label', e.target.value)}
          />

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
                          {entryType.format.toUpperCase()} · {entryType.schema}
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
          setEntryTypeError(null)
        }}
        isSaving={entryTypeSaving}
        error={entryTypeError}
      />

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
