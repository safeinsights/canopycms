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
      {
        name: 'feature/landing',
        status: 'editing',
        updatedAt: 'today',
        access: { users: ['alice'], groups: ['team-marketing'] },
        commentCount: 3,
      },
      {
        name: 'feature/docs',
        status: 'submitted',
        updatedAt: 'yesterday',
        access: { users: ['bob'] },
        pullRequestUrl: 'https://github.com/owner/repo/pull/42',
        pullRequestNumber: 42,
        commentCount: 1,
      },
    ],
    onSelect: (name: string) => alert(`Open ${name}`),
    onCreate: (branch) => alert(`Create branch: ${branch.name}`),
    onSubmit: (name: string) => alert(`Submit ${name}`),
    onWithdraw: (name: string) => alert(`Withdraw ${name}`),
    onDelete: (name: string) => alert(`Delete ${name}`),
    onRequestChanges: (name: string) => alert(`Request changes on ${name}`),
  },
}

export const WithPullRequests: Story = {
  args: {
    branches: [
      {
        name: 'feature/new-homepage',
        status: 'editing',
        updatedAt: '2 hours ago',
        createdBy: 'alice',
        access: { users: ['alice'] },
      },
      {
        name: 'feature/dark-mode',
        status: 'submitted',
        updatedAt: '1 day ago',
        createdBy: 'bob',
        access: { users: ['bob'] },
        pullRequestUrl: 'https://github.com/owner/repo/pull/123',
        pullRequestNumber: 123,
        commentCount: 5,
      },
      {
        name: 'fix/navigation-bug',
        status: 'submitted',
        updatedAt: '3 days ago',
        createdBy: 'charlie',
        access: { users: ['charlie'] },
        pullRequestUrl: 'https://github.com/owner/repo/pull/118',
        pullRequestNumber: 118,
        commentCount: 0,
      },
    ],
    onSelect: (name: string) => console.log(`Open ${name}`),
    onCreate: (branch) => console.log(`Create branch:`, branch),
    onSubmit: (name: string) => console.log(`Submit ${name}`),
    onWithdraw: (name: string) => console.log(`Withdraw ${name}`),
    onDelete: (name: string) => console.log(`Delete ${name}`),
    onRequestChanges: (name: string) => console.log(`Request changes on ${name}`),
  },
}
