import type { Meta, StoryObj } from '@storybook/react'
import { CommentsPanel } from './CommentsPanel'
import type { CommentThread } from '../comment-store'

const meta: Meta<typeof CommentsPanel> = {
  title: 'Editor/CommentsPanel',
  component: CommentsPanel,
  parameters: {
    layout: 'fullscreen',
  },
}

export default meta
type Story = StoryObj<typeof CommentsPanel>

const sampleThreads: CommentThread[] = [
  {
    id: 'thread-1',
    resolved: false,
    filePath: 'content/blog/intro.md',
    lineRange: { start: 15, end: 15 },
    comments: [
      {
        id: 'comment-1',
        threadId: 'thread-1',
        userId: 'alice',
        timestamp: new Date(Date.now() - 3600000).toISOString(),
        text: 'This heading should be more descriptive. What about "Getting Started with Our Platform"?',
        resolved: false,
        type: 'review',
        lineNumber: 15,
        filePath: 'content/blog/intro.md',
      },
      {
        id: 'comment-2',
        threadId: 'thread-1',
        userId: 'bob',
        timestamp: new Date(Date.now() - 1800000).toISOString(),
        text: "Good suggestion! I'll update it.",
        resolved: false,
        type: 'discussion',
      },
    ],
  },
  {
    id: 'thread-2',
    resolved: false,
    comments: [
      {
        id: 'comment-3',
        threadId: 'thread-2',
        userId: 'charlie',
        timestamp: new Date(Date.now() - 7200000).toISOString(),
        text: 'Please add alt text to all images before submitting.',
        resolved: false,
        type: 'discussion',
      },
    ],
  },
  {
    id: 'thread-3',
    resolved: true,
    filePath: 'content/pages/about.md',
    comments: [
      {
        id: 'comment-4',
        threadId: 'thread-3',
        userId: 'alice',
        timestamp: new Date(Date.now() - 86400000).toISOString(),
        text: 'Can we add a team photo here?',
        resolved: true,
        type: 'review',
        filePath: 'content/pages/about.md',
      },
      {
        id: 'comment-5',
        threadId: 'thread-3',
        userId: 'bob',
        timestamp: new Date(Date.now() - 43200000).toISOString(),
        text: 'Done! Added the photo from our last retreat.',
        resolved: true,
        type: 'discussion',
      },
    ],
  },
]

export const Default: Story = {
  args: {
    branchName: 'feature/new-content',
    comments: sampleThreads,
    canResolve: true,
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

export const Empty: Story = {
  args: {
    branchName: 'feature/empty-branch',
    comments: [],
    canResolve: true,
    onAddComment: async (text: string) => {
      console.log('Add comment:', text)
    },
    onResolveThread: async (threadId: string) => {
      console.log('Resolve thread:', threadId)
    },
    onClose: () => console.log('Close panel'),
  },
}

export const ViewerOnly: Story = {
  args: {
    branchName: 'feature/review-only',
    comments: sampleThreads,
    canResolve: false,
    onAddComment: async (text: string, threadId?: string) => {
      console.log('Add comment:', { text, threadId })
    },
    onResolveThread: async (threadId: string) => {
      console.log('Resolve thread (should not be called):', threadId)
    },
    onClose: () => console.log('Close panel'),
  },
}

export const ManyComments: Story = {
  args: {
    branchName: 'feature/active-discussion',
    comments: [
      ...sampleThreads,
      {
        id: 'thread-4',
        resolved: false,
        comments: [
          {
            id: 'comment-6',
            threadId: 'thread-4',
            userId: 'dan',
            timestamp: new Date(Date.now() - 600000).toISOString(),
            text: 'What about adding a call-to-action button at the end?',
            resolved: false,
            type: 'discussion',
          },
        ],
      },
      {
        id: 'thread-5',
        resolved: false,
        filePath: 'content/products/widget.md',
        lineRange: { start: 42, end: 45 },
        comments: [
          {
            id: 'comment-7',
            threadId: 'thread-5',
            userId: 'eve',
            timestamp: new Date(Date.now() - 300000).toISOString(),
            text: 'The pricing information here is outdated.',
            resolved: false,
            type: 'review',
            filePath: 'content/products/widget.md',
            lineNumber: 42,
          },
        ],
      },
    ],
    canResolve: true,
    onAddComment: async (text: string, threadId?: string) => {
      console.log('Add comment:', { text, threadId })
    },
    onResolveThread: async (threadId: string) => {
      console.log('Resolve thread:', threadId)
    },
    onClose: () => console.log('Close panel'),
  },
}
