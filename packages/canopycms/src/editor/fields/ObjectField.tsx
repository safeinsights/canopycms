import React, { useId, useRef } from 'react'

import {
  ActionIcon,
  Button,
  Menu,
  Paper,
  Stack,
  Text,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core'
import { IconDots } from '@tabler/icons-react'

import type { FieldConfig } from '../../config'
import { isPlainRecord } from '../../validation/field-traversal'
import { formatCanopyPath } from '../canopy-path'
import { useFieldCommentControl } from '../comments/field-comment-context'
import { DestructiveMenuItem } from '../components/DestructiveMenuItem'
import { EDITOR_ACTIONS } from '../copy'
import { focusFieldTarget } from '../field-target'
import { groupDescriptionProps } from './FieldDescription'
import { FieldLabel } from './FieldLabel'

export type RenderField = (
  field: FieldConfig,
  value: unknown,
  onChange: (v: unknown) => void,
  path: Array<string | number>,
) => React.ReactNode

export interface ObjectFieldProps {
  label?: string
  required?: boolean
  description?: string
  fields: FieldConfig[]
  value: Record<string, unknown> | undefined
  onChange: (value: Record<string, unknown>) => void
  renderField: RenderField
  path: Array<string | number>
  dataCanopyField?: string
  /** Set, a "…" menu offers Clear, resetting the field to `undefined`; omitted for list items. */
  onClear?: () => void
  /** Set, an "Undo clear" button stands in the label row in place of the "…" menu. */
  onUndoClear?: () => void
  /** Said with the Undo, such as where the object's comment threads went. */
  clearNote?: string
}

const quoted = (label: string | undefined) => (label ? ` "${label}"` : '')

/**
 * An object field's group of fields. Its Clear is an Undo-instead-of-confirm removal
 * (docs/ux-guidelines.md, Destructive actions) whose Undo stays in the label row, where the clear
 * happened, until the caller drops `onUndoClear`: never on a timer, which fails WCAG 2.2.1.
 */
export const ObjectField: React.FC<ObjectFieldProps> = ({
  label,
  required,
  description,
  fields,
  value,
  onChange,
  renderField,
  path,
  dataCanopyField,
  onClear,
  onUndoClear,
  clearNote,
}) => {
  const current = isPlainRecord(value) ? value : {}
  const descriptionBaseId = useId()
  const commentControl = useFieldCommentControl(dataCanopyField ?? formatCanopyPath(path))
  const groupRef = useRef<HTMLDivElement>(null)
  const undoRef = useRef<HTMLButtonElement>(null)
  const actionsLabel = label ? `Actions for ${label}` : 'Actions'

  // The menu goes with the value and the Undo takes its place, so focus moves there, one key from
  // undoing. With no Undo offered, the object takes focus rather than the page.
  const clear = () => {
    onClear?.()
    requestAnimationFrame(() => (undoRef.current ?? groupRef.current)?.focus())
  }
  const undo = () => {
    onUndoClear?.()
    requestAnimationFrame(() => {
      if (groupRef.current) focusFieldTarget(groupRef.current)
    })
  }

  let actions: React.ReactNode = null
  if (onUndoClear) {
    actions = (
      <Button
        ref={undoRef}
        size="compact-sm"
        variant="subtle"
        aria-label={`${EDITOR_ACTIONS.undoClear}${quoted(label)}`}
        onClick={undo}
      >
        {EDITOR_ACTIONS.undoClear}
      </Button>
    )
  } else if (onClear) {
    actions = (
      <Menu position="bottom-end" withinPortal shadow="sm" width={220}>
        <Tooltip label={actionsLabel} openDelay={500}>
          <Menu.Target>
            <ActionIcon variant="subtle" color="gray" aria-label={actionsLabel}>
              <IconDots size={16} aria-hidden />
            </ActionIcon>
          </Menu.Target>
        </Tooltip>
        <Menu.Dropdown>
          <DestructiveMenuItem onClick={clear}>
            {`${EDITOR_ACTIONS.clear}${quoted(label)}`}
          </DestructiveMenuItem>
        </Menu.Dropdown>
      </Menu>
    )
  }

  return (
    <Paper
      ref={groupRef}
      withBorder
      p="md"
      bg="var(--canopy-surface-subtle)"
      data-canopy-field={dataCanopyField ?? formatCanopyPath(path)}
      shadow="xs"
      {...groupDescriptionProps(descriptionBaseId, description)}
      role="group"
      aria-label={label}
      data-removal-focus
      tabIndex={-1}
    >
      <Stack gap="sm">
        <FieldLabel
          label={label}
          required={required}
          description={description}
          descriptionBaseId={descriptionBaseId}
          commentControl={commentControl}
          actions={actions}
        />
        {onUndoClear && clearNote && (
          <Text size="xs" c="dimmed">
            {clearNote}
          </Text>
        )}
        <VisuallyHidden role="status">
          {onUndoClear ? `Cleared${quoted(label)}.${clearNote ? ` ${clearNote}` : ''}` : ''}
        </VisuallyHidden>
        <Stack gap="sm">
          {fields.map((field) => {
            const fieldPath = [...path, field.name]
            return (
              <div key={formatCanopyPath(fieldPath)}>
                {renderField(
                  field,
                  current[field.name],
                  (next) => onChange({ ...current, [field.name]: next }),
                  fieldPath,
                )}
              </div>
            )
          })}
        </Stack>
      </Stack>
    </Paper>
  )
}
