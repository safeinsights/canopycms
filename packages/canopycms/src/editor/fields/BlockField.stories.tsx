import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import type { BlockConfig, FieldConfig } from '../../config'
import type { BlockInstance } from './BlockField'
import { BlockField } from './BlockField'
import { MarkdownField } from './MarkdownField'
import { TextField } from './TextField'

const meta: Meta<typeof BlockField> = {
  title: 'Editor/Fields/Block',
  component: BlockField,
}

export default meta
type Story = StoryObj<typeof BlockField>

export const Default: Story = {
  render: () => {
    const templates: BlockConfig[] = [
      {
        name: 'hero',
        label: 'Hero',
        fields: [
          { name: 'headline', type: 'string' },
          { name: 'body', type: 'markdown' },
        ],
      },
      {
        name: 'cta',
        label: 'CTA',
        fields: [
          { name: 'title', type: 'string' },
          { name: 'ctaText', type: 'string' },
        ],
      },
    ]
    const [blocks, setBlocks] = useState<BlockInstance[]>([
      { template: 'hero', value: { headline: 'Hello', body: 'Intro text' } },
      { template: 'cta', value: { title: 'Call to action', ctaText: 'Click me' } },
    ])

    const renderWidget = (field: FieldConfig, value: unknown, onChange: (v: unknown) => void) => {
      if (field.type === 'string') {
        return (
          <TextField
            label={field.label ?? field.name}
            value={typeof value === 'string' ? value : ''}
            onChange={(v) => onChange(v)}
          />
        )
      }
      if (field.type === 'markdown' || field.type === 'mdx') {
        return (
          <MarkdownField
            label={field.label ?? field.name}
            value={typeof value === 'string' ? value : ''}
            onChange={(v) => onChange(v)}
          />
        )
      }
      return <div className="text-xs text-gray-500">Unsupported field: {field.type}</div>
    }

    return (
      <BlockField
        label="Blocks"
        templates={templates}
        value={blocks}
        onChange={(next) => setBlocks(next)}
        renderField={(field, val, update, _path) => renderWidget(field, val, update)}
        path={['blocks']}
      />
    )
  },
}
