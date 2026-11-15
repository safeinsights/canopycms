import type { Meta, StoryObj } from '@storybook/react'

import { ConflictsStatusAlert } from './ConflictsStatusAlert'

const meta: Meta<typeof ConflictsStatusAlert> = {
  title: 'Editor/SystemHealth/ConflictsStatusAlert',
  component: ConflictsStatusAlert,
}

export default meta
type Story = StoryObj<typeof ConflictsStatusAlert>

const at = new Date(Date.now() - 4 * 60_000).toISOString()

/** The GitHub App has not been granted the new permission yet. */
export const PermissionMissing: Story = {
  args: {
    failure: {
      reason: 'permission',
      message: 'Resource not accessible by integration',
      branches: ['canopycms/prod/spring-launch', 'canopycms/prod/pricing'],
      count: 2,
      at,
    },
  },
}

export const GitHubUnreachable: Story = {
  args: {
    failure: {
      reason: 'unreachable',
      message: 'connect ETIMEDOUT',
      branches: ['canopycms/prod/spring-launch'],
      count: 1,
      at,
    },
  },
}

/** More branches than the report lists, one with a long unbroken name. */
export const ManyBranches: Story = {
  args: {
    failure: {
      reason: 'other',
      message: 'Validation Failed',
      branches: [
        'canopycms/prod/spring-launch',
        `canopycms/prod/${'an_unbroken_branch_name_'.repeat(4)}`,
      ],
      count: 7,
      at,
    },
  },
}

/** At phone width, as System health runs full screen. */
export const Narrow: Story = {
  ...PermissionMissing,
  decorators: [(Story) => <div style={{ width: 358 }}>{Story()}</div>],
}
