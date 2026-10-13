import type { Meta, StoryObj } from '@storybook/react'

import { CommentWriteAlert } from './CommentWriteAlert'
import { COMMENT_MAY_BE_ADDED, COMMENT_NOT_ADDED } from '../hooks/useCommentSystem'

const meta: Meta<typeof CommentWriteAlert> = {
  title: 'Editor/Comments/CommentWriteAlert',
  component: CommentWriteAlert,
  args: { onClose: () => {} },
}

export default meta
type Story = StoryObj<typeof CommentWriteAlert>

export const NotAdded: Story = {
  args: { failure: { message: COMMENT_NOT_ADDED, mayHaveLanded: false } },
}

export const MayHaveBeenPosted: Story = {
  args: { failure: { message: COMMENT_MAY_BE_ADDED, mayHaveLanded: true } },
}
