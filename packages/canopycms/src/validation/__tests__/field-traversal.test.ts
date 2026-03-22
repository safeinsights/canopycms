import { describe, it, expect } from 'vitest'
import { traverseFields, findFieldsByType } from '../field-traversal'
import type { FieldConfig } from '../../config'

describe('field-traversal', () => {
  describe('traverseFields', () => {
    it('visits simple fields', () => {
      const schema: FieldConfig[] = [
        { name: 'title', type: 'string', label: 'Title' },
        { name: 'count', type: 'number', label: 'Count' },
      ]
      const data = { title: 'Hello', count: 42 }

      const visited: string[] = []
      traverseFields(schema, data, ({ field, path }) => {
        visited.push(`${path}:${field.type}`)
        return []
      })

      expect(visited).toEqual(['title:string', 'count:number'])
    })

    it('skips undefined and null values', () => {
      const schema: FieldConfig[] = [
        { name: 'title', type: 'string', label: 'Title' },
        { name: 'subtitle', type: 'string', label: 'Subtitle' },
        { name: 'count', type: 'number', label: 'Count' },
      ]
      const data = { title: 'Hello', subtitle: null, count: undefined }

      const visited: string[] = []
      traverseFields(schema, data, ({ path }) => {
        visited.push(path)
        return []
      })

      expect(visited).toEqual(['title'])
    })

    it('recurses into object fields', () => {
      const schema: FieldConfig[] = [
        {
          name: 'author',
          type: 'object',
          label: 'Author',
          fields: [
            { name: 'name', type: 'string', label: 'Name' },
            { name: 'email', type: 'string', label: 'Email' },
          ],
        },
      ]
      const data = {
        author: { name: 'Alice', email: 'alice@example.com' },
      }

      const visited: string[] = []
      traverseFields(schema, data, ({ path, field }) => {
        visited.push(`${path}:${field.type}`)
        return []
      })

      expect(visited).toEqual(['author:object', 'author.name:string', 'author.email:string'])
    })

    it('recurses into block fields', () => {
      const schema: FieldConfig[] = [
        {
          name: 'blocks',
          type: 'block',
          label: 'Blocks',
          templates: [
            {
              name: 'text',
              label: 'Text Block',
              fields: [{ name: 'content', type: 'string', label: 'Content' }],
            },
            {
              name: 'image',
              label: 'Image Block',
              fields: [{ name: 'src', type: 'string', label: 'Source' }],
            },
          ],
        },
      ]
      const data = {
        blocks: [
          { _type: 'text', content: 'Hello' },
          { _type: 'image', src: '/img.png' },
        ],
      }

      const visited: string[] = []
      traverseFields(schema, data, ({ path, field }) => {
        visited.push(`${path}:${field.type}`)
        return []
      })

      expect(visited).toEqual(['blocks:block', 'blocks[0].content:string', 'blocks[1].src:string'])
    })

    it('collects results from visitor', () => {
      const schema: FieldConfig[] = [
        {
          name: 'author',
          type: 'reference',
          label: 'Author',
          collections: ['authors'],
        },
        {
          name: 'tags',
          type: 'reference',
          label: 'Tags',
          collections: ['tags'],
        },
        { name: 'title', type: 'string', label: 'Title' },
      ]
      const data = {
        author: 'author-123',
        tags: ['tag-1', 'tag-2'],
        title: 'My Post',
      }

      const refs = traverseFields(schema, data, ({ field, value, path }) => {
        if (field.type === 'reference') {
          return [{ path, value }]
        }
        return []
      })

      expect(refs).toEqual([
        { path: 'author', value: 'author-123' },
        { path: 'tags', value: ['tag-1', 'tag-2'] },
      ])
    })

    it('handles deeply nested structures', () => {
      const schema: FieldConfig[] = [
        {
          name: 'sections',
          type: 'block',
          label: 'Sections',
          templates: [
            {
              name: 'content',
              label: 'Content Section',
              fields: [
                {
                  name: 'metadata',
                  type: 'object',
                  label: 'Metadata',
                  fields: [
                    {
                      name: 'ref',
                      type: 'reference',
                      label: 'Reference',
                      collections: ['docs'],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]
      const data = {
        sections: [
          {
            _type: 'content',
            metadata: { ref: 'doc-1' },
          },
          {
            _type: 'content',
            metadata: { ref: 'doc-2' },
          },
        ],
      }

      const refs = traverseFields(schema, data, ({ field, value, path }) => {
        if (field.type === 'reference') {
          return [{ path, value }]
        }
        return []
      })

      expect(refs).toEqual([
        { path: 'sections[0].metadata.ref', value: 'doc-1' },
        { path: 'sections[1].metadata.ref', value: 'doc-2' },
      ])
    })

    it('handles missing block template gracefully', () => {
      const schema: FieldConfig[] = [
        {
          name: 'blocks',
          type: 'block',
          label: 'Blocks',
          templates: [
            {
              name: 'text',
              label: 'Text',
              fields: [{ name: 'content', type: 'string', label: 'Content' }],
            },
          ],
        },
      ]
      const data = {
        blocks: [
          { _type: 'unknown', content: 'Hello' }, // Unknown type
          { _type: 'text', content: 'World' },
        ],
      }

      const visited: string[] = []
      traverseFields(schema, data, ({ path }) => {
        visited.push(path)
        return []
      })

      // Only the valid block should have its content visited
      expect(visited).toEqual(['blocks', 'blocks[1].content'])
    })
  })

  describe('findFieldsByType', () => {
    it('finds all reference fields', () => {
      const schema: FieldConfig[] = [
        { name: 'title', type: 'string', label: 'Title' },
        {
          name: 'author',
          type: 'reference',
          label: 'Author',
          collections: ['authors'],
        },
        {
          name: 'meta',
          type: 'object',
          label: 'Meta',
          fields: [
            {
              name: 'reviewer',
              type: 'reference',
              label: 'Reviewer',
              collections: ['users'],
            },
          ],
        },
      ]
      const data = {
        title: 'My Post',
        author: 'author-1',
        meta: { reviewer: 'user-1' },
      }

      const refs = findFieldsByType(schema, data, 'reference')

      expect(refs).toHaveLength(2)
      expect(refs[0].path).toBe('author')
      expect(refs[0].value).toBe('author-1')
      expect(refs[1].path).toBe('meta.reviewer')
      expect(refs[1].value).toBe('user-1')
    })
  })
})
