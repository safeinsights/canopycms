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
    entryId: 'posts/hello',
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
    entryId: 'posts/hello',
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
    threads: sampleThreads,
    autoFocus: false,
    onOpenThreadPanel: (canopyPath: string) => console.log('Open panel for:', canopyPath),
  },
}

export const WithResolvedComments: Story = {
  args: {
    children: <TextInput label="Title" placeholder="Enter title..." />,
    canopyPath: 'title',
    threads: resolvedThreads,
    autoFocus: false,
    onOpenThreadPanel: (canopyPath: string) => console.log('Open panel for:', canopyPath),
  },
}

export const NoComments: Story = {
  args: {
    children: <TextInput label="Description" placeholder="Enter description..." />,
    canopyPath: 'description',
    threads: [],
    autoFocus: false,
    onOpenThreadPanel: (canopyPath: string) => console.log('Open panel for:', canopyPath),
  },
}

export const AutoFocused: Story = {
  args: {
    children: <TextInput label="Title" placeholder="Enter title..." />,
    canopyPath: 'title',
    threads: sampleThreads,
    autoFocus: true,
    onOpenThreadPanel: (canopyPath: string) => console.log('Auto-opened panel for:', canopyPath),
  },
}

export const CustomColors: Story = {
  args: {
    children: <TextInput label="Title" placeholder="Enter title..." />,
    canopyPath: 'title',
    threads: sampleThreads,
    autoFocus: false,
    unresolvedColor: 'blue',
    resolvedColor: 'green',
    onOpenThreadPanel: (canopyPath: string) => console.log('Open panel for:', canopyPath),
  },
}
