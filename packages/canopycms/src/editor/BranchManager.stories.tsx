import type { Meta, StoryObj } from '@storybook/react'

import { BranchManager } from './BranchManager'
import type { BranchSummary } from './BranchManager'
import { RESERVED_GROUPS } from '../authorization/helpers'

const meta: Meta<typeof BranchManager> = {
  title: 'Editor/BranchManager',
  component: BranchManager,
  args: { mode: 'prod', user: { userId: 'alice', groups: [] } },
}

export default meta
type Story = StoryObj<typeof BranchManager>

export const Default: Story = {
  args: {
    branches: [
      {
        name: 'main',
        status: 'editing',
        updatedAt: 'today',
        access: {},
        isProtected: true,
      },
      {
        name: 'feature/landing',
        status: 'editing',
        updatedAt: 'today',
        createdBy: 'alice',
        access: { users: ['alice'], groups: ['team-marketing'] },
        commentCount: 3,
        submitBlocked: false,
      },
      {
        name: 'feature/docs',
        status: 'submitted',
        updatedAt: 'yesterday',
        createdBy: 'bob',
        access: { users: ['bob'] },
        pullRequestUrl: 'https://github.com/owner/repo/pull/42',
        pullRequestNumber: 42,
        commentCount: 1,
      },
    ],
    currentBranchName: 'feature/landing',
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
        submitBlocked: false,
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

/** A branch CanopyCMS provisioned shows its owner as "CanopyCMS bot", with no lookup. */
export const WithBotOwner: Story = {
  args: {
    ...Default.args,
    branches: [
      {
        name: 'feature/auto',
        status: 'editing',
        updatedAt: 'today',
        access: {},
        createdBy: 'canopycms-system',
      },
      {
        name: 'feature/landing',
        status: 'editing',
        updatedAt: 'today',
        access: {},
        createdBy: 'alice',
        submitBlocked: false,
      },
    ],
    onGetUserMetadata: async (userId: string) =>
      userId === 'alice'
        ? { id: 'alice', name: 'Alice Johnson', email: 'alice@example.com' }
        : null,
  },
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const HOUR = 3600 * 1000
const DAY = 24 * HOUR

const reviewBranches: BranchSummary[] = [
  {
    name: 'main',
    status: 'editing',
    updatedAt: ago(40 * DAY),
    createdBy: 'canopycms-system',
    access: {},
    isProtected: true,
    submitBlocked: true,
  },
  {
    name: 'feature/landing',
    status: 'editing',
    updatedAt: ago(2 * HOUR),
    createdBy: 'alice',
    access: { users: ['alice'] },
    commentCount: 3,
    submitBlocked: false,
  },
  {
    name: 'feature/docs',
    status: 'submitted',
    updatedAt: ago(DAY),
    createdBy: 'bob',
    access: { users: ['bob'] },
    pullRequestUrl: 'https://github.com/owner/repo/pull/42',
    pullRequestNumber: 42,
    pullRequestState: 'open',
    submitBlocked: true,
  },
  {
    name: 'fix/footer',
    status: 'submitted',
    updatedAt: ago(9 * DAY),
    createdBy: 'alice',
    access: { users: ['alice'] },
    pullRequestUrl: 'https://github.com/owner/repo/pull/37',
    pullRequestNumber: 37,
    pullRequestState: 'closed',
    submitBlocked: true,
  },
  {
    name: 'release/2026-03',
    status: 'archived',
    updatedAt: ago(75 * DAY),
    createdBy: 'alice',
    access: { users: ['alice'] },
    pullRequestNumber: 30,
    pullRequestState: 'merged',
    mergedAt: ago(75 * DAY),
    submitBlocked: true,
  },
]

const logged = {
  onSelect: (name: string) => console.log(`Open ${name}`),
  onCreate: (branch: { name: string }) => console.log('Create branch:', branch),
  onSubmit: (name: string) => console.log(`Submit ${name}`),
  onWithdraw: (name: string) => console.log(`Withdraw ${name}`),
  onDelete: (name: string) => console.log(`Delete ${name}`),
  onRequestChanges: (name: string) => console.log(`Request changes on ${name}`),
}

/**
 * Alice has her own branch open: it is listed first and offers Submit for review. Every other
 * branch offers Open, and the "…" menu holds the rest, with a reason on any item that cannot act.
 */
export const CurrentBranchAndMenu: Story = {
  args: {
    ...logged,
    branches: reviewBranches,
    currentBranchName: 'feature/landing',
    user: { userId: 'alice', groups: [] },
  },
}

/** A reviewer with a branch in review open: Withdraw from review on the card, Request changes in the menu. */
export const ReviewerView: Story = {
  args: {
    ...logged,
    branches: reviewBranches,
    currentBranchName: 'feature/docs',
    user: { userId: 'rita', groups: [RESERVED_GROUPS.REVIEWERS] },
  },
}
