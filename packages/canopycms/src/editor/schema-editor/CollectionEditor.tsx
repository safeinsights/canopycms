'use client'

/**
 * CollectionEditor - Modal for creating/editing collections.
 *
 * A collection has a name (machine-readable id), label (display name), and
 * entries (entry types defining what content can be created). Create mode
 * stages everything locally and sends it with "Create collection"; Cancel
 * discards it. Edit mode stages name, label and slug until "Save collection
 * details", but every entry-type add, update and remove saves to the branch
 * at once, so the footer reads "Close" once one has succeeded: Cancel would
 * promise a revert it cannot do.
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
  Tooltip,
} from '@mantine/core'
import {
  IconAlertCircle,
  IconCheck,
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
import { ReasonedMenuItem } from '../components/ReasonedMenuItem'
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
  /** Called when an entry type is removed (edit mode only); resolves to the save result */
  onRemoveEntryType?: (
    collectionPath: LogicalPath,
    entryTypeName: string,
  ) => Promise<SchemaOpResult>
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

  // Edit mode renders this list rather than `editingCollection.entries`, a snapshot taken when
  // the dialog opened that the parent never refreshes. Each immediate action patches it.
  const [entryTypes, setEntryTypes] = useState<ExistingEntryType[]>(
    () => editingCollection?.entries ?? [],
  )
  // True once an immediate entry-type change has saved in this opening of the dialog.
  const [entryTypeChanged, setEntryTypeChanged] = useState(false)
  const [entryTypeStatus, setEntryTypeStatus] = useState('')
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null)

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
          entries: [], // Edit mode keeps its entry types in `entryTypes`
        })
        setEntryTypes(editingCollection.entries)
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
        setEntryTypes([])
      }
      setValidationError(null)
      setEntryTypeChanged(false)
      setEntryTypeStatus('')
      setRemoveError(null)
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

  const announceEntryTypeChange = useCallback((message: string) => {
    setEntryTypeStatus(message)
    setEntryTypeChanged(true)
  }, [])

  const handleEntryTypeSave = useCallback(
    async (data: CreateEntryTypeInput | Partial<CreateEntryTypeInput>, isNew: boolean) => {
      if (isEditMode && editingCollection) {
        setEntryTypeSaving(true)
        setEntryTypeError(null)
        setEntryTypeStatus('')
        setRemoveError(null)
        try {
          // An absent callback leaves `result` undefined: nothing was saved, so nothing is
          // applied locally or announced.
          let result: SchemaOpResult | undefined
          if (isNew) {
            const entryType = data as CreateEntryTypeInput
            result = await onAddEntryType?.(editingCollection.logicalPath, entryType)
            if (result?.ok) {
              setEntryTypes((prev) => [...prev, { ...entryType, usageCount: 0 }])
              announceEntryTypeChange(`Entry type "${entryType.name}" added`)
            }
          } else if (editingEntryType) {
            const name = editingEntryType.name
            result = await onUpdateEntryType?.(editingCollection.logicalPath, name, data)
            if (result?.ok) {
              // The server skips undefined fields, so a cleared label or max items keeps its
              // stored value; the list shows what was stored.
              const stored = Object.fromEntries(
                Object.entries(data).filter(([, value]) => value !== undefined),
              )
              setEntryTypes((prev) =>
                prev.map((et) => (et.name === name ? { ...et, ...stored } : et)),
              )
              announceEntryTypeChange(`Entry type "${name}" updated`)
            }
          }
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
      announceEntryTypeChange,
    ],
  )

  const handleRemoveEntryType = useCallback(
    (entryType: ExistingEntryType | CreateEntryTypeInput, index: number) => {
      setDeletingEntryType({ entryType, index })
      setDeleteEntryTypeModalOpen(true)
    },
    [],
  )

  const closeRemoveConfirm = useCallback(() => {
    setDeleteEntryTypeModalOpen(false)
    setDeletingEntryType(null)
  }, [])

  const confirmRemoveEntryType = useCallback(async () => {
    if (!deletingEntryType) return

    const { entryType, index } = deletingEntryType

    if (isEditMode && editingCollection) {
      if (onRemoveEntryType) {
        setRemoving(true)
        setRemoveError(null)
        setEntryTypeStatus('')
        try {
          const result = await onRemoveEntryType(editingCollection.logicalPath, entryType.name)
          if (result.ok) {
            setEntryTypes((prev) => prev.filter((et) => et.name !== entryType.name))
            announceEntryTypeChange(`Entry type "${entryType.name}" removed`)
          } else {
            setRemoveError(result.error)
          }
        } catch (err) {
          setRemoveError(getErrorMessage(err))
        } finally {
          setRemoving(false)
        }
      }
    } else {
      setFormData((prev) => ({
        ...prev,
        entries: prev.entries.filter((_, i) => i !== index),
      }))
    }

    closeRemoveConfirm()
  }, [
    deletingEntryType,
    isEditMode,
    editingCollection,
    onRemoveEntryType,
    announceEntryTypeChange,
    closeRemoveConfirm,
  ])

  const removeMessage = (() => {
    if (!deletingEntryType) return ''
    const { name } = deletingEntryType.entryType
    if (!isEditMode) return `Remove "${name}" from this new collection?`
    const usageCount =
      'usageCount' in deletingEntryType.entryType
        ? (deletingEntryType.entryType.usageCount ?? 0)
        : 0
    return usageCount > 0
      ? `"${name}" is used by ${usageCount} ${usageCount === 1 ? 'entry' : 'entries'}. Removing it saves immediately and stops those entries from being edited.`
      : `Remove "${name}"? This saves immediately and cannot be undone.`
  })()

  const displayEntryTypes: (ExistingEntryType | CreateEntryTypeInput)[] = isEditMode
    ? entryTypes
    : formData.entries

  // The hook's single `isLoading` flag drives `isSaving`, so it is also true while an
  // entry-type action runs; the footer must not spin or close over that action's result.
  const entryTypeBusy = entryTypeSaving || removing

  const displayError = error || validationError

  const entryTypesSection = (
    <Stack gap="md">
      <Divider label="Entry types" labelPosition="left" />

      {isEditMode && (
        <Text size="sm" c="dimmed">
          Changes here save to the branch immediately.
        </Text>
      )}

      {displayEntryTypes.length === 0 ? (
        <Paper p="md" withBorder>
          <Text c="dimmed" ta="center" size="sm">
            No entry types yet. Add at least one to choose what kinds of entries this collection can
            hold.
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
                <Menu
                  position="bottom-end"
                  withinPortal
                  onChange={(opened) => setMenuOpenFor(opened ? entryType.name : null)}
                >
                  <Tooltip
                    label={`Actions for ${entryType.name}`}
                    disabled={menuOpenFor === entryType.name}
                  >
                    <Menu.Target>
                      <ActionIcon variant="subtle" aria-label={`Actions for ${entryType.name}`}>
                        <IconDotsVertical size={16} aria-hidden />
                      </ActionIcon>
                    </Menu.Target>
                  </Tooltip>
                  <Menu.Dropdown>
                    <Menu.Item
                      leftSection={<IconEdit size={14} />}
                      onClick={() => handleOpenEditEntryType(entryType as ExistingEntryType, index)}
                    >
                      Edit…
                    </Menu.Item>
                    <Menu.Divider />
                    <ReasonedMenuItem
                      leftSection={<IconTrash size={14} />}
                      color="red"
                      onClick={() => handleRemoveEntryType(entryType, index)}
                      blockedReason={
                        displayEntryTypes.length === 1
                          ? 'A collection needs at least one entry type. Add another before removing this one.'
                          : undefined
                      }
                    >
                      Remove
                    </ReasonedMenuItem>
                  </Menu.Dropdown>
                </Menu>
              </Group>
            </Paper>
          ))}
        </Stack>
      )}

      {isEditMode && (
        // Stays mounted while empty so screen readers announce each change.
        <Group gap={6} wrap="nowrap" role="status">
          {entryTypeStatus && (
            <>
              <IconCheck size={14} aria-hidden />
              <Text size="sm" c="green.8">
                {entryTypeStatus}
              </Text>
            </>
          )}
        </Group>
      )}

      {removeError && (
        <Alert
          icon={<IconAlertCircle size={16} />}
          color="red"
          title="Couldn't remove entry type"
          withCloseButton
          onClose={() => setRemoveError(null)}
        >
          {removeError}
        </Alert>
      )}

      <Button
        size="sm"
        variant="light"
        leftSection={<IconPlus size={16} />}
        onClick={handleOpenAddEntryType}
      >
        Add entry type…
      </Button>
    </Stack>
  )

  return (
    <>
      <Modal
        opened={isOpen}
        onClose={entryTypeBusy ? () => {} : onClose}
        title={isEditMode ? `Edit collection: ${editingCollection?.name}` : 'Create collection'}
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

          {isEditMode && (
            <div>
              <Text fw={500}>Collection details</Text>
              <Text size="sm" c="dimmed">
                Saved when you select &quot;Save collection details&quot;.
              </Text>
            </div>
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

          {isEditMode ? (
            <Paper withBorder p="md">
              {entryTypesSection}
            </Paper>
          ) : (
            entryTypesSection
          )}

          <Group justify="flex-end" gap="sm" mt="md" data-testid="collection-editor-footer">
            <Button
              size="sm"
              variant="subtle"
              onClick={onClose}
              disabled={isSaving || entryTypeBusy}
            >
              {entryTypeChanged ? 'Close' : 'Cancel'}
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              loading={isSaving && !entryTypeBusy}
              disabled={entryTypeBusy}
            >
              {isEditMode ? 'Save collection details' : 'Create collection'}
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
        title="Remove entry type"
        message={removeMessage}
        confirmLabel="Remove entry type"
        onConfirm={confirmRemoveEntryType}
        onClose={removing ? () => {} : closeRemoveConfirm}
        loading={removing}
      />
    </>
  )
}
