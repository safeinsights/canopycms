import type { Meta, StoryObj } from '@storybook/react'

import { BranchManager } from './BranchManager'

const meta: Meta<typeof BranchManager> = {
  title: 'Editor/BranchManager',
  component: BranchManager,
}

export default meta
type Story = StoryObj<typeof BranchManager>

export const Default: Story = {
  args: {
    branches: [
      { name: 'feature/landing', status: 'editing', updatedAt: 'today', access: { users: ['alice'], groups: ['team-marketing'] } },
      { name: 'feature/docs', status: 'submitted', updatedAt: 'yesterday', access: { users: ['bob'] } },
    ],
    onSelect: (name: string) => alert(`Open ${name}`),
    onSubmit: (name: string) => alert(`Submit ${name}`),
    onDelete: (name: string) => alert(`Delete ${name}`),
    onRequestChanges: (name: string) => alert(`Request changes on ${name}`),
  },
}
