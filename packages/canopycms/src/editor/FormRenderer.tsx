import React, { useCallback } from 'react'

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
  fields: FieldConfig[]
  value: FormValue
  onChange: (next: FormValue) => void
  customRenderers?: CustomFieldRenderers
}

export const FormRenderer: React.FC<FormRendererProps> = ({ fields, value, onChange, customRenderers }) => {
  const renderField = useCallback(
    (field: FieldConfig, currentValue: unknown, update: (v: unknown) => void, path: Array<string | number>) => {
      const fieldId = `field-${fieldKey(path).replace(/[^a-zA-Z0-9_-]/g, '-')}`

      const custom = customRenderers?.[field.type]
      if (custom) {
        return (
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
      }

      const label = field.label ?? field.name

      switch (field.type) {
        case 'string':
          return (
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
          return (
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
          return (
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
          return (
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
          const options = normalizeOptions(referenceField.options)
          const isMulti = Boolean(referenceField.list)
          return (
            <ReferenceField
              key={fieldKey(path)}
              id={fieldId}
              label={label}
              options={options.map((opt) => ({
                label: opt.label,
                value: opt.value,
              }))}
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
          return (
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
          return (
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
    [customRenderers]
  )

  return (
    <Stack gap="md">
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
