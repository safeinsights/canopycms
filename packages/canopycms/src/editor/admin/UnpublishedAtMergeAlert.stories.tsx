import type { Meta, StoryObj } from '@storybook/react'

import { DISMISS_UNPUBLISHED_ATTRIBUTE, UnpublishedAtMergeAlert } from './UnpublishedAtMergeAlert'

const meta: Meta<typeof UnpublishedAtMergeAlert> = {
  title: 'Editor/SystemHealth/UnpublishedAtMergeAlert',
  component: UnpublishedAtMergeAlert,
  args: { onDismiss: async () => {} },
}

export default meta
type Story = StoryObj<typeof UnpublishedAtMergeAlert>

const pullRequestUrl = 'https://github.com/owner/repo/pull/123'

export const OneBranch: Story = {
  args: { branches: [{ dirName: 'feature-a', name: 'canopycms/prod/feature-a', pullRequestUrl }] },
}

/** Several, one with a long unbroken name, which wraps and leaves Dismiss whole. */
export const SeveralBranches: Story = {
  args: {
    branches: [
      { dirName: 'feature-a', name: 'canopycms/prod/feature-a', pullRequestUrl },
      { dirName: 'feature-b', name: 'canopycms/prod/feature-b' },
      {
        dirName: 'long',
        name: `canopycms/prod/${'an_unbroken_branch_name_'.repeat(4)}`,
        pullRequestUrl,
      },
    ],
  },
}

/** At phone width, as System health runs full screen. */
export const Narrow: Story = {
  ...SeveralBranches,
  decorators: [(Story) => <div style={{ width: 358 }}>{Story()}</div>],
}

/** Asking, at phone width: the question and both of its buttons stay inside the alert. */
export const NarrowAsking: Story = {
  ...Narrow,
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLElement>(`[${DISMISS_UNPUBLISHED_ATTRIBUTE}]`)?.click()
  },
}
