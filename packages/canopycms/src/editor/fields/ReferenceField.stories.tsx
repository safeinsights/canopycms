import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import { ReferenceField } from './ReferenceField'
import type { ReferenceOption } from './use-reference-options'

const meta: Meta<typeof ReferenceField> = {
  title: 'Editor/Fields/Reference',
  component: ReferenceField,
}

export default meta
type Story = StoryObj<typeof ReferenceField>

const POSTS: ReferenceOption[] = [
  { value: 'post-spring', label: 'Spring launch' },
  {
    value: 'post-summer',
    label: 'Summer recap',
    noindex: { fieldLabel: 'Hide from search engines' },
  },
  { value: 'post-autumn', label: 'Autumn preview' },
]

const Single: React.FC<{ initial: string }> = ({ initial }) => {
  const [value, setValue] = useState(initial)
  return (
    <div style={{ maxWidth: 560 }}>
      <ReferenceField
        label="Featured post"
        description="The post the home page leads with."
        options={POSTS}
        value={value}
        onChange={setValue}
        dataCanopyField="featured"
      />
    </div>
  )
}

export const Picked: Story = { render: () => <Single initial="post-spring" /> }

/** A hidden pick: a badge beside the input and a note saying what it means. */
export const HiddenFromSearch: Story = { render: () => <Single initial="post-summer" /> }
