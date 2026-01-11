import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button, Group, Paper, Stack, Text } from '@mantine/core'

import type {
  FieldConfig,
  ObjectFieldConfig,
  ReferenceFieldConfig,
  SelectFieldConfig,
} from '../config'
import { MarkdownField } from './fields/MarkdownField'
import { TextField } from './fields/TextField'
import { ToggleField } from './fields/ToggleField'
import { BlockField, type BlockInstance } from './fields/BlockField'
import { SelectField } from './fields/SelectField'
import { ReferenceField } from './fields/ReferenceField'
import { CodeField } from './fields/CodeField'
import { ObjectField } from './fields/ObjectField'
import { formatCanopyPath, normalizeCanopyPath } from './canopy-path'
import { FieldWrapper } from './comments/FieldWrapper'
import { EntryComments } from './comments/EntryComments'
import type { CommentThread } from '../comment-store'
import { resolveChangedReferences } from './client-reference-resolver'

export type FormValue = Record<string, unknown>

export interface CustomFieldRenderProps {
  field: FieldConfig
  value: unknown
  onChange: (v: unknown) => void
  path: Array<string | number>
  id: string
}

export type CustomFieldRenderers = Record<string, (props: CustomFieldRenderProps) => React.ReactNode>

const normalizeOptions = (
  options: Array<string | { label: string; value: string }> | undefined
): Array<{ label: string; value: string }> => {
  if (!options) return []
  return options.map((opt) => (typeof opt === 'string' ? { label: opt, value: opt } : opt))
}

const fieldKey = (path: Array<string | number>): string => formatCanopyPath(path)

export interface FormRendererProps {
  fields: readonly FieldConfig[]
  value: FormValue
  onChange: (next: FormValue) => void
  customRenderers?: CustomFieldRenderers
  branch?: string  // Current branch for loading reference options
  // Comment integration
  comments?: CommentThread[]
  currentEntryId?: string
  currentUserId?: string
  canResolve?: boolean
  focusedFieldPath?: string
  highlightThreadId?: string
  onAddComment?: (text: string, type: 'field' | 'entry' | 'branch', entryId?: string, canopyPath?: string, threadId?: string) => Promise<void>
  onResolveThread?: (threadId: string) => Promise<void>
  // Reference resolution for live preview
  onResolvedValueChange?: (resolved: FormValue) => void
  onLoadingStateChange?: (loadingState: FormValue) => void
}

