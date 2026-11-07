import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import { DateField } from './DateField'
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

export const DateOnly: StoryObj = {
  render: () => {
    const [value, setValue] = useState('2026-10-12')
    return <DateField label="Event date" value={value} onChange={setValue} />
  },
}

export const DateOnlyEmpty: StoryObj = {
  render: () => {
    const [value, setValue] = useState('')
    return (
      <DateField
        label="Event date"
        description="The day it runs."
        value={value}
        onChange={setValue}
      />
    )
  },
}

export const DateOnlyReadOnly: StoryObj = {
  render: () => <DateField label="Event date" value="2026-10-12" onChange={() => {}} readOnly />,
}

/** A stored value that is no real day shows as not set; Remove clears it. */
export const DateOnlyImpossibleValue: StoryObj = {
  render: () => {
    const [value, setValue] = useState('2026-02-30')
    return <DateField label="Event date" value={value} onChange={setValue} />
  },
}

export const DateTime: StoryObj = {
  render: () => {
    const [value, setValue] = useState('2026-10-12T14:30:00.000Z')
    return <DateTimeField label="Published at" value={value} onChange={setValue} />
  },
}

/** A stored date-only value reads as local midnight on that day. */
export const DateOnlyValue: StoryObj = {
  render: () => {
    const [value, setValue] = useState('2026-10-12')
    return <DateTimeField label="Published on" value={value} onChange={setValue} />
  },
}

export const DateTimeReadOnly: StoryObj = {
  render: () => (
    <DateTimeField
      label="Published at"
      value="2026-10-12T14:30:00.000Z"
      onChange={() => {}}
      readOnly
    />
  ),
}

export const DateTimeStampOnPublish: StoryObj = {
  render: () => {
    const [value, setValue] = useState('')
    return <DateTimeField label="Published at" value={value} onChange={setValue} stampOnPublish />
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
