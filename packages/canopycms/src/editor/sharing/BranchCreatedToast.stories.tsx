import React from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { Notification } from '@mantine/core'

import { BranchCreatedToast } from './BranchCreatedToast'

const meta: Meta<typeof BranchCreatedToast> = {
  title: 'Editor/BranchCreatedToast',
  component: BranchCreatedToast,
  args: { label: 'spring-update' },
  // On the surface it shows on: a green notification with its close button.
  decorators: [
    (Story) => (
      <Notification color="green" withCloseButton maw={440}>
        <Story />
      </Notification>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof BranchCreatedToast>

/** A create whose Branches drawer has closed: the toast says so and offers Share… for it. */
export const WithShare: Story = { args: { onShare: () => {} } }

/** The same toast where the new branch can't be shared from here. */
export const WithoutShare: Story = {}
