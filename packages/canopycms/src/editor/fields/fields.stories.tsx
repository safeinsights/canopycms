import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import { MarkdownField } from './MarkdownField'
import { TextField } from './TextField'
import { ToggleField } from './ToggleField'

const meta: Meta = {
  title: 'Editor/Fields',
}

export default meta

export const Text: StoryObj = {
  render: () => {
    const [value, setValue] = useState('Hello')
    return <TextField label="Title" value={value} onChange={setValue} />
  },
}

export const Toggle: StoryObj = {
  render: () => {
    const [value, setValue] = useState(true)
    return <ToggleField label="Published" value={value} onChange={setValue} />
  },
}

export const Markdown: StoryObj = {
  render: () => {
    const [value, setValue] = useState('## Hello\n\nEdit markdown here.')
    return <MarkdownField label="Body" value={value} onChange={setValue} />
  },
}

export const Code: StoryObj = {
  render: () => {
    const [value, setValue] = useState('console.log("hello");')
    return <MarkdownField label="Code" value={value} onChange={setValue} />
  },
}
