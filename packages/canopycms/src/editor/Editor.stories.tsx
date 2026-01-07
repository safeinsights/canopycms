import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import type { FieldConfig } from '../config'
import type { EditorEntry } from './Editor'
import { Editor } from './Editor'

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
    id: 'home',
    label: 'Home',
    status: 'page',
    schema: homeFields,
    apiPath: '/api/canopycms/main/content/home',
    previewSrc: '/',
    collectionId: 'home',
    collectionName: 'home',
    format: 'json',
    type: 'entry',
  },
  {
    id: 'posts/hello-world',
    label: 'Hello World',
    status: 'draft',
    schema: postFields,
    apiPath: '/api/canopycms/main/content/posts/hello-world',
    previewSrc: '/posts/hello-world',
    collectionId: 'posts',
    collectionName: 'posts',
    format: 'json',
    type: 'entry',
  },
]

export const WithCollections: Story = {
  render: () => {
    const [entries, setEntries] = useState<EditorEntry[]>(baseEntries)
    const collections = [
      { id: 'home', name: 'home', label: 'Home', format: 'json' as const, type: 'entry' as const },
      {
        id: 'posts',
        name: 'posts',
        label: 'Posts',
        format: 'json' as const,
        type: 'collection' as const,
      },
    ]

    const handleCreateEntry = (collectionId: string) => {
      const slug = window.prompt(`New ${collectionId} slug?`, 'new-post')
      if (!slug) return
      const newEntry: EditorEntry = {
        id: `${collectionId}/${slug}`,
        label: slug,
        status: 'draft',
        schema: collectionId === 'home' ? homeFields : postFields,
        apiPath: `/api/canopycms/main/content/${collectionId}/${slug}`,
        previewSrc: collectionId === 'posts' ? `/posts/${slug}` : '/',
        collectionId,
        collectionName: collectionId,
        slug,
        format: 'json',
        type: collectionId === 'home' ? 'entry' : 'entry',
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
          initialSelectedId={entries[0]?.id}
          onCreateEntry={handleCreateEntry}
        />
      </div>
    )
  },
}
