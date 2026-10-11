import type { Meta, StoryObj } from '@storybook/react'
import { FieldWrapper } from './FieldWrapper'
import type { CommentThread } from '../../comment-store'
import { Box } from '@mantine/core'
import { TextField } from '../fields/TextField'

const meta: Meta<typeof FieldWrapper> = {
  title: 'Editor/Comments/FieldWrapper',
  component: FieldWrapper,
  args: {
    canopyPath: 'title',
    entryPath: 'posts/hello',
    fieldLabel: 'Title',
    resetKey: 'main\nposts/hello',
    currentUserId: 'alice',
    canResolve: true,
    children: (
      <TextField label="Title" value="Hello world" onChange={() => {}} dataCanopyField="title" />
    ),
    onAddComment: async (text, type, entryPath, canopyPath, threadId) => {
      console.log('Add comment:', { text, type, entryPath, canopyPath, threadId })
      await new Promise((resolve) => setTimeout(resolve, 500))
    },
    onResolveThread: async (threadId) => {
      console.log('Resolve thread:', threadId)
      await new Promise((resolve) => setTimeout(resolve, 500))
    },
  },
  decorators: [
    (Story) => (
      <Box p="xl" bg="gray.0">
        <Story />
      </Box>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof FieldWrapper>

const sampleThreads: CommentThread[] = [
  {
    id: 'thread-1',
    type: 'field',
    entryPath: 'posts/hello',
    canopyPath: 'title',
    authorId: 'alice',
    resolved: false,
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    comments: [
      {
        id: 'comment-1',
        threadId: 'thread-1',
        userId: 'alice',
        timestamp: new Date(Date.now() - 3600000).toISOString(),
        text: 'This title needs work.',
      },
      {
        id: 'comment-2',
        threadId: 'thread-1',
        userId: 'bob',
        timestamp: new Date(Date.now() - 1800000).toISOString(),
        text: 'I agree, let me revise it.',
      },
    ],
  },
  {
    id: 'thread-2',
    type: 'field',
    entryPath: 'posts/hello',
    canopyPath: 'title',
    authorId: 'charlie',
    resolved: false,
    createdAt: new Date(Date.now() - 7200000).toISOString(),
    comments: [
      {
        id: 'comment-3',
        threadId: 'thread-2',
        userId: 'charlie',
        timestamp: new Date(Date.now() - 7200000).toISOString(),
        text: 'Another concern here.',
      },
    ],
  },
]

const resolvedThreads: CommentThread[] = [
  {
    id: 'thread-3',
    type: 'field',
    entryPath: 'posts/hello',
    canopyPath: 'title',
    authorId: 'alice',
    resolved: true,
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    resolvedBy: 'bob',
    resolvedAt: new Date(Date.now() - 43200000).toISOString(),
    comments: [
      {
        id: 'comment-4',
        threadId: 'thread-3',
        userId: 'alice',
        timestamp: new Date(Date.now() - 86400000).toISOString(),
        text: 'Fixed now!',
      },
    ],
  },
]

/** No threads: the comment icon after the label shows only while the field is hovered or focused. */
export const NoComments: Story = {
  args: { threads: [] },
}

/** Open threads: a persistent count badge after the label. */
export const WithOpenThreads: Story = {
  args: { threads: sampleThreads },
}

/** Only resolved threads: no badge, but a plain icon stays in view and the popover lists them. */
export const WithResolvedThreads: Story = {
  args: { threads: resolvedThreads },
}

/** The popover open on a thread, as "Jump to field" from the Comments panel opens it. */
export const PopoverOpen: Story = {
  args: { threads: [...sampleThreads, ...resolvedThreads], highlightThreadId: 'thread-1' },
  decorators: [
    (Story) => (
      <Box pb={520}>
        <Story />
      </Box>
    ),
  ],
}

/** Focused from a preview click: scrolled into view and outlined. */
export const AutoFocused: Story = {
  args: { threads: sampleThreads, autoFocus: true },
}
