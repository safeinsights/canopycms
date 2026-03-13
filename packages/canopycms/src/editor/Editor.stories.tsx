import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import type { FieldConfig } from '../config'
import type { LogicalPath } from '../paths'
import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { unsafeAsLogicalPath, unsafeAsContentId } from '../paths/test-utils'

const meta: Meta<typeof Editor> = {
  title: 'Editor/Editor',
  component: Editor,
}

export default meta
type Story = StoryObj<typeof Editor>

const homeFields: FieldConfig[] = [
  {
    name: 'hero',
    type: 'object',
    label: 'Hero',
    fields: [
      { name: 'title', type: 'string', label: 'Title' },
      { name: 'body', type: 'markdown', label: 'Body' },
    ],
  },
]

const postFields: FieldConfig[] = [
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'body', type: 'markdown', label: 'Body' },
]

const baseEntries: EditorEntry[] = [
  {
    path: unsafeAsLogicalPath('home'),
    label: 'Home',
    status: 'page',
    fields: homeFields,
    apiPath: '/api/canopycms/main/content/home',
    previewSrc: '/',
    collectionPath: unsafeAsLogicalPath('home'),
    collectionName: 'home',
    format: 'json',
    type: 'entry',
    contentId: unsafeAsContentId('test123456789'),
  },
  {
    path: unsafeAsLogicalPath('posts/hello-world'),
    label: 'Hello World',
    status: 'draft',
    fields: postFields,
    apiPath: '/api/canopycms/main/content/posts/hello-world',
    previewSrc: '/posts/hello-world',
    collectionPath: unsafeAsLogicalPath('posts'),
    collectionName: 'posts',
    format: 'json',
    type: 'entry',
    contentId: unsafeAsContentId('abc987XYZ654'),
  },
]

export const WithCollections: Story = {
  render: () => {
    const [entries, setEntries] = useState<EditorEntry[]>(baseEntries)
    const collections = [
      {
        path: unsafeAsLogicalPath('home'),
        name: 'home',
        label: 'Home',
        format: 'json' as const,
        type: 'entry' as const,
      },
      {
        path: unsafeAsLogicalPath('posts'),
        name: 'posts',
        label: 'Posts',
        format: 'json' as const,
        type: 'collection' as const,
      },
    ]

    const handleCreateEntry = (collectionPath: LogicalPath) => {
      const slug = window.prompt(`New ${collectionPath} slug?`, 'new-post')
      if (!slug) return
      const newEntry: EditorEntry = {
        path: unsafeAsLogicalPath(`${collectionPath}/${slug}`),
        label: slug,
        status: 'draft',
        fields: collectionPath === 'home' ? homeFields : postFields,
        apiPath: `/api/canopycms/main/content/${collectionPath}/${slug}`,
        previewSrc: collectionPath === 'posts' ? `/posts/${slug}` : '/',
        collectionPath,
        collectionName: collectionPath,
        slug,
        format: 'json',
        type: collectionPath === 'home' ? 'entry' : 'entry',
        contentId: unsafeAsContentId(`new${Date.now()}`),
      }
      setEntries((prev) => [...prev, newEntry])
    }

    return (
      <div className="h-[90vh] bg-gray-50">
        <Editor
          entries={entries}
          title="CanopyCMS Editor"
          subtitle="Schema-driven editing with preview"
          branchName="story/branch"
          collections={collections}
          initialSelectedId={entries[0]?.path}
          onCreateEntry={handleCreateEntry}
          operatingMode="dev"
        />
      </div>
    )
  },
}
