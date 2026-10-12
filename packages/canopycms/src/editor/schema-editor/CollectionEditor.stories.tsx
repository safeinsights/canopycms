import type { Meta, StoryObj } from '@storybook/react'

import { CollectionEditor, type ExistingCollection } from './CollectionEditor'
import type { SchemaOpResult } from '../hooks/useSchemaManager'
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
