import type { Meta, StoryObj } from '@storybook/react'
import { FieldWrapper } from './FieldWrapper'
import type { CommentThread } from '../../comment-store'
import { TextInput, Box } from '@mantine/core'

const meta: Meta<typeof FieldWrapper> = {
  title: 'Editor/Comments/FieldWrapper',
  component: FieldWrapper,
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

export const WithUnresolvedComments: Story = {
  args: {
    children: <TextInput label="Title" placeholder="Enter title..." />,
    canopyPath: 'title',
    entryPath: 'posts/hello',
    threads: sampleThreads,
    autoFocus: false,
    currentUserId: 'alice',
    canResolve: true,
    onAddComment: async (text: string, type: string, entryPath?: string, canopyPath?: string, threadId?: string) => {
      console.log('Add comment:', { text, type, entryPath, canopyPath, threadId })
      await new Promise((resolve) => setTimeout(resolve, 500))
    },
    onResolveThread: async (threadId: string) => {
      console.log('Resolve thread:', threadId)
      await new Promise((resolve) => setTimeout(resolve, 500))
    },
  },
}

export const WithResolvedComments: Story = {
  args: {
    children: <TextInput label="Title" placeholder="Enter title..." />,
    canopyPath: 'title',
    entryPath: 'posts/hello',
    threads: resolvedThreads,
    autoFocus: false,
    currentUserId: 'alice',
    canResolve: true,
    onAddComment: async (text: string, type: string, entryPath?: string, canopyPath?: string, threadId?: string) => {
      console.log('Add comment:', { text, type, entryPath, canopyPath, threadId })
    },
    onResolveThread: async (threadId: string) => {
      console.log('Resolve thread:', threadId)
    },
  },
}

export const NoComments: Story = {
  args: {
    children: <TextInput label="Description" placeholder="Enter description..." />,
    canopyPath: 'description',
    entryPath: 'posts/hello',
    threads: [],
    autoFocus: false,
    currentUserId: 'alice',
    canResolve: true,
    onAddComment: async (text: string, type: string, entryPath?: string, canopyPath?: string, threadId?: string) => {
      console.log('Add comment:', { text, type, entryPath, canopyPath, threadId })
    },
    onResolveThread: async (threadId: string) => {
      console.log('Resolve thread:', threadId)
    },
  },
}

export const AutoFocused: Story = {
  args: {
    children: <TextInput label="Title" placeholder="Enter title..." />,
    canopyPath: 'title',
    entryPath: 'posts/hello',
    threads: sampleThreads,
    autoFocus: true,
    currentUserId: 'alice',
    canResolve: true,
    onAddComment: async (text: string, type: string, entryPath?: string, canopyPath?: string, threadId?: string) => {
      console.log('Add comment:', { text, type, entryPath, canopyPath, threadId })
    },
    onResolveThread: async (threadId: string) => {
      console.log('Resolve thread:', threadId)
    },
  },
}
