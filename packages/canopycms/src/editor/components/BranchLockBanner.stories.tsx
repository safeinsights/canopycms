import type { Meta, StoryObj } from '@storybook/react'

import { BranchLockBanner } from './BranchLockBanner'

const meta: Meta<typeof BranchLockBanner> = {
  title: 'Editor/BranchLockBanner',
  component: BranchLockBanner,
  args: { branchName: 'feature/landing', onBranchManagerOpen: () => {} },
}

export default meta
type Story = StoryObj<typeof BranchLockBanner>

export const ProtectedBaseBranch: Story = {
  args: {
    branchName: 'main',
    branchStatus: 'editing',
    branchReadOnly: true,
    branchWriteBlocked: true,
  },
}

export const InReview: Story = {
  args: { branchStatus: 'submitted', branchWriteBlocked: true },
}

export const DetailsUnavailable: Story = {
  args: { branchStatus: undefined, branchWriteBlocked: true },
}

/** Nothing renders on an editable branch. */
export const Editable: Story = {
  args: { branchStatus: 'editing', branchWriteBlocked: false },
}
