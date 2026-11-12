import type { Meta, StoryObj } from '@storybook/react'
import { Box, Notification } from '@mantine/core'

import { BaseUpdateNotice } from './BaseUpdateNotice'
import { RetryToastMessage } from './RetryToastMessage'
import { baseUpdateResultMessage } from '../base-update-wait'

const meta: Meta<typeof BaseUpdateNotice> = {
  title: 'Editor/BaseUpdateNotice',
  component: BaseUpdateNotice,
  decorators: [
    (Story) => (
      <Box maw={640} p="md">
        <Story />
      </Box>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof BaseUpdateNotice>

/** Above the form while it is read-only, for the first two minutes of the wait. */
export const Waiting: Story = { args: { wait: 'waiting' } }

/** A viewer with an unsaved draft, which the read-only form hides until it finishes. */
export const WaitingWithDraft: Story = { args: { wait: 'waiting', hidesDraft: true } }

/** After two minutes the form is editable again, and the notice turns yellow. */
export const Slow: Story = { args: { wait: 'slow' } }

const at = '2026-01-01T00:00:00.000Z'
const toast = (answer: Parameters<typeof baseUpdateResultMessage>[0]) => {
  const { color, message } = baseUpdateResultMessage(answer)
  return (
    <Notification color={color} withCloseButton style={{ maxWidth: 420 }}>
      {answer.outcome === 'failed' ? (
        <RetryToastMessage message={message} onRetry={() => {}} />
      ) : (
        message
      )}
    </Notification>
  )
}

/** The toasts an answer gets: added, already current, entries that kept your version, failed. */
export const ResultToasts: Story = {
  render: () => (
    <Box style={{ display: 'grid', gap: 12 }}>
      {toast({ at, outcome: 'merged' })}
      {toast({ at, outcome: 'up-to-date' })}
      {toast({ at, outcome: 'conflicts', keptEntries: 2 })}
      {toast({ at, outcome: 'failed' })}
    </Box>
  ),
}
