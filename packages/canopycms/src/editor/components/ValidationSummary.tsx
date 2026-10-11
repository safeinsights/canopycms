'use client'

import React from 'react'
import { Alert, Anchor, List, Text } from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'

import type { FieldConfig } from '../../config'
import { fieldBreadcrumb } from '../field-breadcrumb'
import { findFieldTarget, focusFieldTarget } from '../field-target'

export interface ValidationSummaryProps {
  fields: readonly FieldConfig[]
  /** The form's value, which names list items and blocks in the breadcrumbs. */
  value: unknown
  /** Messages keyed by canonical canopy path. */
  errors: Record<string, string>
}

/**
 * The form's errors as labelled breadcrumbs ("Page sections › Hero › Heading"), each a button
 * that scrolls to its field in the enclosing form and focuses it.
 */
export const ValidationSummary: React.FC<ValidationSummaryProps> = ({ fields, value, errors }) => {
  const entries = Object.entries(errors)
  if (entries.length === 0) return null

  return (
    <Alert
      icon={<IconAlertCircle size={16} />}
      color="red"
      variant="light"
      title="Fix these issues before saving"
      data-testid="validation-alert"
    >
      <List size="sm" spacing={2}>
        {entries.map(([path, message]) => {
          const crumb = fieldBreadcrumb(fields, value, path).join(' › ')
          return (
            <List.Item key={path}>
              <Anchor
                component="button"
                type="button"
                size="sm"
                c="inherit"
                underline="always"
                ta="left"
                data-testid={`validation-item-${path}`}
                onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                  const form = event.currentTarget.closest('[data-form-renderer]') ?? document
                  const target = findFieldTarget(path, form)
                  if (target) focusFieldTarget(target.element)
                }}
              >
                {crumb}
              </Anchor>
              <Text span size="sm">
                : {message}
              </Text>
            </List.Item>
          )
        })}
      </List>
    </Alert>
  )
}
