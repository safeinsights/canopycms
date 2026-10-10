import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'

import type { FieldConfig } from '../../config'
import { ObjectField } from './ObjectField'

const fields: FieldConfig[] = [{ name: 'headline', type: 'string' }]

describe('ObjectField', () => {
  afterEach(() => {
    cleanup()
  })

  it('edits an array value into a record of its fields', () => {
    const fieldChanges: Array<(v: unknown) => void> = []
    const changes: unknown[] = []
    render(
      <MantineProvider>
        <ObjectField
          fields={fields}
          value={['item1', 'item2'] as unknown as Record<string, unknown>}
          onChange={(value) => changes.push(value)}
          renderField={(_field, _value, onChange) => {
            fieldChanges.push(onChange)
            return null
          }}
          path={['meta']}
        />
      </MantineProvider>,
    )

    fieldChanges[0]('First')

    expect(changes).toEqual([{ headline: 'First' }])
  })
})
