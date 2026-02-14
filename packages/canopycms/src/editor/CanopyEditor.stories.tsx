import type { Meta, StoryObj } from '@storybook/react'
import React, { useEffect } from 'react'

import { defineCanopyConfig } from '../config'
import { CanopyEditor } from './CanopyEditor'

const meta: Meta<typeof CanopyEditor> = {
  title: 'Editor/CanopyEditor',
  component: CanopyEditor,
}

export default meta
type Story = StoryObj<typeof CanopyEditor>

const schema = {
  collections: [
    {
      name: 'posts',
      label: 'Posts',
      path: 'posts',
      entries: [
        {
          name: 'entry',
          format: 'json' as const,
          fields: [{ name: 'title', type: 'string' as const }],
        },
      ],
    },
  ],
} as const

const configBundle = defineCanopyConfig({
  contentRoot: 'content',
  defaultBaseBranch: 'main',
  gitBotAuthorName: 'Canopy Bot',
  gitBotAuthorEmail: 'canopy@example.com',
  editor: {
    title: 'CanopyCMS Editor',
    subtitle: 'Config-driven wrapper',
    theme: { colors: { brand: '#4f46e5' } },
  },
})

const config = configBundle.client()

const entries = [
  {
    path: 'content/posts/hello',
    label: 'Hello Post',
    status: 'page',
    schema: schema.collections[0].entries[0].fields,
    apiPath: '/api/canopycms/main/content/posts/hello',
    collectionId: 'content/posts',
    collectionName: 'posts',
    slug: 'hello',
    format: 'json' as const,
    type: 'entry' as const,
    contentId: 'test123456789',
  },
]

const MockFetch: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useEffect(() => {
    const original = global.fetch
    const handler = (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/canopycms/branches')) {
        return Promise.resolve(
          new Response(JSON.stringify({}), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }
      if (url.includes('/entries')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              collections: [],
              entries: [],
              pagination: { hasMore: false, limit: 50 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }
      if (url.includes('/content') && (!init || !init.method)) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { title: 'Loaded' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }
      if (url.includes('/content') && init?.method === 'PUT') {
        return Promise.resolve(
          new Response(init.body as BodyInit, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }
      return Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }
    global.fetch = handler as any
    return () => {
      global.fetch = original as any
    }
  }, [])
  return <>{children}</>
}

export const Default: Story = {
  render: () => (
    <div className="h-[90vh] bg-gray-50">
      <MockFetch>
        <CanopyEditor config={config} entries={entries} />
      </MockFetch>
    </div>
  ),
}
