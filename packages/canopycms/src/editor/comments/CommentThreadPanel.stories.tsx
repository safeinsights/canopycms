import type { Meta, StoryObj } from '@storybook/react'
import { CommentThreadPanel } from './CommentThreadPanel'
import type { CommentThread } from '../../comment-store'
import { Box } from '@mantine/core'

const meta: Meta<typeof CommentThreadPanel> = {
  title: 'Editor/Comments/CommentThreadPanel',
  component: CommentThreadPanel,
  decorators: [
    (Story) => (
      <Box h={600} bg="gray.0" p="md">
        <Story />
      </Box>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof CommentThreadPanel>

const fieldThreads: CommentThread[] = [
  {
    id: 'thread-1',
    type: 'field',
    entryId: 'posts/hello',
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
        text: 'This title could be more engaging. What about "10 Ways to Boost Your Productivity"?',
      },
      {
        id: 'comment-2',
        threadId: 'thread-1',
        userId: 'bob',
        timestamp: new Date(Date.now() - 1800000).toISOString(),
        text: "Good idea! I'll update it.",
      },
    ],
  },
  {
    id: 'thread-2',
    type: 'field',
    entryId: 'posts/hello',
    canopyPath: 'title',
    authorId: 'charlie',
    resolved: true,
    createdAt: new Date(Date.now() - 7200000).toISOString(),
    resolvedBy: 'charlie',
    resolvedAt: new Date(Date.now() - 3600000).toISOString(),
    comments: [
      {
        id: 'comment-3',
        threadId: 'thread-2',
        userId: 'charlie',
        timestamp: new Date(Date.now() - 7200000).toISOString(),
        text: 'Should we capitalize "productivity"?',
      },
      {
        id: 'comment-4',
        threadId: 'thread-2',
        userId: 'alice',
        timestamp: new Date(Date.now() - 3600000).toISOString(),
        text: "No, it's correct as-is.",
      },
    ],
  },
]

export const FieldComments: Story = {
  args: {
    threads: fieldThreads,
    contextType: 'field',
    contextLabel: 'title',
    canResolve: true,
    currentUserId: 'alice',
    onAddComment: async (text: string, threadId?: string) => {
      console.log('Add comment:', { text, threadId })
      await new Promise((resolve) => setTimeout(resolve, 500))
    },
    onResolveThread: async (threadId: string) => {
      console.log('Resolve thread:', threadId)
      await new Promise((resolve) => setTimeout(resolve, 500))
    },
    onClose: () => console.log('Close panel'),
  },
}

export const EntryComments: Story = {
  args: {
    threads: [
      {
        id: 'thread-1',
        type: 'entry',
        entryId: 'posts/hello',
        authorId: 'alice',
        resolved: false,
        createdAt: new Date(Date.now() - 3600000).toISOString(),
        comments: [
          {
            id: 'comment-1',
            threadId: 'thread-1',
            userId: 'alice',
            timestamp: new Date(Date.now() - 3600000).toISOString(),
            text: 'Overall this post looks great! Just a few minor tweaks needed.',
          },
        ],
      },
    ],
    contextType: 'entry',
    contextLabel: 'posts/hello',
    canResolve: true,
    currentUserId: 'alice',
    onAddComment: async (text: string, threadId?: string) => {
      console.log('Add comment:', { text, threadId })
    },
    onResolveThread: async (threadId: string) => {
      console.log('Resolve thread:', threadId)
    },
    onClose: () => console.log('Close panel'),
  },
}

export const BranchComments: Story = {
  args: {
    threads: [
      {
        id: 'thread-1',
        type: 'branch',
        authorId: 'bob',
        resolved: false,
        createdAt: new Date(Date.now() - 7200000).toISOString(),
        comments: [
          {
            id: 'comment-1',
            threadId: 'thread-1',
            userId: 'bob',
            timestamp: new Date(Date.now() - 7200000).toISOString(),
            text: "This branch is ready for review. I've updated all the blog posts as requested.",
          },
          {
            id: 'comment-2',
            threadId: 'thread-1',
            userId: 'alice',
            timestamp: new Date(Date.now() - 3600000).toISOString(),
            text: "Thanks! I'll take a look today.",
          },
        ],
      },
    ],
    contextType: 'branch',
    contextLabel: 'feature/update-blog-posts',
    canResolve: true,
    currentUserId: 'alice',
    onAddComment: async (text: string, threadId?: string) => {
      console.log('Add comment:', { text, threadId })
    },
    onResolveThread: async (threadId: string) => {
      console.log('Resolve thread:', threadId)
    },
    onClose: () => console.log('Close panel'),
  },
}

export const NoComments: Story = {
  args: {
    threads: [],
    contextType: 'field',
    contextLabel: 'description',
    canResolve: true,
    currentUserId: 'alice',
    onAddComment: async (text: string) => {
      console.log('Add comment:', text)
    },
    onResolveThread: async (threadId: string) => {
      console.log('Resolve thread:', threadId)
    },
    onClose: () => console.log('Close panel'),
  },
}

export const CannotResolve: Story = {
  args: {
    threads: fieldThreads,
    contextType: 'field',
    contextLabel: 'title',
    canResolve: false,
    currentUserId: 'viewer',
    onAddComment: async (text: string, threadId?: string) => {
      console.log('Add comment:', { text, threadId })
    },
    onResolveThread: async (threadId: string) => {
      console.log('Resolve thread (should not be called):', threadId)
    },
    onClose: () => console.log('Close panel'),
  },
}
