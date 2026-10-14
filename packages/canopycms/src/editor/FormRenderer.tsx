'use client'

import React, { useEffect, useRef, useState } from 'react'

import { Alert, Stack, Text } from '@mantine/core'
import { IconInfoCircle } from '@tabler/icons-react'

import type {
  BlockFieldConfig,
  ContentFormat,
  EntrySchema,
  FieldConfig,
  ImageFieldConfig,
  ImageFieldValue,
  InlineGroupFieldConfig,
  MarkdownFieldConfig,
  ObjectFieldConfig,
  ReferenceFieldConfig,
  SelectFieldConfig,
} from '../config'
import { MarkdownField } from './fields/MarkdownField'
import { useSiteMdxAllow } from './context'
import { markdownPolicyOf } from '../validation/mdx-allowlist'
import { findBodyFieldName } from '../utils/body-field'
import { StringListField } from './fields/StringListField'
import { TextField } from './fields/TextField'
import { ToggleField } from './fields/ToggleField'
import { NumberField } from './fields/NumberField'
import { NumberListField } from './fields/NumberListField'
import { DateTimeField } from './fields/DateTimeField'
import { BlockField, type BlockInstance } from './fields/BlockField'
import { SelectField } from './fields/SelectField'
import { ReferenceField } from './fields/ReferenceField'
import { CodeField } from './fields/CodeField'
import { ImageField } from './fields/ImageField'
import { ObjectField } from './fields/ObjectField'
import { ObjectListField } from './fields/ObjectListField'
import { listItemTitle } from './fields/list-item-title'
import { InlineGroupField } from './fields/InlineGroupField'
import { formatCanopyPath, normalizeCanopyPath } from './canopy-path'
import { FieldWrapper } from './comments/FieldWrapper'
import { FormCommentsContext, createFormComments } from './comments/form-comments'
import { EntryComments } from './comments/EntryComments'
import type { CommentThread } from '../comment-store'
import type { UserSearchResult } from '../auth/types'
import { EditorErrorBoundary, type CaughtEditorError } from './components/EditorErrorBoundary'
import { ValidationSummary } from './components/ValidationSummary'
import { fieldBreadcrumb } from './field-breadcrumb'
import { FieldCrashFallback } from './fields/FieldCrashFallback'
import { useListItemKeys } from './fields/list-item-keys'
import { FormExpansionContext, type FormExpansionCommand } from './fields/form-expansion'
import { FormHeader } from './FormHeader'
import { buildFormOutline, hasCollapsibleList } from './form-outline'
import { findFieldTarget, focusFieldTarget } from './field-target'
import type { FieldRemoval } from './undo-removal'

export type FormValue = Record<string, unknown>

export interface CustomFieldRenderProps {
  field: FieldConfig
  value: unknown
  onChange: (v: unknown) => void
  path: Array<string | number>
  id: string
  /** The branch is locked (protected, or in review): show the value; `onChange` is ignored. */
  readOnly: boolean
}

export type CustomFieldRenderers = Record<
  string,
  (props: CustomFieldRenderProps) => React.ReactNode
>

/**
 * How an Undo toast names a removed object-list item: by its title field or first non-empty
 * text field, since a positional "#2" title passes to the next item once this one is gone.
 */
const removedItemLabel = (
  item: Record<string, unknown>,
  objectField: ObjectFieldConfig,
  listLabel: string,
  index: number,
): string => {
  const text = listItemTitle(item, objectField)
  const byPosition = `${objectField.itemLabel ?? 'item'} ${index + 1}`
  return text ? `"${text}" from ${listLabel}` : `${byPosition} from ${listLabel}`
}

const normalizeOptions = (
  options: Array<string | { label: string; value: string }> | undefined,
): Array<{ label: string; value: string }> => {
  if (!options) return []
  return options.map((opt) => (typeof opt === 'string' ? { label: opt, value: opt } : opt))
}

const fieldKey = (path: Array<string | number>): string => formatCanopyPath(path)

