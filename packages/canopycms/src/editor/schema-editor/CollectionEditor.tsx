'use client'

/**
 * CollectionEditor - Modal for creating/editing collections.
 *
 * A collection has a name (machine-readable id), label (display name), and
 * entries (entry types defining what content can be created). Create mode
 * stages everything locally and sends it with "Create collection"; Cancel
 * discards it. Edit mode stages name, label and slug until "Save collection
 * details", but every entry-type add, update and remove saves to the branch
 * at once. The footer's dismiss button says what leaving does: "Discard
 * changes" while details are staged, "Close" once an entry-type change has
 * saved or may have, else "Cancel" (which would promise a revert it cannot do
 * after one).
 */

import { useState, useCallback, useEffect, useRef } from 'react'
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
  Title,
  Badge,
  Tooltip,
} from '@mantine/core'
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconRestore,
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
import { slugOf } from './collection-draft'

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
  /**
   * Re-reads the entry types from the branch (edit mode only), after an action the server never
   * answered; resolves to null when the read fails.
   */
  onReloadEntryTypes?: (collectionPath: LogicalPath) => Promise<ExistingEntryType[] | null>
  onClose: () => void
  isSaving?: boolean
  error?: string | null
  /**
   * What was entered for a create or details save that got no answer and that the opener's fresh
   * read did not show landed, filled in when the dialog opens (docs/ux-guidelines.md: a create closed after no answer
   * prefills its dialog's next open).
   */
  restored?: RestoredCollectionInput | null
  /** Drops `restored`, once the user discards it. */
  onDiscardRestored?: () => void
}

/** A create's input, or a details save's changed fields. */
export type RestoredCollectionInput = Partial<CollectionFormData> & { slug?: string }

/** Whether a listed entry type holds every field an add or update sent. */
function showsFields(entryType: ExistingEntryType, fields: Partial<CreateEntryTypeInput>): boolean {
  return Object.entries(fields).every(([key, value]) =>
    key === 'default'
      ? !!entryType.default === !!value
      : entryType[key as keyof CreateEntryTypeInput] === value,
  )
}

