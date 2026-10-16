import type { Meta, StoryObj } from '@storybook/react'

import {
  CollectionEditor,
  type ExistingCollection,
  type ExistingEntryType,
} from './CollectionEditor'
import type { SchemaOpResult } from '../hooks/useSchemaManager'
import { WRITE_TIMED_OUT_MESSAGE } from '../../api/client'
import { unsafeAsLogicalPath } from '../../paths/test-utils'

const meta: Meta<typeof CollectionEditor> = {
  title: 'Editor/Schema/CollectionEditor',
  component: CollectionEditor,
  args: {
    isOpen: true,
    availableSchemas: ['postSchema', 'pageSchema', 'authorSchema'],
    onSave: () => {},
    onClose: () => {},
  },
}

export default meta
type Story = StoryObj<typeof CollectionEditor>

const collection: ExistingCollection = {
  name: 'posts',
  label: 'Blog posts',
  logicalPath: unsafeAsLogicalPath('posts'),
  entries: [
    {
      name: 'post',
      label: 'Post',
      format: 'mdx',
      schema: 'postSchema',
      default: true,
      usageCount: 3,
    },
    { name: 'featured', label: 'Featured', format: 'json', schema: 'postSchema', usageCount: 0 },
  ],
}

// Resolves after a pause so the in-flight state and the status line can be seen.
const savesAfterAPause = async (): Promise<SchemaOpResult> => {
  await new Promise((resolve) => setTimeout(resolve, 400))
  return { ok: true }
}

// Ends as a write a gateway gave up on: unanswered, so it may have landed.
const goesUnanswered = async (): Promise<SchemaOpResult> => {
  await new Promise((resolve) => setTimeout(resolve, 400))
  return { ok: false, error: WRITE_TIMED_OUT_MESSAGE, unanswered: true }
}

export const Create: Story = {
  args: { editingCollection: null },
}

// The dismiss button reads "Cancel", "Discard changes" once the details are edited, and "Close"
// after an entry-type change saves. "post" is in use, so its Remove is blocked with a reason.
export const Edit: Story = {
  args: {
    editingCollection: collection,
    onAddEntryType: savesAfterAPause,
    onUpdateEntryType: savesAfterAPause,
    onRemoveEntryType: savesAfterAPause,
  },
}

export const EditWithError: Story = {
  args: {
    editingCollection: collection,
    error: 'Could not save the collection: the branch changed. Reload and try again.',
  },
}

// Every entry-type action goes unanswered, then the list is re-read: it has "featured" gone and
// "page" added as the form's defaults send it (JSON, postSchema, no label). Removing "featured" or
// adding "page" with those defaults reads as done; any other add, or an edit that changes
// something, stays unsettled and keeps its dialog open.
export const EditUnanswered: Story = {
  args: {
    editingCollection: collection,
    onAddEntryType: goesUnanswered,
    onUpdateEntryType: goesUnanswered,
    onRemoveEntryType: goesUnanswered,
    onReloadEntryTypes: async () => [
      collection.entries[0] as ExistingEntryType,
      { name: 'page', format: 'json', schema: 'postSchema', usageCount: 0 },
    ],
  },
}

// A create the server never answered and the content tree doesn't show, filled in again.
export const CreateRestored: Story = {
  args: {
    editingCollection: null,
    restored: {
      name: 'notes',
      label: 'Notes',
      entries: [{ name: 'note', format: 'json', schema: 'postSchema' }],
    },
    onDiscardRestored: () => {},
  },
}

// The footer's "Discard changes" drops the refilled details save's kept input too.
export const EditRestored: Story = {
  args: {
    editingCollection: collection,
    restored: { label: 'Articles', slug: 'articles' },
    onDiscardRestored: () => {},
  },
}

export const CreateWithStagedTypes: Story = {
  args: {
    editingCollection: null,
    restored: {
      name: 'notes',
      entries: [
        { name: 'note', format: 'json', schema: 'postSchema' },
        { name: 'memo', format: 'mdx', schema: 'pageSchema' },
      ],
    },
  },
}