export const FormRenderer: React.FC<FormRendererProps> = ({
  fields,
  value,
  onChange,
  customRenderers,
  branch = 'main',
  comments = [],
  currentEntryId,
  currentUserId,
  canResolve = false,
  focusedFieldPath,
  highlightThreadId,
  onAddComment,
  onResolveThread,
  onResolvedValueChange,
  onLoadingStateChange,
}) => {
  /**
   * LIVE PREVIEW REFERENCE RESOLUTION
   *
   * Problem: The preview needs full referenced content (e.g., {name: "Alice", bio: "..."}),
   * but the form only stores IDs (e.g., "5NVkkrB1MJUvnLqEDqDkRN").
   *
   * Solution: Synchronous resolution with background caching
   *
   * 1. SYNCHRONOUS PHASE (useMemo):
   *    - Compute resolvedValue by applying cached data to form value
   *    - If reference ID is in cache, use full object; otherwise keep ID
   *    - Runs during render, so no async gaps or race conditions
   *    - Preview always gets complete, valid data
   *
   * 2. BACKGROUND PHASE (useEffect):
   *    - Find IDs not in cache
   *    - After 300ms debounce, fetch from API
   *    - Update cache with resolved data
   *    - Trigger useMemo re-run via resolutionTrigger
   *    - Preview updates again with full data
   *
   * This two-phase approach eliminates race conditions that occurred with async state,
   * where form data and resolved data could get out of sync during transitions
   * (e.g., "Discard All Drafts" was passing empty objects to preview).
   *
   * Cache structure: Map<string, any> with keys like "main:5NVkkrB1MJUvnLqEDqDkRN"
   * - Branch-scoped to prevent stale cross-branch data
   * - Cleared on branch change
   * - Persists across edits for instant re-renders
   */
  const resolvedCache = useRef<Map<string, any>>(new Map())
  const prevValueRef = useRef<FormValue>({}) // Track previous value for change detection
  const lastNotifiedValueRef = useRef<string>('') // Track last notified value to prevent infinite loops
  const [resolutionTrigger, setResolutionTrigger] = useState(0) // Trigger to force useMemo re-computation

  // Map field names to their types for fast lookup
  const referenceFieldNames = useMemo(() => {
    const names = new Set<string>()
    for (const field of fields) {
      if (field.type === 'reference') {
        names.add(field.name)
      }
    }
    return names
  }, [fields])

  /**
   * PHASE 1: SYNCHRONOUS RESOLUTION
   *
   * Compute resolved value by applying cached reference data to form value.
   * This runs synchronously during render (useMemo), so there are no async gaps.
   *
   * For each reference field:
   * - If ID is in cache: substitute full object
   * - If ID not in cache: keep the ID (loading state)
   *
   * Dependencies include resolutionTrigger, which is incremented when cache updates,
   * forcing this to re-run and pick up newly-resolved data.
   *
   * This guarantees the preview always receives complete, valid data—never empty objects
   * or partially-resolved state.
   */
  const resolvedValue = useMemo(() => {
    const result = { ...value }

    // Synchronously apply cached resolutions
    for (const fieldName of referenceFieldNames) {
      const fieldValue = value[fieldName]
      if (fieldValue) {
        if (Array.isArray(fieldValue)) {
          // List of references
          result[fieldName] = fieldValue.map(id => {
            if (typeof id === 'string') {
              const cached = resolvedCache.current.get(`${branch}:${id}`)
              // Return cached object, or null if not yet resolved
              return cached || null
            }
            return id
          })
        } else if (typeof fieldValue === 'string') {
          // Single reference
          const cached = resolvedCache.current.get(`${branch}:${fieldValue}`)
          // Return cached object, or null if not yet resolved
          result[fieldName] = cached || null
        }
      }
    }

    return result
  }, [value, fields, branch, resolutionTrigger, referenceFieldNames])

  /**
   * Compute loading state that mirrors the data structure.
   * For each reference field, track if it's currently loading (not in cache).
   */
  const loadingState = useMemo(() => {
    const result: FormValue = {}

    for (const fieldName of referenceFieldNames) {
      const fieldValue = value[fieldName]
      if (fieldValue) {
        if (Array.isArray(fieldValue)) {
          // List of references - return array of booleans
          result[fieldName] = fieldValue.map(id => {
            if (typeof id === 'string') {
              return !resolvedCache.current.has(`${branch}:${id}`)
            }
            return false
          })
        } else if (typeof fieldValue === 'string') {
          // Single reference - return boolean
          result[fieldName] = !resolvedCache.current.has(`${branch}:${fieldValue}`)
        } else {
          result[fieldName] = false
        }
      } else {
        result[fieldName] = false
      }
    }

    return result
  }, [value, fields, branch, resolutionTrigger, referenceFieldNames])

  /**
   * PHASE 2: BACKGROUND ASYNC RESOLUTION
   *
   * Find reference IDs that aren't in cache yet and fetch them from the API.
   *
   * Flow:
   * 1. Scan form value for reference IDs not in cache
   * 2. If none found, exit early (all IDs already resolved)
   * 3. Debounce 300ms to batch API calls (prevents excessive requests while typing/selecting)
   * 4. Fetch uncached IDs via resolveChangedReferences()
   * 5. Update cache with resolved objects
   * 6. Increment resolutionTrigger to force Phase 1 (useMemo) to re-run
   * 7. Phase 1 re-runs and picks up newly-cached data
   * 8. Parent component gets notified with updated resolvedValue
   * 9. Preview re-renders with full data
   *
   * This happens in the background and doesn't block rendering. The preview shows
   * IDs initially (loading state), then updates with full data once resolution completes.
   */
  useEffect(() => {
    // Find all uncached reference IDs
    const uncachedIds = new Set<string>()

    for (const fieldName of referenceFieldNames) {
      const fieldValue = value[fieldName]
      if (fieldValue) {
        const ids = Array.isArray(fieldValue) ? fieldValue : [fieldValue]
        for (const id of ids) {
          if (typeof id === 'string' && !resolvedCache.current.has(`${branch}:${id}`)) {
            uncachedIds.add(id)
          }
        }
      }
    }

    if (uncachedIds.size === 0) {
      prevValueRef.current = value
      return
    }

    // Debounce API calls to batch multiple rapid changes
    const timeout = setTimeout(async () => {
      try {
        // Resolve uncached IDs via API
        const updates = await resolveChangedReferences(
          prevValueRef.current,
          value,
          fields,
          branch,
          resolvedCache.current
        )

        // Update cache with resolved values
        for (const [fieldName, resolvedValue] of Object.entries(updates)) {
          if (Array.isArray(resolvedValue)) {
            resolvedValue.forEach((obj, idx) => {
              const fieldValue = value[fieldName]
              if (Array.isArray(fieldValue)) {
                const id = fieldValue[idx]
                if (typeof obj === 'object' && obj !== null && typeof id === 'string') {
                  resolvedCache.current.set(`${branch}:${id}`, obj)
                }
              }
            })
          } else if (typeof resolvedValue === 'object' && resolvedValue !== null) {
            const id = value[fieldName] as string
            if (typeof id === 'string') {
              resolvedCache.current.set(`${branch}:${id}`, resolvedValue)
            }
          }
        }

        // Trigger useMemo re-computation (Phase 1 will re-run with new cache data)
        setResolutionTrigger(prev => prev + 1)
        prevValueRef.current = value
      } catch (error) {
        console.error('Reference resolution failed:', error)
      }
    }, 300) // 300ms debounce

    return () => clearTimeout(timeout)
  }, [value, fields, branch, referenceFieldNames])

  // Clear cache when branch changes
  useEffect(() => {
    resolvedCache.current.clear()
    setResolutionTrigger(prev => prev + 1) // Trigger re-computation with empty cache
  }, [branch])

  // Notify parent of resolved value changes (with infinite loop prevention)
  useEffect(() => {
    const serialized = JSON.stringify(resolvedValue)
    if (serialized !== lastNotifiedValueRef.current) {
      lastNotifiedValueRef.current = serialized
      onResolvedValueChange?.(resolvedValue)
    }
  }, [resolvedValue, onResolvedValueChange])

  // Notify parent of loading state changes
  const lastNotifiedLoadingRef = useRef<string>('')
  useEffect(() => {
    const serialized = JSON.stringify(loadingState)
    if (serialized !== lastNotifiedLoadingRef.current) {
      lastNotifiedLoadingRef.current = serialized
      onLoadingStateChange?.(loadingState)
    }
  }, [loadingState, onLoadingStateChange])

  const renderField = useCallback(
    (field: FieldConfig, currentValue: unknown, update: (v: unknown) => void, path: Array<string | number>) => {
      const fieldId = `field-${fieldKey(path).replace(/[^a-zA-Z0-9_-]/g, '-')}`
      const canopyPath = normalizeCanopyPath(path)

      // Filter comments for this specific field
      const fieldThreads = currentEntryId && onAddComment
        ? comments.filter(
            (thread) =>
              thread.type === 'field' &&
              thread.entryId === currentEntryId &&
              thread.canopyPath === canopyPath
          )
        : []

      const custom = customRenderers?.[field.type]
      if (custom) {
        const renderedField = (
          <div key={fieldKey(path)}>
            {custom({
              field,
              value: currentValue,
              onChange: update,
              path,
              id: fieldId,
            })}
          </div>
        )

        // Wrap custom fields with FieldWrapper if comments enabled
        if (currentEntryId && currentUserId && onAddComment && onResolveThread) {
          return (
            <FieldWrapper
              key={fieldKey(path)}
              canopyPath={canopyPath}
              entryId={currentEntryId}
              threads={fieldThreads}
              autoFocus={focusedFieldPath === canopyPath}
              currentUserId={currentUserId}
              canResolve={canResolve}
              onAddComment={onAddComment}
              onResolveThread={onResolveThread}
              highlightThreadId={highlightThreadId}
            >
              {renderedField}
            </FieldWrapper>
          )
        }

        return renderedField
      }

      const label = field.label ?? field.name

      // Helper to wrap field with FieldWrapper if comments enabled
      const wrapWithComments = (renderedField: React.ReactNode) => {
        if (currentEntryId && currentUserId && onAddComment && onResolveThread) {
          return (
            <FieldWrapper
              canopyPath={canopyPath}
              entryId={currentEntryId}
              threads={fieldThreads}
              autoFocus={focusedFieldPath === canopyPath}
              currentUserId={currentUserId}
              canResolve={canResolve}
              onAddComment={onAddComment}
              onResolveThread={onResolveThread}
              highlightThreadId={highlightThreadId}
            >
              {renderedField}
            </FieldWrapper>
          )
        }
        return renderedField
      }

      switch (field.type) {
        case 'string':
          return wrapWithComments(
            <TextField
              key={fieldKey(path)}
              id={fieldId}
              label={label}
              value={(currentValue as string) ?? ''}
              onChange={update}
              dataCanopyField={normalizeCanopyPath(path)}
            />
          )
        case 'boolean':
          return wrapWithComments(
            <ToggleField
              key={fieldKey(path)}
              id={fieldId}
              label={label}
              value={Boolean(currentValue)}
              onChange={(v) => update(Boolean(v))}
              dataCanopyField={normalizeCanopyPath(path)}
            />
          )
        case 'markdown':
        case 'mdx':
          return wrapWithComments(
            <MarkdownField
              key={fieldKey(path)}
              id={fieldId}
              label={label}
              value={(currentValue as string) ?? ''}
              onChange={(v) => update(v)}
              dataCanopyField={normalizeCanopyPath(path)}
            />
          )
        case 'select': {
          const selectField = field as SelectFieldConfig
          const options = normalizeOptions(selectField.options)
          const isMulti = Boolean(selectField.list)
          return wrapWithComments(
            <SelectField
              key={fieldKey(path)}
              id={fieldId}
              label={label}
              options={options}
              value={
                isMulti
                  ? Array.isArray(currentValue)
                    ? (currentValue as string[])
                    : []
                  : (currentValue as string) ?? ''
              }
              multiple={isMulti}
              onChange={(next) => update(next)}
              dataCanopyField={normalizeCanopyPath(path)}
            />
          )
        }
        case 'reference': {
          const referenceField = field as ReferenceFieldConfig
          const staticOptions = referenceField.options ? normalizeOptions(referenceField.options) : undefined
          const isMulti = Boolean(referenceField.list)
          return wrapWithComments(
            <ReferenceField
              key={fieldKey(path)}
              id={fieldId}
              label={label}
              options={staticOptions?.map((opt) => ({
                label: opt.label,
                value: opt.value,
              }))}
              collections={referenceField.collections}
              displayField={referenceField.displayField}
              branch={branch}
              value={
                isMulti
                  ? Array.isArray(currentValue)
                    ? (currentValue as string[])
                    : []
                  : (currentValue as string) ?? ''
              }
              multiple={isMulti}
              onChange={(next) => update(next)}
              dataCanopyField={normalizeCanopyPath(path)}
            />
          )
        }
        case 'block':
          return wrapWithComments(
            <BlockField
              key={fieldKey(path)}
              label={label}
              templates={field.templates}
              value={(Array.isArray(currentValue) ? currentValue : []) as BlockInstance[]}
              onChange={(next) => update(next)}
              renderField={renderField}
              path={path}
              dataCanopyField={normalizeCanopyPath(path)}
            />
          )
        case 'object': {
          const objectField = field as ObjectFieldConfig
          if (objectField.list) {
            const items = Array.isArray(currentValue)
              ? (currentValue as Record<string, unknown>[])
              : []
            return (
              <Paper key={fieldKey(path)} withBorder radius="md" p="md" shadow="xs">
                <Stack gap="sm">
                  <Group justify="space-between">
                    <Text size="sm" fw={600}>
                      {label}
                    </Text>
                    <Button size="xs" variant="light" onClick={() => update([...items, {} as Record<string, unknown>])}>
                      Add item
                    </Button>
                  </Group>
                  <Stack gap="sm">
                    {items.map((item, idx) => (
                      <Paper key={fieldKey([...path, idx])} withBorder radius="md" p="sm" shadow="xs">
                        <Stack gap="xs">
                          <Group justify="space-between">
                            <Text size="xs" fw={700}>
                              {label} #{idx + 1}
                            </Text>
                            <Button
                              size="xs"
                              variant="subtle"
                              color="red"
                              onClick={() => update(items.filter((_, i) => i !== idx))}
                            >
                              Remove
                            </Button>
                          </Group>
                          <ObjectField
                            label={objectField.label}
                            fields={objectField.fields}
                            value={item}
                            onChange={(next) => {
                              const nextItems = [...items]
                              nextItems[idx] = next
                              update(nextItems)
                            }}
                            renderField={renderField}
                            path={[...path, idx]}
                            dataCanopyField={normalizeCanopyPath([...path, idx])}
                          />
                        </Stack>
                      </Paper>
                    ))}
                    {items.length === 0 && (
                      <Text size="xs" c="dimmed">
                        No items yet. Add one to get started.
                      </Text>
                    )}
                  </Stack>
                </Stack>
              </Paper>
            )
          }

          return (
            <ObjectField
              key={fieldKey(path)}
              label={label}
              fields={objectField.fields}
              value={currentValue as Record<string, unknown> | undefined}
              onChange={(next) => update(next)}
              renderField={renderField}
              path={path}
              dataCanopyField={normalizeCanopyPath(path)}
            />
          )
        }
        case 'code':
          return wrapWithComments(
            <CodeField
              key={fieldKey(path)}
              id={fieldId}
              label={label}
              value={typeof currentValue === 'string' ? currentValue : ''}
              onChange={(v) => update(v)}
              dataCanopyField={normalizeCanopyPath(path)}
            />
          )
        default:
          return (
            <Text key={fieldKey(path)} size="xs" c="dimmed">
              Unsupported field: {field.type}
            </Text>
          )
      }
    },
    [customRenderers, branch, comments, currentEntryId, currentUserId, canResolve, focusedFieldPath, highlightThreadId, onAddComment, onResolveThread]
  )

  return (
    <Stack gap="md" data-form-renderer>
      {/* Entry-level comments at top of form */}
      {currentEntryId && currentUserId && onAddComment && onResolveThread && (
        <EntryComments
          comments={comments}
          entryId={currentEntryId}
          currentUserId={currentUserId}
          canResolve={canResolve}
          onAddComment={onAddComment}
          onResolveThread={onResolveThread}
          highlightThreadId={highlightThreadId}
        />
      )}

      {fields.map((field) => {
        const val = value[field.name]
        const path = [field.name]
        return (
          <div key={fieldKey(path)}>
            {renderField(field, val, (next) => onChange({ ...value, [field.name]: next }), path)}
          </div>
        )
      })}
    </Stack>
  )
}

export default FormRenderer
