'use client'

import React from 'react'

import { Alert, Button, Group, Paper, Stack, Text } from '@mantine/core'
import { IconInfoCircle } from '@tabler/icons-react'

import type {
  BlockFieldConfig,
  EntrySchema,
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
import { useReferenceResolution } from './hooks/useReferenceResolution'

export type FormValue = Record<string, unknown>

export interface CustomFieldRenderProps {
  field: FieldConfig
  value: unknown
  onChange: (v: unknown) => void
  path: Array<string | number>
  id: string
}

export type CustomFieldRenderers = Record<
  string,
  (props: CustomFieldRenderProps) => React.ReactNode
>

const normalizeOptions = (
  options: Array<string | { label: string; value: string }> | undefined,
): Array<{ label: string; value: string }> => {
  if (!options) return []
  return options.map((opt) => (typeof opt === 'string' ? { label: opt, value: opt } : opt))
}

const fieldKey = (path: Array<string | number>): string => formatCanopyPath(path)

export interface FormRendererProps {
  fields: EntrySchema
  value: FormValue
  onChange: (next: FormValue) => void
  customRenderers?: CustomFieldRenderers
  branch?: string // Current branch for loading reference options
  // Comment integration
  comments?: CommentThread[]
  currentEntryPath?: string
  currentUserId?: string
  canResolve?: boolean
  focusedFieldPath?: string
  highlightThreadId?: string
  onAddComment?: (
    text: string,
    type: 'field' | 'entry' | 'branch',
    entryPath?: string,
    canopyPath?: string,
    threadId?: string,
  ) => Promise<void>
  onResolveThread?: (threadId: string) => Promise<void>
  // Reference resolution for live preview
  onResolvedValueChange?: (resolved: FormValue) => void
  onLoadingStateChange?: (loadingState: FormValue) => void
  /** True when this entry's content conflicts with a recent change on the base branch */
  conflictNotice?: boolean
}

export const FormRenderer: React.FC<FormRendererProps> = ({
  fields,
  value,
  onChange,
  customRenderers,
  branch = 'main',
  comments = [],
  currentEntryPath,
  currentUserId,
  canResolve = false,
  focusedFieldPath,
  highlightThreadId,
  onAddComment,
  onResolveThread,
  onResolvedValueChange,
  onLoadingStateChange,
  conflictNotice = false,
}) => {
  // Use the extracted reference resolution hook for live preview
  useReferenceResolution({
    value,
    fields,
    branch,
    onResolvedValueChange,
    onLoadingStateChange,
  })

  const renderField = (
    field: FieldConfig,
    currentValue: unknown,
    update: (v: unknown) => void,
    path: Array<string | number>,
  ) => {
    const fieldId = `field-${fieldKey(path).replace(/[^a-zA-Z0-9_-]/g, '-')}`
    const canopyPath = normalizeCanopyPath(path)

    // Filter comments for this specific field
    const fieldThreads =
      currentEntryPath && onAddComment
        ? comments.filter(
            (thread) =>
              thread.type === 'field' &&
              thread.entryPath === currentEntryPath &&
              thread.canopyPath === canopyPath,
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
      if (currentEntryPath && currentUserId && onAddComment && onResolveThread) {
        return (
          <FieldWrapper
            key={fieldKey(path)}
            canopyPath={canopyPath}
            entryPath={currentEntryPath}
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
      if (currentEntryPath && currentUserId && onAddComment && onResolveThread) {
        return (
          <FieldWrapper
            canopyPath={canopyPath}
            entryPath={currentEntryPath}
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
          />,
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
            testId={`field-toggle-${field.name}`}
          />,
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
          />,
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
                : ((currentValue as string) ?? '')
            }
            multiple={isMulti}
            onChange={(next) => update(next)}
            dataCanopyField={normalizeCanopyPath(path)}
          />,
        )
      }
      case 'reference': {
        const referenceField = field as ReferenceFieldConfig
        const staticOptions = referenceField.options
          ? normalizeOptions(referenceField.options)
          : undefined
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
            entryTypes={referenceField.entryTypes}
            displayField={referenceField.displayField}
            branch={branch}
            value={
              isMulti
                ? Array.isArray(currentValue)
                  ? (currentValue as string[])
                  : []
                : ((currentValue as string) ?? '')
            }
            multiple={isMulti}
            onChange={(next) => update(next)}
            dataCanopyField={normalizeCanopyPath(path)}
          />,
        )
      }
      case 'block': {
        const blockField = field as BlockFieldConfig
        return wrapWithComments(
          <BlockField
            key={fieldKey(path)}
            label={label}
            templates={blockField.templates}
            value={(Array.isArray(currentValue) ? currentValue : []) as BlockInstance[]}
            onChange={(next) => update(next)}
            renderField={renderField}
            path={path}
            dataCanopyField={normalizeCanopyPath(path)}
          />,
        )
      }
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
                  <Button
                    size="xs"
                    variant="light"
                    onClick={() => update([...items, {} as Record<string, unknown>])}
                  >
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
          />,
        )
      default:
        return (
          <Text key={fieldKey(path)} size="xs" c="dimmed">
            Unsupported field: {field.type}
          </Text>
        )
    }
  }

  return (
    <Stack gap="md" data-form-renderer>
      {/* Entry-level comments at top of form */}
      {currentEntryPath && currentUserId && onAddComment && onResolveThread && (
        <EntryComments
          comments={comments}
          entryPath={currentEntryPath}
          currentUserId={currentUserId}
          canResolve={canResolve}
          onAddComment={onAddComment}
          onResolveThread={onResolveThread}
          highlightThreadId={highlightThreadId}
        />
      )}

      {conflictNotice && (
        <Alert
          icon={<IconInfoCircle size={16} />}
          color="orange"
          variant="light"
          title="Page updated since your draft started"
          data-testid="conflict-alert"
        >
          Someone else has recently changed this page. You can keep editing — a reviewer will
          reconcile your changes when you submit.
        </Alert>
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
