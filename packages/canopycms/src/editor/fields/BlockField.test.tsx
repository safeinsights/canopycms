import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'

import type { BlockConfig } from '../../config'
import { BlockField } from './BlockField'

const templates: BlockConfig[] = [
  { name: 'hero', label: 'Hero', fields: [{ name: 'headline', type: 'string' }] },
]

describe('BlockField', () => {
  afterEach(() => {
    cleanup()
  })

  it('marks each block with its own path, so preview focus can land on a block as a whole', () => {
    const { container } = render(
      <MantineProvider>
        <BlockField
          templates={templates}
          value={[
            { template: 'hero', value: { headline: 'One' } },
            { template: 'hero', value: { headline: 'Two' } },
          ]}
          onChange={() => {}}
          renderField={() => null}
          path={['blocks']}
        />
      </MantineProvider>,
    )

    const fields = [...container.querySelectorAll('[data-canopy-field]')].map((element) =>
      element.getAttribute('data-canopy-field'),
    )
    expect(fields).toEqual(['blocks', 'blocks[0]', 'blocks[1]'])
    expect(container.querySelector('[data-canopy-field="blocks[1]"]')?.textContent).toContain(
      'Hero',
    )
  })

  it('edits a block whose value is null or an array into a record of its fields', () => {
    const fieldChanges: Array<(v: unknown) => void> = []
    const changes: unknown[] = []
    render(
      <MantineProvider>
        <BlockField
          templates={templates}
          value={[
            { template: 'hero', value: null as unknown as Record<string, unknown> },
            { template: 'hero', value: ['item1', 'item2'] as unknown as Record<string, unknown> },
          ]}
          onChange={(blocks) => changes.push(blocks)}
          renderField={(_field, _value, onChange) => {
            fieldChanges.push(onChange)
            return null
          }}
          path={['blocks']}
        />
      </MantineProvider>,
    )

    fieldChanges[0]('First')
    fieldChanges[1]('Second')

    expect(changes).toEqual([
      [
        { template: 'hero', value: { headline: 'First' } },
        { template: 'hero', value: ['item1', 'item2'] },
      ],
      [
        { template: 'hero', value: null },
        { template: 'hero', value: { headline: 'Second' } },
      ],
    ])
  })
})
