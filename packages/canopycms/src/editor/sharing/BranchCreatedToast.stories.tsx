import type { Meta, StoryObj } from '@storybook/react'

import { BranchCreatedToast } from './BranchCreatedToast'

const meta: Meta<typeof BranchCreatedToast> = {
  title: 'Editor/BranchCreatedToast',
  component: BranchCreatedToast,
  args: { label: 'spring-update' },
}

export default meta
type Story = StoryObj<typeof BranchCreatedToast>

/** A create whose Branches drawer has closed: the toast says so and offers Share… for it. */
export const WithShare: Story = { args: { onShare: () => {} } }

/** The same toast where the new branch can't be shared from here. */
export const WithoutShare: Story = {}
