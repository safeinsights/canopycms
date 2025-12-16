import { describe, expect, it } from 'vitest'

import { buildEditorCollections, buildPreviewBaseByCollection } from './editor-config'

const baseConfig = {
  contentRoot: 'content',
  schema: [
    {
      type: 'collection',
      name: 'posts',
      label: 'Posts',
      path: 'posts',
      format: 'json',
      fields: [],
    },
    {
      type: 'singleton',
      name: 'home',
      path: 'home',
      format: 'json',
      fields: [],
    },
    {
      type: 'collection',
      name: 'nested',
      path: 'nested',
      format: 'md',
      fields: [],
      children: [
        {
          type: 'collection',
          name: 'child',
          path: 'child',
          format: 'md',
          fields: [],
        },
      ],
    },
  ],
}

describe('editor-config helpers', () => {
  it('builds editor collections from schema/config', () => {
    const collections = buildEditorCollections(baseConfig)
    expect(collections).toHaveLength(3)
    expect(collections.map((c) => c.id)).toEqual(['content/posts', 'content/home', 'content/nested'])
    const nested = collections.find((c) => c.id === 'content/nested')
    expect(nested?.children?.[0]?.id).toBe('content/nested/child')
  })

  it('derives preview bases from content root and schema paths', () => {
    const previewBase = buildPreviewBaseByCollection(baseConfig)
    expect(previewBase['content/posts']).toBe('/posts')
    expect(previewBase['content/home']).toBe('/')
    expect(previewBase['content/nested/child']).toBe('/nested/child')
  })

  it('trims content root slashes when building preview bases', () => {
    const previewBase = buildPreviewBaseByCollection({
      ...baseConfig,
      contentRoot: '/site/content/',
    })
    expect(previewBase['site/content/posts']).toBe('/posts')
  })
})