const noop = (): void => {}

const FENCE_STYLE: React.CSSProperties = { border: 0, padding: 0, margin: 0, minWidth: 0 }
const READ_ONLY_FORM_CLASS = 'canopy-read-only-form'

/**
 * Read-only inputs look disabled but stay focusable, so a reviewer can select and copy them. A
 * picker's trigger is a button, which Mantine marks `data-read-only` instead.
 */
const ReadOnlyFormStyles: React.FC = () => (
  <style>{`
    .${READ_ONLY_FORM_CLASS} .mantine-Input-input:is([readonly], [data-read-only], :has(input[readonly])) {
      background-color: var(--input-disabled-bg);
    }
    .${READ_ONLY_FORM_CLASS} .canopy-mdx-content {
      background-color: var(--canopy-surface-muted);
    }
    .${READ_ONLY_FORM_CLASS} .mantine-Switch-label {
      color: var(--mantine-color-text);
    }
  `}</style>
)

/**
 * Disables a custom renderer's native controls on a read-only form, whether or not it honours
 * `readOnly`. It wraps the control, never its `FieldWrapper`, so review comments stay open.
 */
const ReadOnlyFence: React.FC<{ readOnly: boolean; children: React.ReactNode }> = ({
  readOnly,
  children,
}) => (
  <fieldset disabled={readOnly} role="presentation" style={FENCE_STYLE}>
    {children}
  </fieldset>
)

/** Builds the control inside the field's boundary: a custom renderer is called, not mounted. */
const FieldControl: React.FC<{ build: () => React.ReactNode }> = ({ build }) => <>{build()}</>

/**
 * One field's error boundary. Every edit callback a field was rendered with before it crashed
 * is dead for good, so nothing it scheduled can land later, even on another entry's draft.
 * Callbacks from renders after the crash, which happen once the boundary resets on an entry or
 * branch change, work.
 */
const FieldBoundary: React.FC<{
  canopyPath: string
  resetKey: string
  update: (v: unknown) => void
  build: (update: (v: unknown) => void) => React.ReactNode
  fallback: (caught: CaughtEditorError) => React.ReactNode
}> = ({ canopyPath, resetKey, update, build, fallback }) => {
  const [generation, setGeneration] = useState(0)
  const liveGeneration = useRef(0)
  const guardedUpdate = (next: unknown) => {
    if (liveGeneration.current === generation) update(next)
  }
  return (
    <EditorErrorBoundary
      context={{ boundary: 'field', fieldPath: canopyPath }}
      resetKey={resetKey}
      onCaught={() => {
        liveGeneration.current += 1
        setGeneration(liveGeneration.current)
      }}
      fallback={fallback}
    >
      <FieldControl build={() => build(guardedUpdate)} />
    </EditorErrorBoundary>
  )
}