function usageOf(entryType: ExistingEntryType | CreateEntryTypeInput): number {
  return 'usageCount' in entryType ? (entryType.usageCount ?? 0) : 0
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
  onReloadEntryTypes,
  onClose,
  isSaving = false,
  error = null,
  restored = null,
  onDiscardRestored,
}: CollectionEditorProps) {
  const isEditMode = editingCollection !== null
  // Read when the dialog opens only: dropping it later must not reset what the user has typed.
  const restoredRef = useRef(restored)
  restoredRef.current = restored
  const [showingRestored, setShowingRestored] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  // Staged removals, latest last; Undo stays in the dialog, as a toast's is outside the focus trap.
  const [stagedRemovals, setStagedRemovals] = useState<
    { entryType: CreateEntryTypeInput; index: number }[]
  >([])
  const stagedRemoval = stagedRemovals.at(-1)

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
  const [errorDismissed, setErrorDismissed] = useState(false)

  // Edit mode renders this list rather than `editingCollection.entries`, a snapshot taken when
  // the dialog opened that the parent never refreshes. Each immediate action patches it.
  const [entryTypes, setEntryTypes] = useState<ExistingEntryType[]>(
    () => editingCollection?.entries ?? [],
  )
  // True once an immediate entry-type change has saved, or may have, in this opening of the dialog.
  const [entryTypeChanged, setEntryTypeChanged] = useState(false)
  const [entryTypeStatus, setEntryTypeStatus] = useState('')
  // An unanswered remove the re-read did not settle, shown above the list.
  const [entryTypeUnanswered, setEntryTypeUnanswered] = useState<string | null>(null)
  // An unanswered add or update the re-read did not settle, shown in the entry type dialog,
  // which stays open with the user's input.
  const [entryTypeWarning, setEntryTypeWarning] = useState<string | null>(null)
  const [removeFailure, setRemoveFailure] = useState<{ name: string; message: string } | null>(null)
  const [removing, setRemoving] = useState(false)
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null)

  // Closing an overlay returns focus to its opener, but a row's menu item is gone once it acts,
  // so Mantine's own return lands nowhere. `row` names the trigger to focus; null is the heading.
  const [focusRequest, setFocusRequest] = useState<{ row: string | null } | null>(null)
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>())
  const entryTypesHeadingRef = useRef<HTMLHeadingElement>(null)

  const [deleteEntryTypeModalOpen, setDeleteEntryTypeModalOpen] = useState(false)
  const [deletingEntryType, setDeletingEntryType] = useState<{
    entryType: ExistingEntryType | CreateEntryTypeInput
  } | null>(null)

  useEffect(() => {
    if (isOpen) {
      const prefill = restoredRef.current
      if (editingCollection) {
        setFormData({
          name: prefill?.name ?? editingCollection.name,
          label: prefill?.label ?? (editingCollection.label || ''),
          entries: [], // Edit mode keeps its entry types in `entryTypes`
        })
        setEntryTypes(editingCollection.entries)
        setSlug(prefill?.slug ?? slugOf(editingCollection.logicalPath))
      } else {
        setFormData({
          name: prefill?.name ?? '',
          label: prefill?.label ?? '',
          entries: prefill?.entries ?? [],
        })
        setSlug('')
        setEntryTypes([])
      }
      setShowingRestored(!!prefill)
      setStagedRemovals([])
      setValidationError(null)
      setEntryTypeChanged(false)
      setEntryTypeStatus('')
      setEntryTypeUnanswered(null)
      setRemoveFailure(null)
    } else {
      // The parent closes this dialog (and nulls `editingCollection`) when details save, so a
      // sub-dialog left open would stage into a closed dialog in create mode.
      setEntryTypeEditorOpen(false)
      setEditingEntryType(null)
      setEditingEntryTypeIndex(null)
      setEntryTypeError(null)
      setDeleteEntryTypeModalOpen(false)
    }
  }, [isOpen, editingCollection])

  useEffect(() => {
    setErrorDismissed(false)
  }, [error, isOpen, editingCollection])

  useEffect(() => {
    if (!focusRequest) return
    // Runs after the overlay's own focus return, which Mantine's useFocusReturn delays by 10ms.
    const timer = window.setTimeout(() => {
      const target =
        focusRequest.row === null
          ? entryTypesHeadingRef.current
          : triggerRefs.current.get(focusRequest.row)
      target?.focus()
      setFocusRequest(null)
    }, 50)
    return () => window.clearTimeout(timer)
  }, [focusRequest])

  const discardRestored = useCallback(() => {
    setFormData({
      name: editingCollection?.name ?? '',
      label: editingCollection?.label ?? '',
      entries: [],
    })
    setSlug(editingCollection ? slugOf(editingCollection.logicalPath) : '')
    setShowingRestored(false)
    setStagedRemovals([])
    onDiscardRestored?.()
    nameInputRef.current?.focus()
  }, [editingCollection, onDiscardRestored])

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
      const currentSlug = editingCollection ? slugOf(editingCollection.logicalPath) : ''
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

  /**
   * After an entry-type action the server never answered, which may have landed: re-reads the
   * list from the branch and shows it, and counts the action as a possible change (the footer
   * reads "Close"). Resolves to the re-read list, or null when it could not be read.
   */
  const reloadEntryTypes = useCallback(
    async (collectionPath: LogicalPath): Promise<ExistingEntryType[] | null> => {
      setEntryTypeChanged(true)
      const reloaded = await (onReloadEntryTypes?.(collectionPath) ?? Promise.resolve(null)).catch(
        (err: unknown) => {
          console.error(err)
          return null
        },
      )
      if (reloaded) setEntryTypes(reloaded)
      return reloaded
    },
    [onReloadEntryTypes],
  )

  const closeEntryTypeEditor = useCallback(() => {
    setEntryTypeEditorOpen(false)
    setEditingEntryType(null)
    setEditingEntryTypeIndex(null)
    setEntryTypeError(null)
    setEntryTypeWarning(null)
  }, [])

  // Esc, the close button and a click outside all land here; closing mid-request would hide
  // the request's result.
  const dismissEntryTypeEditor = useCallback(() => {
    if (entryTypeSaving) return
    const editedName = editingEntryType?.name
    closeEntryTypeEditor()
    if (editedName) setFocusRequest({ row: editedName })
  }, [entryTypeSaving, editingEntryType, closeEntryTypeEditor])

  const handleEntryTypeSave = useCallback(
    async (data: CreateEntryTypeInput | Partial<CreateEntryTypeInput>, isNew: boolean) => {
      const editedName = isNew ? undefined : editingEntryType?.name
      const finish = () => {
        closeEntryTypeEditor()
        if (editedName) setFocusRequest({ row: editedName })
      }

      if (isEditMode && editingCollection) {
        // The server skips undefined fields, so a cleared label or max items keeps its stored
        // value: the list shows what was stored, and an update with none saves nothing.
        const stored: Partial<CreateEntryTypeInput> = Object.fromEntries(
          Object.entries(data).filter(([, value]) => value !== undefined),
        )
        if (!isNew && Object.keys(stored).length === 0) {
          finish()
          return
        }

        setEntryTypeSaving(true)
        setEntryTypeError(null)
        setEntryTypeWarning(null)
        setEntryTypeStatus('')
        setEntryTypeUnanswered(null)
        setRemoveFailure(null)
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
              setEntryTypes((prev) =>
                prev.map((et) => (et.name === name ? { ...et, ...stored } : et)),
              )
              announceEntryTypeChange(`Entry type "${name}" updated`)
            }
          }
          if (result && !result.ok && result.unanswered) {
            // The re-read settles it when the branch already shows the change. Otherwise this
            // dialog keeps the input: re-sending an update sends the same change, and re-sending
            // an add that had landed is refused because the name exists (`schema-store.ts`).
            const name = isNew ? (data as CreateEntryTypeInput).name : editingEntryType?.name
            const reloaded = await reloadEntryTypes(editingCollection.logicalPath)
            const now = reloaded?.find((et) => et.name === name)
            if (name && now && showsFields(now, stored)) {
              announceEntryTypeChange(`Entry type "${name}" ${isNew ? 'added' : 'updated'}`)
              closeEntryTypeEditor()
              setFocusRequest({ row: name })
              return
            }
            setEntryTypeWarning(
              isNew
                ? `"${name}" may not have been added. Select "Add entry type" to try again: if it was added, you'll be told it already exists.`
                : 'The change may not have been saved. Select "Save entry type" to send it again.',
            )
            return
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
      finish()
    },
    [
      isEditMode,
      editingCollection,
      editingEntryType,
      editingEntryTypeIndex,
      onAddEntryType,
      onUpdateEntryType,
      announceEntryTypeChange,
      reloadEntryTypes,
      closeEntryTypeEditor,
    ],
  )

  const displayEntryTypes: (ExistingEntryType | CreateEntryTypeInput)[] = isEditMode
    ? entryTypes
    : formData.entries

  // Create mode stages entry types, so a removal goes at once with an Undo; edit mode's saves at
  // once with no restore, so it confirms (docs/ux-guidelines.md, Destructive actions).
  const removeStagedEntryType = useCallback(
    (entryType: CreateEntryTypeInput, index: number) => {
      const names = formData.entries.map((et) => et.name)
      const neighbour = names[index + 1] ?? names[index - 1] ?? null
      setFormData((prev) => ({ ...prev, entries: prev.entries.filter((_, i) => i !== index) }))
      setStagedRemovals((prev) => [...prev, { entryType, index }])
      setFocusRequest({ row: neighbour })
    },
    [formData.entries],
  )

  const undoStagedRemoval = useCallback(() => {
    if (!stagedRemoval) return
    const { entryType, index } = stagedRemoval
    // Into the list as it is now, unless an entry type of that name was added since.
    setFormData((prev) =>
      prev.entries.some((et) => et.name === entryType.name)
        ? prev
        : {
            ...prev,
            entries: [...prev.entries.slice(0, index), entryType, ...prev.entries.slice(index)],
          },
    )
    setStagedRemovals((prev) => prev.slice(0, -1))
    setFocusRequest({ row: entryType.name })
  }, [stagedRemoval])

  const handleRemoveEntryType = useCallback(
    (entryType: ExistingEntryType | CreateEntryTypeInput, index: number) => {
      if (!isEditMode) {
        removeStagedEntryType(entryType as CreateEntryTypeInput, index)
        return
      }
      setDeletingEntryType({ entryType })
      setDeleteEntryTypeModalOpen(true)
    },
    [isEditMode, removeStagedEntryType],
  )

  // Only closes: the target is replaced on the next open, so the message stays put while the
  // dialog fades out.
  const closeRemoveConfirm = useCallback(() => {
    setDeleteEntryTypeModalOpen(false)
  }, [])

  const cancelRemoveConfirm = useCallback(() => {
    closeRemoveConfirm()
    if (deletingEntryType) setFocusRequest({ row: deletingEntryType.entryType.name })
  }, [closeRemoveConfirm, deletingEntryType])

  const removeEntryType = useCallback(
    async (name: string) => {
      const names = displayEntryTypes.map((et) => et.name)
      // Focus moves to the row that takes the removed one's place, else the one before it, else
      // the heading.
      const neighbour = names[names.indexOf(name) + 1] ?? names[names.indexOf(name) - 1] ?? null

      if (editingCollection) {
        if (!onRemoveEntryType) return
        setRemoving(true)
        setEntryTypeStatus('')
        setEntryTypeUnanswered(null)
        try {
          const result = await onRemoveEntryType(editingCollection.logicalPath, name)
          if (result.ok) {
            setEntryTypes((prev) => prev.filter((et) => et.name !== name))
            setRemoveFailure(null)
            announceEntryTypeChange(`Entry type "${name}" removed`)
            setFocusRequest({ row: neighbour })
          } else if (result.unanswered) {
            setRemoveFailure(null)
            // The re-read settles it when the entry type is gone.
            const reloaded = await reloadEntryTypes(editingCollection.logicalPath)
            const listed = reloaded?.map((et) => et.name)
            if (listed && !listed.includes(name)) {
              announceEntryTypeChange(`Entry type "${name}" removed`)
              setFocusRequest({ row: neighbour && listed.includes(neighbour) ? neighbour : null })
            } else {
              setEntryTypeUnanswered(
                listed
                  ? `"${name}" is still listed, so it may not have been removed yet. Remove it again to retry, or close and reopen this collection later to check.`
                  : `"${name}" may already have been removed. Close and reopen this collection to check before trying again.`,
              )
              setFocusRequest({ row: name })
            }
          } else {
            setRemoveFailure({ name, message: result.error })
            setFocusRequest({ row: name })
          }
        } catch (err) {
          setRemoveFailure({ name, message: getErrorMessage(err) })
          setFocusRequest({ row: name })
        } finally {
          setRemoving(false)
        }
      }
    },
    [
      displayEntryTypes,
      editingCollection,
      onRemoveEntryType,
      announceEntryTypeChange,
      reloadEntryTypes,
    ],
  )

  const confirmRemoveEntryType = useCallback(async () => {
    if (!deletingEntryType) return
    await removeEntryType(deletingEntryType.entryType.name)
    closeRemoveConfirm()
  }, [deletingEntryType, removeEntryType, closeRemoveConfirm])

  const removeMessage = deletingEntryType
    ? `Remove "${deletingEntryType.entryType.name}"? This saves immediately and cannot be undone.`
    : ''

  const removeBlockedReason = (entryType: ExistingEntryType | CreateEntryTypeInput) => {
    if (displayEntryTypes.length === 1) {
      return 'A collection needs at least one entry type. Add another before removing this one.'
    }
    // The server refuses to remove an entry type that entries use. Staged ones have no entries.
    const used = isEditMode ? usageOf(entryType) : 0
    return used > 0
      ? `${used} ${used === 1 ? 'entry uses' : 'entries use'} this entry type. Move or delete ${used === 1 ? 'it' : 'them'} first.`
      : undefined
  }

  // The hook's single `isLoading` flag drives `isSaving`, so it is also true while an
  // entry-type action runs; the footer must not spin or close over that action's result.
  const entryTypeBusy = entryTypeSaving || removing

  // Any request in flight, a details save included: the parent closes this dialog when a details
  // save succeeds, so an entry-type action started meanwhile would report into a closed dialog.
  const requestBusy = isSaving || entryTypeBusy

  // Mantine's Escape handler fires on every open Modal, so one Esc would close a sub-dialog and
  // this dialog together, losing staged details. A request in flight must not be hidden either.
  const dismissBlocked = requestBusy || entryTypeEditorOpen || deleteEntryTypeModalOpen

  const propErrorVisible = !!error && !errorDismissed
  const displayError = propErrorVisible ? error : validationError
  const errorTitle = propErrorVisible
    ? isEditMode
      ? "Couldn't save collection details"
      : "Couldn't create collection"
    : undefined

  // The comparisons handleSave uses to build its update, so "Discard changes" shows exactly when
  // that update would carry a change.
  const detailsDirty =
    editingCollection !== null &&
    (formData.name !== editingCollection.name ||
      formData.label !== (editingCollection.label || '') ||
      (!!slug && slug !== slugOf(editingCollection.logicalPath)))
  const createStaged =
    !isEditMode && (!!formData.name || !!formData.label || formData.entries.length > 0)
  const dismissLabel = detailsDirty
    ? 'Discard changes'
    : isEditMode && entryTypeChanged
      ? 'Close'
      : 'Cancel'

  const entryTypesSection = (
    <Stack gap="md">
      <div>
        <Title order={3} size="h5" tabIndex={-1} ref={entryTypesHeadingRef}>
          Entry types
        </Title>
        {isEditMode && (
          <Text size="sm" c="dimmed">
            Changes here save to the branch immediately.
          </Text>
        )}
      </div>

      {entryTypeUnanswered && (
        <Alert
          icon={<IconAlertTriangle size={16} />}
          color="yellow"
          title="No answer from the server"
          withCloseButton
          onClose={() => {
            setEntryTypeUnanswered(null)
            setFocusRequest({ row: null })
          }}
        >
          {entryTypeUnanswered}
        </Alert>
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
                      <ActionIcon
                        variant="subtle"
                        aria-label={`Actions for ${entryType.name}`}
                        disabled={requestBusy}
                        ref={(el) => {
                          if (el) triggerRefs.current.set(entryType.name, el)
                          else triggerRefs.current.delete(entryType.name)
                        }}
                      >
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
                      blockedReason={removeBlockedReason(entryType)}
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

      {/* Stays mounted while empty so screen readers announce each change, and holds one line
          of text so the message appearing shifts nothing. Only the icon is green: green text
          misses 4.5:1, while a non-text graphic needs just 3:1. */}
      <Group
        gap={6}
        wrap="nowrap"
        role="status"
        mih="calc(var(--mantine-font-size-sm) * var(--mantine-line-height-sm))"
      >
        {isEditMode && entryTypeStatus && (
          <>
            <IconCheck size={14} color="var(--mantine-color-green-8)" aria-hidden />
            <Text size="sm">{entryTypeStatus}</Text>
          </>
        )}
        {!isEditMode && stagedRemoval && (
          <>
            <Text size="sm">{`Removed entry type "${stagedRemoval.entryType.name}".`}</Text>
            <Button
              size="compact-sm"
              variant="subtle"
              onClick={undoStagedRemoval}
              aria-label={`Undo removing entry type "${stagedRemoval.entryType.name}"`}
            >
              Undo
            </Button>
          </>
        )}
      </Group>

      {removeFailure && (
        <Alert
          icon={<IconAlertCircle size={16} />}
          color="red"
          title="Couldn't remove entry type"
          withCloseButton
          onClose={() => {
            setRemoveFailure(null)
            setFocusRequest({ row: null })
          }}
        >
          <Stack gap="xs" align="flex-start">
            <Text size="sm">{removeFailure.message}</Text>
            <Button
              size="xs"
              variant="light"
              color="red"
              loading={removing}
              disabled={requestBusy}
              onClick={() => void removeEntryType(removeFailure.name)}
            >
              Retry
            </Button>
          </Stack>
        </Alert>
      )}

      <Button
        size="sm"
        variant="light"
        leftSection={<IconPlus size={16} />}
        onClick={handleOpenAddEntryType}
        disabled={requestBusy}
      >
        Add entry type…
      </Button>
    </Stack>
  )

  return (
    <>
      <Modal
        opened={isOpen}
        onClose={dismissBlocked ? () => {} : onClose}
        closeOnClickOutside={!detailsDirty && !createStaged}
        title={
          isEditMode
            ? `Edit collection: ${editingCollection?.label || editingCollection?.name}`
            : 'Create collection'
        }
        size="lg"
      >
        <Stack gap="md">
          {showingRestored && restored && (
            <Alert
              icon={<IconRestore size={16} />}
              color="blue"
              title="Restored what you entered"
              // Blue on its own tint misses 4.5:1 for the title text.
              styles={{ title: { color: 'var(--mantine-color-text)' } }}
            >
              <Stack gap="xs" align="flex-start">
                <Text size="sm">
                  {isEditMode
                    ? "The server didn't answer your last save, and this collection doesn't show it, so your changes are filled in again."
                    : "The server didn't answer your last create, and the collection isn't in the content tree, so what you entered is filled in again."}
                </Text>
                <Button size="xs" variant="light" onClick={discardRestored}>
                  Discard changes
                </Button>
              </Stack>
            </Alert>
          )}
          {displayError && (
            <Alert
              icon={<IconAlertCircle size={16} />}
              color="red"
              title={errorTitle}
              withCloseButton
              onClose={() =>
                propErrorVisible ? setErrorDismissed(true) : setValidationError(null)
              }
            >
              {displayError}
            </Alert>
          )}

          {isEditMode && (
            <div>
              <Title order={3} size="h5">
                Collection details
              </Title>
              <Text size="sm" c="dimmed">
                Saved when you select &quot;Save collection details&quot;.
              </Text>
            </div>
          )}

          {/* Name is metadata in .collection.json, independent of the directory slug */}
          <TextInput
            ref={nameInputRef}
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
              onClick={() => {
                // "Discard changes" over refilled input discards the kept input too.
                if (detailsDirty && showingRestored && restored) onDiscardRestored?.()
                onClose()
              }}
              disabled={isSaving || entryTypeBusy}
            >
              {dismissLabel}
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
        staged={!isEditMode}
        onSave={handleEntryTypeSave}
        onClose={dismissEntryTypeEditor}
        isSaving={entryTypeSaving}
        error={entryTypeError}
        warning={entryTypeWarning}
      />

      <ConfirmDeleteModal
        isOpen={deleteEntryTypeModalOpen}
        title="Remove entry type"
        message={removeMessage}
        confirmLabel="Remove entry type"
        onConfirm={confirmRemoveEntryType}
        onClose={removing ? () => {} : cancelRemoveConfirm}
        loading={removing}
      />
    </>
  )
}
