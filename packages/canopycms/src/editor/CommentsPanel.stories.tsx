import type { Meta, StoryObj } from '@storybook/react'
import { CommentsPanel } from './CommentsPanel'
import type { CommentThread } from '../comment-store'

const meta: Meta<typeof CommentsPanel> = {
  title: 'Editor/CommentsPanel',
  component: CommentsPanel,
  args: { opened: true },
  parameters: {
    layout: 'fullscreen',
  },
}

export default meta
type Story = StoryObj<typeof CommentsPanel>

const sampleThreads: CommentThread[] = [
  {
    id: 'thread-1',
    type: 'field',
    entryPath: 'blog/intro',
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
        text: 'This heading should be more descriptive. What about "Getting Started with Our Platform"?',
      },
      {
        id: 'comment-2',
        threadId: 'thread-1',
        userId: 'bob',
        timestamp: new Date(Date.now() - 1800000).toISOString(),
        text: "Good suggestion! I'll update it.",
      },
    ],
  },
  {
    id: 'thread-2',
    type: 'entry',
    entryPath: 'blog/intro',
    authorId: 'charlie',
    resolved: false,
    createdAt: new Date(Date.now() - 7200000).toISOString(),
    comments: [
      {
        id: 'comment-3',
        threadId: 'thread-2',
        userId: 'charlie',
        timestamp: new Date(Date.now() - 7200000).toISOString(),
        text: 'Please add alt text to all images before submitting.',
      },
    ],
  },
  {
    id: 'thread-3',
    type: 'field',
    entryPath: 'pages/about',
    canopyPath: 'hero.image',
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
        text: 'Can we add a team photo here?',
      },
      {
        id: 'comment-5',
        threadId: 'thread-3',
        userId: 'bob',
        timestamp: new Date(Date.now() - 43200000).toISOString(),
        text: 'Done! Added the photo from our last retreat.',
      },
    ],
  },
]

const entryLabels: Record<string, string> = {
  'blog/intro': 'Getting started',
  'pages/about': 'About us',
  'products/widget': 'Widget',
}
const fieldLabels: Record<string, string> = {
  title: 'Title',
  'hero.image': 'Page sections › Hero › Image',
  'pricing.monthly': 'Pricing › Monthly price',
}

export const Default: Story = {
  args: {
    branchName: 'feature/new-content',
    comments: sampleThreads,
    canResolve: true,
    currentUserId: 'alice',
    onAddComment: async (text, type, entryPath, canopyPath, threadId) => {
      console.log('Add comment:', { text, type, entryPath, canopyPath, threadId })
      await new Promise((resolve) => setTimeout(resolve, 500))
    },
    onResolveThread: async (threadId: string) => {
      console.log('Resolve thread:', threadId)
      await new Promise((resolve) => setTimeout(resolve, 500))
    },
    onClose: () => console.log('Close panel'),
    entryLabel: (entryPath) => entryLabels[entryPath],
    fieldLabel: (thread) => fieldLabels[thread.canopyPath ?? ''],
  },
}

// As the comments response names them, without email; `charlie` is one it could not name.
const namedUsers: Record<string, { id: string; name: string; email: string }> = {
  alice: { id: 'alice', name: 'Alice Johnson', email: '' },
  bob: { id: 'bob', name: 'Bob Lee', email: '' },
}

export const WithNames: Story = {
  args: {
    ...Default.args,
    onGetUserMetadata: async (userId: string) => namedUsers[userId] ?? null,
  },
}

export const Empty: Story = {
  args: {
    branchName: 'feature/empty-branch',
    comments: [],
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

/** A user who cannot resolve any thread still resolves the ones they started (Alice's). */
export const ViewerOnly: Story = {
  args: {
    branchName: 'feature/review-only',
    comments: sampleThreads,
    canResolve: false,
    currentUserId: 'alice',
    onAddComment: async (text, type, entryPath, canopyPath, threadId) => {
      console.log('Add comment:', { text, type, entryPath, canopyPath, threadId })
    },
    onResolveThread: async (threadId: string) => {
      console.log('Resolve thread (should not be called):', threadId)
    },
    onClose: () => console.log('Close panel'),
  },
}

/** Several open threads: each shows a Reply button; the box opens in place. */
export const ManyComments: Story = {
  args: {
    branchName: 'feature/active-discussion',
    comments: [
      ...sampleThreads,
      {
        id: 'thread-4',
        type: 'branch',
        authorId: 'dan',
        resolved: false,
        createdAt: new Date(Date.now() - 600000).toISOString(),
        comments: [
          {
            id: 'comment-6',
            threadId: 'thread-4',
            userId: 'dan',
            timestamp: new Date(Date.now() - 600000).toISOString(),
            text: 'What about adding a call-to-action button at the end?',
          },
        ],
      },
      {
        id: 'thread-5',
        type: 'field',
        entryPath: 'products/widget',
        canopyPath: 'pricing.monthly',
        authorId: 'eve',
        resolved: false,
        createdAt: new Date(Date.now() - 300000).toISOString(),
        comments: [
          {
            id: 'comment-7',
            threadId: 'thread-5',
            userId: 'eve',
            timestamp: new Date(Date.now() - 300000).toISOString(),
            text: 'The pricing information here is outdated.',
          },
        ],
      },
    ],
    canResolve: true,
    currentUserId: 'alice',
    onAddComment: async (text, type, entryPath, canopyPath, threadId) => {
      console.log('Add comment:', { text, type, entryPath, canopyPath, threadId })
    },
    onResolveThread: async (threadId: string) => {
      console.log('Resolve thread:', threadId)
    },
    onClose: () => console.log('Close panel'),
  },
}

/** Threads named by entry and field titles instead of their paths. */
export const HumanLabels: Story = {
  args: {
    ...Default.args,
    comments: [
      ...sampleThreads,
      {
        id: 'thread-4',
        type: 'branch',
        authorId: 'dan',
        resolved: false,
        createdAt: new Date(Date.now() - 600000).toISOString(),
        comments: [
          {
            id: 'comment-6',
            threadId: 'thread-4',
            userId: 'dan',
            timestamp: new Date(Date.now() - 600000).toISOString(),
            text: 'What about adding a call-to-action button at the end?',
          },
        ],
      },
    ],
    entryLabel: (entryPath) => entryLabels[entryPath],
    fieldLabel: (thread) => fieldLabels[thread.canopyPath ?? ''],
  },
}

/** Each open thread offers the jump its kind allows, and the branch thread its discussion. */
export const WithJumpButtons: Story = {
  args: {
    ...HumanLabels.args,
    onJumpToField: (entryPath, canopyPath, threadId) =>
      console.log('Jump to field:', { entryPath, canopyPath, threadId }),
    onJumpToEntry: (entryPath, threadId) => console.log('Jump to entry:', { entryPath, threadId }),
    onJumpToBranch: (threadId) => console.log('Open branch discussion:', threadId),
  },
}

async function typeInto(textarea: HTMLTextAreaElement, text: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setValue?.call(textarea, text)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** A comment write that never settles: the jumps are blocked, and closing the drawer says why it stays. */
export const WriteInFlight: Story = {
  args: {
    ...WithJumpButtons.args,
    onAddComment: () => new Promise<void>(() => {}),
  },
  play: async () => {
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="comment-textarea"]')
    if (!textarea) return
    await typeInto(textarea, 'Waiting on the server')
    document.querySelector<HTMLButtonElement>('[data-testid="comment-submit"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    document.querySelector<HTMLButtonElement>('.mantine-Drawer-close')?.click()
  },
}