export interface FormRendererProps {
  fields: EntrySchema
  value: FormValue
  onChange: (next: FormValue) => void
  customRenderers?: CustomFieldRenderers
  branch?: string // Current branch for loading reference options
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
  /** True when this entry's content conflicts with a recent change on the base branch */
  conflictNotice?: boolean
  /**
   * Per-field validation errors keyed by canonical canopy path (e.g.
   * `blocks[0].title`). Rendered as a summary alert plus an inline message
   * under each offending field. Produced by the save-path schema validation
   * in useDraftManager and by server 422 rejections.
   */
  fieldErrors?: Record<string, string>
  /** The entry's format, which decides how its body field is checked. */
  format?: ContentFormat
  /** Shows the value without accepting edits. Comments stay open. */
  readOnly?: boolean
  /** Told of each list item, block or image that Remove takes out, so the caller can offer Undo. */
  onRemoved?: (removal: FieldRemoval) => void
  /** Resolves comment authors to names in field and entry threads; without it they show as ids. */
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
  /**
   * Shows a sticky header naming the entry, with an outline of its fields and, when it has list
   * or block fields, Expand all and Collapse all.
   */
  header?: { title: string; typeLabel?: string }
  /** An entry-wide notice, shown first under the header. */
  notice?: React.ReactNode
  /** Why a field can't take a new comment thread yet, such as one inside an unsaved item. */
  commentBlockedReason?: (canopyPath: string) => string | undefined
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
  conflictNotice = false,
  fieldErrors,
  format,
  readOnly = false,
  onRemoved,
  onGetUserMetadata,
  header,
  notice,
  commentBlockedReason,
}) => {
  const emit = readOnly ? noop : onChange
  const formRef = useRef<HTMLDivElement>(null)
  const customTypes = new Set(Object.keys(customRenderers ?? {}))
  const [expansionCommand, setExpansionCommand] = useState<FormExpansionCommand | undefined>()
  const boundaryResetKey = `${branch}\n${currentEntryPath ?? ''}`
  const siteMdxAllow = useSiteMdxAllow()
  const bodyName = format === 'md' || format === 'mdx' ? findBodyFieldName(fields) : undefined

  const keysForList = useListItemKeys()

  // Whether a list row holds an error, so a collapsed row can say so.
  const rowHasErrors =
    (listPath: Array<string | number>) =>
    (index: number): boolean => {
      const row = normalizeCanopyPath([...listPath, index])
      return Object.keys(fieldErrors ?? {}).some(
        (key) => key === row || key.startsWith(`${row}.`) || key.startsWith(`${row}[`),
      )
    }
  const [formComments] = useState(createFormComments)
  // The field last focused on one entry is never offered on the next.
  useEffect(() => formComments.noteFocus(undefined), [formComments, boundaryResetKey])

  // Wraps the rendered control in an error boundary, and with an inline validation message
  // when this field has an active error (keyed by canonical canopy path, so errors land on
  // nested object/block fields too). Passed down to BlockField/ObjectField so nested fields
  // get the same decoration.
  const renderField = (
    field: FieldConfig,
    currentValue: unknown,
    update: (v: unknown) => void,
    path: Array<string | number>,
  ) => {
    const canopyPath = normalizeCanopyPath(path)
    const error = fieldErrors?.[canopyPath]
    return (
      <Stack key={fieldKey(path)} gap={4}>
        <FieldBoundary
          canopyPath={canopyPath}
          resetKey={boundaryResetKey}
          update={update}
          build={(guardedUpdate) => renderFieldControl(field, currentValue, guardedUpdate, path)}
          fallback={(caught) => (
            <FieldCrashFallback
              label={field.label ?? field.name}
              fieldType={field.type}
              value={currentValue}
              onChange={readOnly ? undefined : update}
              caught={caught}
              dataCanopyField={canopyPath}
            />
          )}
        />
        {error && (
          <Text
            size="xs"
            c="var(--canopy-danger-text)"
            data-testid={`field-error-${fieldKey(path)}`}
          >
            {error}
          </Text>
        )}
      </Stack>
    )
  }

  const renderFieldControl = (
    field: FieldConfig,
    currentValue: unknown,
    update: (v: unknown) => void,
    path: Array<string | number>,
  ) => {
    const fieldId = `field-${fieldKey(path).replace(/[^a-zA-Z0-9_-]/g, '-')}`
    const canopyPath = normalizeCanopyPath(path)

    const fieldThreads =
      currentEntryPath && onAddComment
        ? comments.filter(
            (thread) =>
              thread.type === 'field' &&
              thread.entryPath === currentEntryPath &&
              thread.canopyPath === canopyPath &&
              !thread.onRemovedItem,
          )
        : []

    // The full breadcrumb, so a list item's or block's fields are told apart by name.
    const commentSubject = fieldBreadcrumb(fields, value, canopyPath).join(' › ')

    const custom = customRenderers?.[field.type]
    if (custom) {
      const renderedField = (
        <ReadOnlyFence key={fieldKey(path)} readOnly={readOnly}>
          {custom({
            field,
            value: currentValue,
            onChange: readOnly ? noop : update,
            path,
            id: fieldId,
            readOnly,
          })}
        </ReadOnlyFence>
      )

      if (currentEntryPath && currentUserId && onAddComment && onResolveThread) {
        return (
          <FieldWrapper
            key={fieldKey(path)}
            canopyPath={canopyPath}
            entryPath={currentEntryPath}
            threads={fieldThreads}
            commentBlockedReason={commentBlockedReason?.(canopyPath)}
            autoFocus={focusedFieldPath === canopyPath}
            currentUserId={currentUserId}
            canResolve={canResolve}
            onAddComment={onAddComment}
            onResolveThread={onResolveThread}
            highlightThreadId={highlightThreadId}
            onGetUserMetadata={onGetUserMetadata}
            fieldLabel={commentSubject}
            resetKey={boundaryResetKey}
            controlPlacement="corner"
          >
            {renderedField}
          </FieldWrapper>
        )
      }

      return renderedField
    }

    const label = field.label ?? field.name

    const wrapWithComments = (renderedField: React.ReactNode) => {
      if (currentEntryPath && currentUserId && onAddComment && onResolveThread) {
        return (
          <FieldWrapper
            canopyPath={canopyPath}
            entryPath={currentEntryPath}
            threads={fieldThreads}
            commentBlockedReason={commentBlockedReason?.(canopyPath)}
            autoFocus={focusedFieldPath === canopyPath}
            currentUserId={currentUserId}
            canResolve={canResolve}
            onAddComment={onAddComment}
            onResolveThread={onResolveThread}
            highlightThreadId={highlightThreadId}
            onGetUserMetadata={onGetUserMetadata}
            fieldLabel={commentSubject}
            resetKey={boundaryResetKey}
          >
            {renderedField}
          </FieldWrapper>
        )
      }
      return renderedField
    }

    switch (field.type) {
      case 'string':
        if (field.list) {
          return wrapWithComments(
            <StringListField
              key={fieldKey(path)}
              id={fieldId}
              label={label}
              description={field.description}
              value={Array.isArray(currentValue) ? (currentValue as string[]) : []}
              onChange={(v) => update(v)}
              dataCanopyField={normalizeCanopyPath(path)}
              readOnly={readOnly}
            />,
          )
        }
        return wrapWithComments(
          <TextField
            key={fieldKey(path)}
            id={fieldId}
            label={label}
            description={field.description}
            value={(currentValue as string) ?? ''}
            onChange={update}
            dataCanopyField={normalizeCanopyPath(path)}
            readOnly={readOnly}
          />,
        )
      case 'boolean':
        return wrapWithComments(
          <ToggleField
            key={fieldKey(path)}
            id={fieldId}
            label={label}
            description={field.description}
            value={Boolean(currentValue)}
            onChange={(v) => update(Boolean(v))}
            dataCanopyField={normalizeCanopyPath(path)}
            testId={`field-toggle-${field.name}`}
            readOnly={readOnly}
          />,
        )
      case 'number':
        if (field.list) {
          return wrapWithComments(
            <NumberListField
              key={fieldKey(path)}
              id={fieldId}
              label={label}
              description={field.description}
              value={
                Array.isArray(currentValue)
                  ? currentValue.filter((v): v is number => typeof v === 'number')
                  : []
              }
              onChange={(v) => update(v)}
              dataCanopyField={normalizeCanopyPath(path)}
              readOnly={readOnly}
            />,
          )
        }
        return wrapWithComments(
          <NumberField
            key={fieldKey(path)}
            id={fieldId}
            label={label}
            description={field.description}
            value={typeof currentValue === 'number' ? currentValue : undefined}
            onChange={(v) => update(v)}
            dataCanopyField={normalizeCanopyPath(path)}
            readOnly={readOnly}
          />,
        )
      case 'datetime':
        return wrapWithComments(
          <DateTimeField
            key={fieldKey(path)}
            id={fieldId}
            label={label}
            description={field.description}
            value={typeof currentValue === 'string' ? currentValue : ''}
            onChange={(v) => update(v)}
            dataCanopyField={normalizeCanopyPath(path)}
            readOnly={readOnly}
            stampOnPublish={'stampOnPublish' in field && field.stampOnPublish === true}
          />,
        )
      case 'markdown':
      case 'mdx': {
        const isBody = path.length === 1 && path[0] === bodyName
        const policy = markdownPolicyOf(
          field as MarkdownFieldConfig,
          siteMdxAllow,
          isBody ? format : undefined,
        )
        return wrapWithComments(
          <MarkdownField
            key={fieldKey(path)}
            id={fieldId}
            label={label}
            description={field.description}
            value={(currentValue as string) ?? ''}
            onChange={(v) => update(v)}
            dataCanopyField={normalizeCanopyPath(path)}
            htmlTags={policy?.dialect === 'mdx' ? policy.allow.htmlTags : undefined}
            readOnly={readOnly}
          />,
        )
      }
      case 'select': {
        const selectField = field as SelectFieldConfig
        const options = normalizeOptions(selectField.options)
        const isMulti = Boolean(selectField.list)
        return wrapWithComments(
          <SelectField
            key={fieldKey(path)}
            id={fieldId}
            label={label}
            description={field.description}
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
            readOnly={readOnly}
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
            description={field.description}
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
            readOnly={readOnly}
          />,
        )
      }
      case 'image': {
        const imageField = field as ImageFieldConfig
        return wrapWithComments(
          <ImageField
            key={fieldKey(path)}
            id={fieldId}
            label={label}
            description={field.description}
            value={currentValue as ImageFieldValue | undefined}
            onChange={(next) => update(next)}
            aspect={imageField.aspect}
            altOptional={imageField.altOptional}
            dataCanopyField={canopyPath}
            errors={{
              src: fieldErrors?.[`${canopyPath}.src`],
              alt: fieldErrors?.[`${canopyPath}.alt`],
              crop: fieldErrors?.[`${canopyPath}.crop`],
            }}
            readOnly={readOnly}
            onRemoved={(removed) =>
              onRemoved?.({ kind: 'value', path, value: removed, label: `the image from ${label}` })
            }
          />,
        )
      }
      case 'block': {
        const blockField = field as BlockFieldConfig
        return wrapWithComments(
          <BlockField
            key={fieldKey(path)}
            label={label}
            required={field.required}
            description={field.description}
            templates={blockField.templates}
            value={(Array.isArray(currentValue) ? currentValue : []) as BlockInstance[]}
            onChange={(next) => update(next)}
            renderField={renderField}
            path={path}
            dataCanopyField={normalizeCanopyPath(path)}
            readOnly={readOnly}
            resetKey={boundaryResetKey}
            hasErrors={rowHasErrors(path)}
            onRemoved={(index, block) =>
              onRemoved?.({
                kind: 'list-item',
                listPath: path,
                index,
                item: block,
                label: `"${
                  blockField.templates.find((t) => t.name === block.template)?.label ??
                  block.template
                }" from ${label}`,
              })
            }
          />,
        )
      }
      case 'object': {
        const objectField = field as ObjectFieldConfig
        if (objectField.list) {
          const items = Array.isArray(currentValue)
            ? (currentValue as Record<string, unknown>[])
            : []
          return wrapWithComments(
            <ObjectListField
              key={fieldKey(path)}
              id={fieldId}
              label={label}
              field={objectField}
              items={items}
              itemKeys={keysForList(items, fieldKey(path))}
              onChange={(next) => update(next)}
              renderField={renderField}
              path={path}
              canopyPath={canopyPath}
              readOnly={readOnly}
              resetKey={boundaryResetKey}
              hasErrors={rowHasErrors(path)}
              onRemoved={(index, item) =>
                onRemoved?.({
                  kind: 'list-item',
                  listPath: path,
                  index,
                  item,
                  label: removedItemLabel(item, objectField, label, index),
                })
              }
            />,
          )
        }

        // A non-list object has no list item to remove, so its only way back to `undefined` is
        // the Clear button (`onRemove`): shown only for an optional field that has a value.
        // Reset to `undefined`, never `{}`, which `isEmptyForRequired` (entry-validator.ts) reads
        // as present. The label is "Clear" (docs/ux-guidelines.md, Vocabulary).
        const hasValue = currentValue !== undefined && currentValue !== null
        const canClear = !readOnly && objectField.required !== true && hasValue

        return wrapWithComments(
          <ObjectField
            key={fieldKey(path)}
            label={label}
            required={objectField.required}
            description={field.description}
            fields={objectField.fields}
            value={currentValue as Record<string, unknown> | undefined}
            onChange={(next) => update(next)}
            onRemove={canClear ? () => update(undefined) : undefined}
            renderField={renderField}
            path={path}
            dataCanopyField={normalizeCanopyPath(path)}
          />,
        )
      }
      case 'code':
        return wrapWithComments(
          <CodeField
            key={fieldKey(path)}
            id={fieldId}
            label={label}
            description={field.description}
            value={typeof currentValue === 'string' ? currentValue : ''}
            onChange={(v) => update(v)}
            dataCanopyField={normalizeCanopyPath(path)}
            readOnly={readOnly}
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
    <FormCommentsContext.Provider value={formComments}>
      <FormExpansionContext.Provider value={expansionCommand}>
        <Stack
          ref={formRef}
          gap="md"
          data-form-renderer
          className={readOnly ? READ_ONLY_FORM_CLASS : undefined}
        >
          {header && (
            <FormHeader
              title={header.title}
              typeLabel={header.typeLabel}
              outline={buildFormOutline(fields, value, customTypes)}
              onSelect={(path) => {
                const target = formRef.current ? findFieldTarget(path, formRef.current) : undefined
                if (target) focusFieldTarget(target.element)
              }}
              onExpandAll={
                hasCollapsibleList(fields, customTypes)
                  ? (expanded) =>
                      setExpansionCommand((prev) => ({ seq: (prev?.seq ?? 0) + 1, expanded }))
                  : undefined
              }
            />
          )}
          {notice}
          {readOnly && <ReadOnlyFormStyles />}
          {currentEntryPath && currentUserId && onAddComment && onResolveThread && (
            <EntryComments
              comments={comments}
              entryPath={currentEntryPath}
              currentUserId={currentUserId}
              canResolve={canResolve}
              onAddComment={onAddComment}
              onResolveThread={onResolveThread}
              highlightThreadId={highlightThreadId}
              onGetUserMetadata={onGetUserMetadata}
              resetKey={boundaryResetKey}
              // From the schema alone, without the items: no item holds this path any more.
              removedItemFieldLabel={(path) =>
                fieldBreadcrumb(fields, undefined, path, { items: false }).join(' › ')
              }
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
              {readOnly
                ? 'Someone else has recently changed this page.'
                : 'Someone else has recently changed this page. You can keep editing — a reviewer will reconcile your changes when you submit.'}
            </Alert>
          )}

          {fieldErrors && <ValidationSummary fields={fields} value={value} errors={fieldErrors} />}

          {fields.map((field) => {
            // Inline groups are transparent to the value — render them directly with parent value/onChange
            if (field.type === 'group') {
              const groupField = field as InlineGroupFieldConfig
              return (
                <div key={`group-${groupField.name}`}>
                  <InlineGroupField
                    label={groupField.label}
                    description={groupField.description}
                    fields={groupField.fields}
                    value={value}
                    onChange={emit}
                    renderField={renderField}
                    path={[]}
                  />
                </div>
              )
            }

            const val = value[field.name]
            const path = [field.name]
            return (
              <div key={fieldKey(path)}>
                {renderField(field, val, (next) => emit({ ...value, [field.name]: next }), path)}
              </div>
            )
          })}
        </Stack>
      </FormExpansionContext.Provider>
    </FormCommentsContext.Provider>
  )
}
