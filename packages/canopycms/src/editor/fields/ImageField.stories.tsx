import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import type { ImageFieldValue } from '../../config'
import { ImageField } from './ImageField'

const meta: Meta<typeof ImageField> = {
  title: 'Editor/Fields/Image',
  component: ImageField,
}

export default meta
type Story = StoryObj<typeof ImageField>

const GRADIENT =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='400'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%234f46e5'/%3E%3Cstop offset='1' stop-color='%2314b8a6'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='600' height='400' fill='url(%23g)'/%3E%3C/svg%3E"

/** A file the media library doesn't hold, so Crop is disabled with its reason. */
const outsideLibrary: ImageFieldValue = { src: GRADIENT, alt: 'A gradient' }

const Field: React.FC<{
  label: string
  initial?: ImageFieldValue
  readOnly?: boolean
  field: string
}> = ({ label, initial, readOnly = false, field }) => {
  const [value, setValue] = useState(initial)
  return (
    <ImageField
      label={label}
      dataCanopyField={field}
      value={value}
      onChange={setValue}
      readOnly={readOnly}
    />
  )
}

export const Empty: Story = { render: () => <Field label="Hero image" field="empty" /> }

/** Focus or hover Crop for its reason. */
export const CropDisabled: Story = {
  render: () => <Field label="Hero image" field="disabled" initial={outsideLibrary} />,
}

export const ReadOnly: Story = {
  render: () => <Field label="Hero image" field="readonly" initial={outsideLibrary} readOnly />,
}

/** Each card keeps its own actions, so none can be read as belonging to its neighbour. */
export const TwoInARow: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16, maxWidth: 480 }}>
      <Field label="Hero image" field="first" initial={outsideLibrary} />
      <Field label="Banner image" field="second" initial={outsideLibrary} />
    </div>
  ),
}

/** A narrow form column: the actions wrap under the label instead of crushing it. */
export const NarrowColumn: Story = {
  render: () => (
    <div style={{ width: 300 }}>
      <Field label="Hero image" field="narrow" initial={outsideLibrary} />
    </div>
  ),
}
