import React from 'react'

import { Group, Input, Stack } from '@mantine/core'

import { FieldDescription } from './FieldDescription'

/**
 * The label row shared by fields and field groups: label, comment-control slot, right-aligned
 * actions slot, and the description beneath.
 */
export interface FieldLabelProps {
  /** Visible label text. When absent and there are no actions or commentControl, only the description renders. */
  label?: React.ReactNode
  /** Shows Mantine's required asterisk. */
  required?: boolean
  /** Guidance under the label; rendered via FieldDescription so its id matches groupDescriptionProps(baseId, ...). */
  description?: string
  /** Base id shared with groupDescriptionProps/fieldDescriptionId; without it, no description renders. */
  descriptionBaseId?: string
  /** When set, the label is a <label for=...>; otherwise it is a <div> (groups have no single input). */
  htmlFor?: string
  /** id on the label element, so a container can aria-labelledby it. */
  labelId?: string
  /** Slot right after the label text, for the field's comment control. */
  commentControl?: React.ReactNode
  /** Right-aligned slot for field actions (Add item, Remove, Add block). */
  actions?: React.ReactNode
}

export const FieldLabel: React.FC<FieldLabelProps> = ({
  label,
  required,
  description,
  descriptionBaseId,
  htmlFor,
  labelId,
  commentControl,
  actions,
}) => {
  const hasRow = Boolean(label) || Boolean(commentControl) || Boolean(actions)
  if (!hasRow && !description) return null

  return (
    <Stack gap={2}>
      {hasRow && (
        <Group justify="space-between" wrap="nowrap" gap="xs" align="center">
          <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
            {label && (
              <Input.Label
                required={required}
                htmlFor={htmlFor}
                id={labelId}
                labelElement={htmlFor ? 'label' : 'div'}
              >
                {label}
              </Input.Label>
            )}
            {commentControl}
          </Group>
          {actions && (
            <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
              {actions}
            </Group>
          )}
        </Group>
      )}
      {descriptionBaseId && (
        <FieldDescription baseId={descriptionBaseId} description={description} />
      )}
    </Stack>
  )
}
