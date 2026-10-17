import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import type { CropRect } from '../../assets/transform-directives'
import { CropStep } from './CropStep'

const meta: Meta<typeof CropStep> = {
  title: 'Editor/Media/Crop step',
  component: CropStep,
}

export default meta
type Story = StoryObj<typeof CropStep>

const GRADIENT =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='500'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%234f46e5'/%3E%3Cstop offset='1' stop-color='%2314b8a6'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='800' height='500' fill='url(%23g)'/%3E%3C/svg%3E"

const Step: React.FC<{ aspect?: number }> = ({ aspect }) => {
  const [confirmed, setConfirmed] = useState<CropRect | null>(null)
  return (
    <>
      <CropStep
        opened
        onClose={() => undefined}
        imageSrc={GRADIENT}
        aspect={aspect}
        onConfirm={setConfirmed}
      />
      {confirmed && <pre>{JSON.stringify(confirmed)}</pre>}
    </>
  )
}

/** A field without `aspect`: any rectangle, starting from the whole frame. */
export const Free: Story = { render: () => <Step /> }

/** A field with `aspect`: the box keeps its shape, starting centred. */
export const Locked: Story = { render: () => <Step aspect={16 / 9} /> }
