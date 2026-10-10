import type { Meta, StoryObj } from '@storybook/react'

import { EditorHeader } from './EditorHeader'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../../paths/test-utils'
import type { CommentThread } from '../../comment-store'

const noop = () => {}

const openThread: CommentThread = {
  id: 'thread-1',
  type: 'entry',
  resolved: false,
  comments: [],
  createdAt: '2026-10-01T12:00:00Z',
  authorId: 'alice',
  entryPath: 'posts/hello',
}

const meta: Meta<typeof EditorHeader> = {
  title: 'Editor/EditorHeader',
  component: EditorHeader,
  args: {
    siteTitle: 'Example Site',
    headerTitle: 'Hello',
    currentEntry: {
      path: unsafeAsLogicalPath('posts/hello'),
      contentId: unsafeAsContentId('abc123def456'),
      label: 'Hello',
      schema: [],
    },
    branchName: 'feature/landing',
    operatingMode: 'prod',
    busy: false,
    breadcrumbSegments: ['Posts', 'Hello'],
    editedFiles: [],
    modifiedCount: 0,
    unresolvedCommentCount: 0,
    comments: [],
    onNavigatorOpen: noop,
    onFileReload: noop,
    onFileDiscardDraft: noop,
    onEntrySelect: noop,
    onBranchReloadData: noop,
    onBranchDiscardDrafts: noop,
    onBranchManagerOpen: noop,
    onCommentsPanelOpen: noop,
    onSave: noop,
    onSubmit: noop,
    onWithdraw: noop,
    hasUnsavedChanges: true,
    branchStatus: 'editing',
  },
}

export default meta
type Story = StoryObj<typeof EditorHeader>

export const Editing: Story = {
  args: { comments: [openThread], unresolvedCommentCount: 1 },
}

export const InReview: Story = {
  args: { branchStatus: 'submitted', branchWriteBlocked: true, hasUnsavedChanges: false },
}

export const ProtectedBaseBranch: Story = {
  args: {
    branchName: 'main',
    branchIsProtected: true,
    branchReadOnly: true,
    branchWriteBlocked: true,
    hasUnsavedChanges: false,
  },
}
