import { TypeFromSchema, defineSchema } from 'canopycms'

export const homeSchema = defineSchema([
  {
    name: 'hero',
    type: 'object',
    label: 'Hero',
    fields: [
      { name: 'title', type: 'string', label: 'Title' },
      { name: 'body', type: 'markdown', label: 'Body' },
    ],
  },
  {
    name: 'features',
    type: 'object',
    label: 'Features',
    list: true,
    fields: [
      { name: 'title', type: 'string', label: 'Title' },
      { name: 'description', type: 'string', label: 'Description' },
    ],
  },
  {
    name: 'cta',
    type: 'object',
    label: 'CTA',
    fields: [
      { name: 'text', type: 'string', label: 'Text' },
      { name: 'link', type: 'string', label: 'Link' },
    ],
  },
])

export type HomeContent = TypeFromSchema<typeof homeSchema>

export const postSchema = defineSchema([
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'author', type: 'string', label: 'Author' },
  {
    name: 'tags',
    type: 'select',
    label: 'Tags',
    list: true,
    options: ['typed', 'fast', 'diagram', 'mdx'],
  },
  { name: 'published', type: 'boolean', label: 'Published' },
  { name: 'body', type: 'markdown', label: 'Body' },
  {
    name: 'blocks',
    type: 'block',
    templates: [
      {
        name: 'hero',
        label: 'Hero',
        fields: [
          { name: 'headline', type: 'string' },
          { name: 'body', type: 'markdown' },
        ],
      },
      {
        name: 'cta',
        label: 'CTA',
        fields: [
          { name: 'title', type: 'string' },
          { name: 'ctaText', type: 'string' },
        ],
      },
    ],
  },
])

export type PostContent = TypeFromSchema<typeof postSchema> & { slug: string }

export const docSchema = defineSchema([
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'description', type: 'string', label: 'Description' },
  { name: 'body', type: 'markdown', label: 'Body' },
])

export type DocContent = TypeFromSchema<typeof docSchema> & { slug: string }
