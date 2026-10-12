import type { Meta, StoryObj } from '@storybook/react'
import { Notification } from '@mantine/core'

import { REQUEST_TIMED_OUT_MESSAGE } from '../../api/request-deadline'
import { RetryToastMessage } from './RetryToastMessage'

const meta: Meta<typeof RetryToastMessage> = {
  title: 'Editor/RetryToastMessage',
  component: RetryToastMessage,
  args: { message: REQUEST_TIMED_OUT_MESSAGE, onRetry: () => {} },
  decorators: [
    (Story) => (
      <Notification
        color="red"
        title="Could not load content"
        withCloseButton
        style={{ maxWidth: 420 }}
      >
        <Story />
      </Notification>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof RetryToastMessage>

/** As the content tree's load-failure toast shows a timed-out load. */
export const TimedOut: Story = {}
