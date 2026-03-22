import { defineEntrySchema } from 'canopycms'
import { createEntrySchemaRegistry } from 'canopycms/server'

export const postSchema = defineEntrySchema([
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'author', type: 'string', label: 'Author' },
  { name: 'date', type: 'string', label: 'Date' },
  { name: 'tags', type: 'string', list: true, label: 'Tags' },
  { name: 'body', type: 'mdx', label: 'Body' },
] as const)

export const homeSchema = defineEntrySchema([
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'tagline', type: 'string', label: 'Tagline' },
  { name: 'published', type: 'boolean', label: 'Published' },
  {
    name: 'featuredPosts',
    type: 'string',
    list: true,
    label: 'Featured Posts',
  },
] as const)

// Entry schema registry for CanopyCMS - references entry schemas by name in .collection.json files
export const entrySchemaRegistry = createEntrySchemaRegistry({
  postSchema,
  homeSchema,
})
