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

const templates: BlockConfig[] = [
  {
    name: 'hero',
    label: 'Hero',
    description: 'A large headline and intro at the top of the page.',
    fields: [
      { name: 'headline', type: 'string' },
      { name: 'body', type: 'markdown' },
    ],
  },
  {
    name: 'cta',
    label: 'Call to action',
    description: 'A short prompt with one button.',
    fields: [
      { name: 'title', type: 'string' },
      { name: 'ctaText', type: 'string' },
    ],
  },
  {
    name: 'quote',
    label: 'Quote',
    fields: [
      { name: 'text', type: 'string' },
      { name: 'author', type: 'string' },
    ],
  },
]

const renderWidget = (
  field: FieldConfig,
  value: unknown,
  onChange: (v: unknown) => void,
  readOnly: boolean,
) => {
  if (field.type === 'markdown' || field.type === 'mdx') {
    return (
      <MarkdownField
        label={field.label ?? field.name}
        value={typeof value === 'string' ? value : ''}
        onChange={(v) => onChange(v)}
        readOnly={readOnly}
      />
    )
  }
  return (
    <TextField
      label={field.label ?? field.name}
      value={typeof value === 'string' ? value : ''}
      onChange={(v) => onChange(v)}
      readOnly={readOnly}
    />
  )
}

const Blocks: React.FC<{
  initial: BlockInstance[]
  readOnly?: boolean
  errorsIn?: number[]
}> = ({ initial, readOnly = false, errorsIn = [] }) => {
  const [blocks, setBlocks] = useState<BlockInstance[]>(initial)
  return (
    <BlockField
      label="Page sections"
      templates={templates}
      value={blocks}
      onChange={(next) => setBlocks(next)}
      renderField={(field, val, update) => (
        <div key={field.name}>{renderWidget(field, val, update, readOnly)}</div>
      )}
      path={['blocks']}
      readOnly={readOnly}
      hasErrors={(index) => errorsIn.includes(index)}
    />
  )
}

const twoBlocks: BlockInstance[] = [
  { template: 'hero', value: { headline: 'Welcome to Canopy', body: 'Intro text' } },
  { template: 'cta', value: { title: 'Try it today', ctaText: 'Get started' } },
]

const fiveBlocks: BlockInstance[] = [
  ...twoBlocks,
  { template: 'quote', value: { text: 'It just works.', author: 'A happy editor' } },
  { template: 'cta', value: { title: 'Read the docs', ctaText: 'Docs' } },
  { template: 'quote', value: {} },
]

/** Three or fewer sections all start open. Hover between them for "Add section here". */
export const Default: Story = { render: () => <Blocks initial={twoBlocks} /> }

/** More than three: only the first starts open, and "Expand all" opens the rest. */
export const ManySections: Story = { render: () => <Blocks initial={fiveBlocks} /> }

/** A collapsed section holding an invalid field says so in its summary row. */
export const WithErrors: Story = { render: () => <Blocks initial={fiveBlocks} errorsIn={[3]} /> }

/** Read-only: sections still collapse, but nothing adds, moves or removes them. */
export const ReadOnly: Story = { render: () => <Blocks initial={fiveBlocks} readOnly /> }

export const Empty: Story = { render: () => <Blocks initial={[]} /> }
