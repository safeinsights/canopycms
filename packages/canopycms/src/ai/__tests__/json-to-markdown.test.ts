import { describe, it, expect } from 'vitest'
import { entryToMarkdown } from '../json-to-markdown'
import type { AIEntry, AIContentConfig } from '../types'
import type { FieldConfig } from '../../config'

/** Helper to create a minimal AIEntry */
function makeEntry(overrides: Partial<AIEntry> & { fields: FieldConfig[] }): AIEntry {
  return {
    slug: 'test-entry',
    collection: 'posts',
    collectionName: 'posts',
    entryType: 'post',
    format: 'json',
    data: {},
    ...overrides,
  }
}

describe('entryToMarkdown', () => {
  describe('frontmatter', () => {
    it('includes slug, collection, and type in frontmatter', () => {
      const entry = makeEntry({
        slug: 'hello',
        collection: 'docs',
        entryType: 'doc',
        fields: [],
        data: {},
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('slug: hello')
      expect(md).toContain('collection: docs')
      expect(md).toContain('type: doc')
    })

    it('includes title in frontmatter when present in data', () => {
      const entry = makeEntry({
        fields: [{ name: 'title', type: 'string' }],
        data: { title: 'Hello World' },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('title: Hello World')
    })

    it('escapes special characters in YAML values', () => {
      const entry = makeEntry({
        fields: [{ name: 'title', type: 'string' }],
        data: { title: 'Hello: World' },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('title: "Hello: World"')
    })
  })

  describe('primitive field types', () => {
    it('renders string fields', () => {
      const entry = makeEntry({
        fields: [{ name: 'summary', type: 'string', label: 'Summary' }],
        data: { summary: 'A brief description' },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('## Summary')
      expect(md).toContain('A brief description')
    })

    it('renders number fields', () => {
      const entry = makeEntry({
        fields: [{ name: 'count', type: 'number', label: 'Count' }],
        data: { count: 42 },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('## Count')
      expect(md).toContain('42')
    })

    it('renders boolean fields as Yes/No', () => {
      const entry = makeEntry({
        fields: [
          { name: 'published', type: 'boolean', label: 'Published' },
          { name: 'draft', type: 'boolean', label: 'Draft' },
        ],
        data: { published: true, draft: false },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('## Published')
      expect(md).toContain('Yes')
      expect(md).toContain('## Draft')
      expect(md).toContain('No')
    })

    it('renders datetime fields', () => {
      const entry = makeEntry({
        fields: [{ name: 'createdAt', type: 'datetime', label: 'Created At' }],
        data: { createdAt: '2026-03-20T00:00:00Z' },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('## Created At')
      expect(md).toContain('2026-03-20T00:00:00Z')
    })
  })

  describe('content field types', () => {
    it('renders rich-text as block content', () => {
      const entry = makeEntry({
        fields: [{ name: 'content', type: 'rich-text', label: 'Content' }],
        data: { content: '**Bold** and *italic*' },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('## Content')
      expect(md).toContain('**Bold** and *italic*')
    })

    it('renders markdown fields as block content', () => {
      const entry = makeEntry({
        fields: [{ name: 'notes', type: 'markdown', label: 'Notes' }],
        data: { notes: '# Heading\n\nSome notes' },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('## Notes')
      expect(md).toContain('# Heading\n\nSome notes')
    })

    it('renders image fields', () => {
      const entry = makeEntry({
        fields: [{ name: 'hero', type: 'image', label: 'Hero Image' }],
        data: { hero: '/images/hero.jpg' },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('## Hero Image')
      expect(md).toContain('![Hero Image](/images/hero.jpg)')
    })

    it('renders code fields as fenced code blocks', () => {
      const entry = makeEntry({
        fields: [{ name: 'snippet', type: 'code', label: 'Code Snippet' }],
        data: { snippet: 'const x = 1' },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('## Code Snippet')
      expect(md).toContain('```\nconst x = 1\n```')
    })
  })

  describe('select fields', () => {
    it('renders select with string options', () => {
      const entry = makeEntry({
        fields: [
          { name: 'status', type: 'select', label: 'Status', options: ['draft', 'published'] },
        ],
        data: { status: 'published' },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('## Status')
      expect(md).toContain('published')
    })

    it('renders select with label/value options using label', () => {
      const entry = makeEntry({
        fields: [
          {
            name: 'priority',
            type: 'select',
            label: 'Priority',
            options: [
              { label: 'High', value: 'high' },
              { label: 'Low', value: 'low' },
            ],
          },
        ],
        data: { priority: 'high' },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('High')
    })
  })

  describe('reference fields', () => {
    it('renders resolved references with title', () => {
      const entry = makeEntry({
        fields: [{ name: 'author', type: 'reference', collections: ['authors'] }],
        data: { author: { title: 'Alice', slug: 'alice', id: 'abc123' } },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('Alice')
    })

    it('renders unresolved references as IDs', () => {
      const entry = makeEntry({
        fields: [{ name: 'author', type: 'reference', collections: ['authors'] }],
        data: { author: 'abc123' },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('abc123')
    })

    it('renders reference lists', () => {
      const entry = makeEntry({
        fields: [{ name: 'tags', type: 'reference', collections: ['tags'] }],
        data: {
          tags: [
            { title: 'TypeScript', slug: 'ts' },
            { title: 'React', slug: 'react' },
          ],
        },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('- TypeScript')
      expect(md).toContain('- React')
    })
  })

  describe('object fields', () => {
    it('renders nested object fields with increased heading depth', () => {
      const entry = makeEntry({
        fields: [
          {
            name: 'seo',
            type: 'object',
            label: 'SEO',
            fields: [
              { name: 'metaTitle', type: 'string', label: 'Meta Title' },
              { name: 'metaDesc', type: 'string', label: 'Meta Description' },
            ],
          },
        ],
        data: {
          seo: { metaTitle: 'My Page', metaDesc: 'A great page' },
        },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('## SEO')
      expect(md).toContain('### Meta Title')
      expect(md).toContain('My Page')
      expect(md).toContain('### Meta Description')
      expect(md).toContain('A great page')
    })

    it('skips object field when all sub-fields are null', () => {
      const entry = makeEntry({
        fields: [
          {
            name: 'seo',
            type: 'object',
            label: 'SEO',
            fields: [{ name: 'metaTitle', type: 'string' }],
          },
        ],
        data: { seo: { metaTitle: null } },
      })
      const md = entryToMarkdown(entry)
      expect(md).not.toContain('## SEO')
    })
  })

  describe('block fields', () => {
    it('renders block items with template names as headings', () => {
      const entry = makeEntry({
        fields: [
          {
            name: 'blocks',
            type: 'block',
            label: 'Content Blocks',
            templates: [
              {
                name: 'text',
                label: 'Text Block',
                fields: [{ name: 'body', type: 'markdown', label: 'Body' }],
              },
              {
                name: 'cta',
                label: 'Call to Action',
                fields: [
                  { name: 'text', type: 'string', label: 'Button Text' },
                  { name: 'url', type: 'string', label: 'URL' },
                ],
              },
            ],
          },
        ],
        data: {
          blocks: [
            { _type: 'text', body: 'Hello world' },
            { _type: 'cta', text: 'Click me', url: '/action' },
          ],
        },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('## Content Blocks')
      expect(md).toContain('### Text Block')
      expect(md).toContain('Hello world')
      expect(md).toContain('### Call to Action')
      expect(md).toContain('Click me')
      expect(md).toContain('/action')
    })

    it('handles blocks with template key (ContentStore format)', () => {
      const entry = makeEntry({
        fields: [
          {
            name: 'blocks',
            type: 'block',
            label: 'Blocks',
            templates: [
              {
                name: 'hero',
                label: 'Hero',
                fields: [{ name: 'title', type: 'string', label: 'Title' }],
              },
            ],
          },
        ],
        data: {
          blocks: [{ template: 'hero', title: 'Welcome' }],
        },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('### Hero')
      expect(md).toContain('Welcome')
    })
  })

  describe('list fields', () => {
    it('renders primitive list fields as markdown lists', () => {
      const entry = makeEntry({
        fields: [{ name: 'tags', type: 'string', label: 'Tags', list: true }],
        data: { tags: ['typescript', 'react', 'nextjs'] },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('## Tags')
      expect(md).toContain('- typescript')
      expect(md).toContain('- react')
      expect(md).toContain('- nextjs')
    })

    it('renders empty list fields as empty', () => {
      const entry = makeEntry({
        fields: [{ name: 'tags', type: 'string', label: 'Tags', list: true }],
        data: { tags: [] },
      })
      const md = entryToMarkdown(entry)
      expect(md).not.toContain('## Tags')
    })

    it('renders object list fields as numbered subsections', () => {
      const entry = makeEntry({
        fields: [
          {
            name: 'authors',
            type: 'object',
            label: 'Authors',
            list: true,
            fields: [
              { name: 'name', type: 'string', label: 'Name' },
              { name: 'email', type: 'string', label: 'Email' },
            ],
          },
        ],
        data: {
          authors: [
            { name: 'Alice', email: 'alice@example.com' },
            { name: 'Bob', email: 'bob@example.com' },
          ],
        },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('## Authors')
      expect(md).toContain('### Authors 1')
      expect(md).toContain('Alice')
      expect(md).toContain('### Authors 2')
      expect(md).toContain('Bob')
    })
  })

  describe('field descriptions', () => {
    it('includes field description when present', () => {
      const entry = makeEntry({
        fields: [
          {
            name: 'irbStatus',
            type: 'select',
            label: 'IRB Status',
            description: 'Whether this dataset requires IRB approval',
            options: ['approved', 'pending'],
          },
        ],
        data: { irbStatus: 'approved' },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('*Whether this dataset requires IRB approval*')
    })
  })

  describe('MD/MDX entries', () => {
    it('renders frontmatter fields as metadata and body verbatim', () => {
      const entry = makeEntry({
        format: 'md',
        fields: [
          { name: 'title', type: 'string', label: 'Title' },
          { name: 'published', type: 'boolean', label: 'Published' },
        ],
        data: { title: 'My Post', published: true },
        body: '# My Post\n\nThis is the content.',
      })
      const md = entryToMarkdown(entry)
      // Frontmatter
      expect(md).toContain('title: My Post')
      // Metadata section
      expect(md).toContain('**Published:** Yes')
      // Body verbatim
      expect(md).toContain('# My Post\n\nThis is the content.')
    })

    it('does not double-render body-like fields for MD entries', () => {
      const entry = makeEntry({
        format: 'mdx',
        fields: [
          { name: 'title', type: 'string' },
          { name: 'content', type: 'rich-text' },
        ],
        data: { title: 'Hello', content: 'Rich text content' },
        body: '# Hello\n\nMarkdown body.',
      })
      const md = entryToMarkdown(entry)
      // rich-text field should not be rendered in metadata section
      expect(md).not.toContain('Rich text content')
      // body should be present
      expect(md).toContain('# Hello\n\nMarkdown body.')
    })
  })

  describe('null/undefined handling', () => {
    it('skips fields with null values', () => {
      const entry = makeEntry({
        fields: [
          { name: 'title', type: 'string', label: 'Title' },
          { name: 'subtitle', type: 'string', label: 'Subtitle' },
        ],
        data: { title: 'Hello', subtitle: null },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('## Title')
      expect(md).not.toContain('## Subtitle')
    })

    it('skips fields with undefined values', () => {
      const entry = makeEntry({
        fields: [
          { name: 'title', type: 'string', label: 'Title' },
          { name: 'subtitle', type: 'string', label: 'Subtitle' },
        ],
        data: { title: 'Hello' },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('## Title')
      expect(md).not.toContain('## Subtitle')
    })
  })

  describe('field name fallback', () => {
    it('uses field name when label is absent', () => {
      const entry = makeEntry({
        fields: [{ name: 'myField', type: 'string' }],
        data: { myField: 'value' },
      })
      const md = entryToMarkdown(entry)
      expect(md).toContain('## myField')
    })
  })

  describe('field transforms', () => {
    it('applies field transform override', () => {
      const config: AIContentConfig = {
        fieldTransforms: {
          dataset: {
            dataFields: (value) => {
              const fields = value as Array<{ name: string; type: string }>
              return `## Data Fields\n\n| Name | Type |\n|---|---|\n${fields.map((f) => `| ${f.name} | ${f.type} |`).join('\n')}`
            },
          },
        },
      }

      const entry = makeEntry({
        entryType: 'dataset',
        fields: [{ name: 'dataFields', type: 'object', fields: [] }],
        data: {
          dataFields: [
            { name: 'id', type: 'integer' },
            { name: 'score', type: 'float' },
          ],
        },
      })

      const md = entryToMarkdown(entry, config)
      expect(md).toContain('## Data Fields')
      expect(md).toContain('| id | integer |')
      expect(md).toContain('| score | float |')
    })

    it('does not apply transforms for different entry types', () => {
      const config: AIContentConfig = {
        fieldTransforms: {
          dataset: {
            title: () => 'CUSTOM',
          },
        },
      }

      const entry = makeEntry({
        entryType: 'post', // different from 'dataset'
        fields: [{ name: 'title', type: 'string', label: 'Title' }],
        data: { title: 'Original' },
      })

      const md = entryToMarkdown(entry, config)
      expect(md).not.toContain('CUSTOM')
      expect(md).toContain('Original')
    })
  })
})
