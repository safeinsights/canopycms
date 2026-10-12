import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import { DateTimeField } from './DateTimeField'
import { MarkdownField } from './MarkdownField'
import { StringListField } from './StringListField'
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

export const DateTime: StoryObj = {
  render: () => {
    const [value, setValue] = useState('2026-10-12T14:30:00.000Z')
    return <DateTimeField label="Published at" value={value} onChange={setValue} />
  },
}

export const StringList: StoryObj = {
  render: () => {
    const [value, setValue] = useState(['typed', 'fast'])
    return <StringListField label="Keywords" value={value} onChange={setValue} />
  },
}

/** A form column narrower than the toolbar: every button stays reachable. */
export const MarkdownNarrow: StoryObj = {
  render: () => {
    const [value, setValue] = useState('## Hello\n\nEdit markdown here.')
    return (
      <div style={{ width: 360 }}>
        <MarkdownField label="Body" value={value} onChange={setValue} />
      </div>
    )
  },
}
