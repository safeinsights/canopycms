import type { Meta, StoryObj } from '@storybook/react'
import { Notification } from '@mantine/core'

import { SaveAllResultMessage } from './SaveAllResult'
import { SAVE_ALL_REASONS, invalidReason } from '../hooks/save-all'
import { unsafeAsLogicalPath } from '../../paths/test-utils'

const noop = () => {}

const meta: Meta<typeof SaveAllResultMessage> = {
  title: 'Editor/SaveAllResult',
  component: SaveAllResultMessage,
  args: { onOpenEntry: noop, onRetry: noop },
}

export default meta
type Story = StoryObj<typeof SaveAllResultMessage>

const saved = (label: string) => ({
  contentId: label,
  label,
  path: unsafeAsLogicalPath(`content/pages/${label}`),
})

/** As the toast shows it: red, since one entry failed for good. */
export const PartlyFailed: Story = {
  args: {
    result: {
      branch: 'feature/landing',
      total: 5,
      saved: [saved('Home'), saved('Our team')],
      failed: [
        {
          ...saved('About us'),
          kind: 'invalid',
          reason: invalidReason(2),
        },
        { ...saved('Contact'), kind: 'unanswered', reason: SAVE_ALL_REASONS.unanswered },
        {
          ...saved('Old news'),
          kind: 'conflict',
          reason: SAVE_ALL_REASONS.deleted,
          recreate: noop,
        },
      ],
    },
  },
  render: (args) => (
    <Notification color="red" title="3 of 5 entries not saved" withCloseButton maw={420}>
      <SaveAllResultMessage {...args} />
    </Notification>
  ),
}

/** Nothing lost yet, so yellow: no answer, and a change made elsewhere. */
export const PartlyUnsettled: Story = {
  args: {
    result: {
      branch: 'feature/landing',
      total: 3,
      saved: [saved('Home')],
      failed: [
        { ...saved('Contact'), kind: 'unanswered', reason: SAVE_ALL_REASONS.unanswered },
        { ...saved('About us'), kind: 'conflict', reason: SAVE_ALL_REASONS.staleBase },
      ],
    },
  },
  render: (args) => (
    <Notification color="yellow" title="2 of 3 entries not saved" withCloseButton maw={420}>
      <SaveAllResultMessage {...args} />
    </Notification>
  ),
}

/** Every entry saved: a short toast that closes itself. */
export const Done: Story = {
  args: {
    result: { branch: 'feature/landing', total: 3, saved: [], failed: [] },
  },
  render: () => (
    <Notification color="green" withCloseButton maw={420}>
      3 entries saved
    </Notification>
  ),
}
