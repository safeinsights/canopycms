import React from 'react'

import { Input } from '@mantine/core'

/** The id Mantine gives a native input's description, so custom fields match it. */
export const fieldDescriptionId = (baseId: string): string => `${baseId}-description`

/**
 * Guidance text for fields that don't use a Mantine input's native `description` prop.
 * Renders nothing for an absent or empty description.
 */
export const FieldDescription: React.FC<{ baseId: string; description?: string }> = ({
  baseId,
  description,
}) =>
  description ? (
    <Input.Description id={fieldDescriptionId(baseId)}>{description}</Input.Description>
  ) : null

/** Props that tie a custom field's container to its `FieldDescription`; empty without one. */
export const groupDescriptionProps = (
  baseId: string,
  description: string | undefined,
): { role?: 'group'; 'aria-describedby'?: string } =>
  description ? { role: 'group', 'aria-describedby': fieldDescriptionId(baseId) } : {}
