import type { Meta, StoryObj } from '@storybook/react'

import { ConfirmDeleteModal } from './ConfirmDeleteModal'

const meta: Meta<typeof ConfirmDeleteModal> = {
  title: 'Editor/ConfirmDeleteModal',
  component: ConfirmDeleteModal,
  args: {
    isOpen: true,
    title: 'Delete entry',
    message: 'Delete "Hello world"? This cannot be undone.',
    confirmLabel: 'Delete entry',
    onConfirm: () => {},
    onClose: () => {},
  },
}

export default meta
type Story = StoryObj<typeof ConfirmDeleteModal>

export const Entry: Story = {}

export const Deleting: Story = {
  args: { loading: true },
}
