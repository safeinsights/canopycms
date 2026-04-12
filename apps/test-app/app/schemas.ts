import { defineEntrySchema, defineInlineFieldGroup } from 'canopycms'
import { createEntrySchemaRegistry } from 'canopycms/server'

export const postSchema = defineEntrySchema([
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'author', type: 'string', label: 'Author' },
  { name: 'date', type: 'string', label: 'Date' },
  { name: 'tags', type: 'string', list: true, label: 'Tags' },
  { name: 'body', type: 'mdx', label: 'Body', isBody: true },
] as const)

export const seoGroup = defineInlineFieldGroup({
  name: 'seo',
  label: 'SEO',
  description: 'Search engine optimisation metadata',
  fields: [
    { name: 'metaTitle', type: 'string', label: 'Meta Title' },
    { name: 'metaDescription', type: 'string', label: 'Meta Description' },
  ],
} as const)

export const homeSchema = defineEntrySchema([
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'tagline', type: 'string', label: 'Tagline' },
  { name: 'published', type: 'boolean', label: 'Published' },
  {
    name: 'featuredPosts',
    type: 'reference',
    list: true,
    label: 'Featured Posts',
    collections: ['posts'],
    displayField: 'title',
  },
  {
    name: 'relatedPost',
    type: 'reference',
    label: 'Related Post',
    collections: ['posts'],
    displayField: 'title',
  },
  seoGroup,
] as const)

export const settingsSchema = defineEntrySchema([
  { name: 'siteName', type: 'string', label: 'Site Name', isTitle: true },
  { name: 'maintenanceMode', type: 'boolean', label: 'Maintenance Mode' },
] as const)

// Entry schema registry for CanopyCMS - references entry schemas by name in .collection.json files
export const entrySchemaRegistry = createEntrySchemaRegistry({
  postSchema,
  homeSchema,
  settingsSchema,
})
