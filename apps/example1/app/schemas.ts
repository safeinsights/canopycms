import { TypeFromEntrySchema, defineEntrySchema } from 'canopycms'
import { createEntrySchemaRegistry } from 'canopycms/server'

export const homeSchema = defineEntrySchema([
  {
    name: 'hero',
    type: 'object',
    label: 'Hero',
    fields: [
      { name: 'title', type: 'string', label: 'Title', isTitle: true },
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

export type HomeContent = TypeFromEntrySchema<typeof homeSchema>

export const authorSchema = defineEntrySchema([
  { name: 'name', type: 'string', label: 'Name' },
  { name: 'bio', type: 'string', label: 'Bio' },
])

export type AuthorContent = TypeFromEntrySchema<typeof authorSchema>

export const postSchema = defineEntrySchema([
  { name: 'title', type: 'string', label: 'Title' },
  {
    name: 'author',
    type: 'reference',
    label: 'Author',
    collections: ['authors'],
    displayField: 'name',
    resolvedSchema: authorSchema,
  },
  {
    name: 'tags',
    type: 'select',
    label: 'Tags',
    list: true,
    options: ['typed', 'fast', 'diagram', 'mdx'],
  },
  { name: 'published', type: 'boolean', label: 'Published' },
  { name: 'body', type: 'markdown', label: 'Body', isBody: true },
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

export type PostContent = TypeFromEntrySchema<typeof postSchema> & {
  slug: string
}

export const docSchema = defineEntrySchema([
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'description', type: 'string', label: 'Description' },
  { name: 'body', type: 'markdown', label: 'Body', isBody: true },
])

export type DocContent = TypeFromEntrySchema<typeof docSchema> & {
  slug: string
}

// Entry schema registry for CanopyCMS - references entry schemas by name in .collection.json files
export const entrySchemaRegistry = createEntrySchemaRegistry({
  postSchema,
  authorSchema,
  docSchema,
  homeSchema,
})
