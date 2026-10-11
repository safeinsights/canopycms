import type { Meta, StoryObj } from '@storybook/react'
import { Notification } from '@mantine/core'

import { UndoToastMessage } from './UndoToastMessage'

const meta: Meta<typeof UndoToastMessage> = {
  title: 'Editor/UndoToastMessage',
  component: UndoToastMessage,
  args: { label: 'Key features #2', onUndo: () => {} },
  decorators: [
    (Story) => (
      <Notification withCloseButton style={{ maxWidth: 420 }}>
        <Story />
      </Notification>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof UndoToastMessage>

/** As the toast a form Remove raises shows it. */
export const AfterRemove: Story = {}
