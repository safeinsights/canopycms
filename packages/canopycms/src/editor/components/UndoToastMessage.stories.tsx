import type { Meta, StoryObj } from '@storybook/react'
import { Notification } from '@mantine/core'

import { UndoToastMessage } from './UndoToastMessage'

const meta: Meta<typeof UndoToastMessage> = {
  title: 'Editor/UndoToastMessage',
  component: UndoToastMessage,
  args: { label: '"Typed" from Key features', onUndo: () => {} },
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

/** A removed item that had open comments says where they went. */
export const AfterRemoveWithComments: Story = {
  args: { note: 'Its 2 comments moved to "Comment on this entry".' },
}
