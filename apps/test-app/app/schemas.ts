import { defineEntrySchema } from 'canopycms'
import { createEntrySchemaRegistry } from 'canopycms/server'

export const postSchema = defineEntrySchema([
  { name: 'title', type: 'string' },
  { name: 'author', type: 'string' },
  { name: 'date', type: 'string' },
  { name: 'tags', type: 'string', list: true },
  { name: 'body', type: 'mdx' },
] as const)

export const homeSchema = defineEntrySchema([
  { name: 'title', type: 'string' },
  { name: 'tagline', type: 'string' },
  { name: 'featuredPosts', type: 'string', list: true },
] as const)

// Entry schema registry for CanopyCMS - references entry schemas by name in .collection.json files
export const entrySchemaRegistry = createEntrySchemaRegistry({
  postSchema,
  homeSchema,
})
