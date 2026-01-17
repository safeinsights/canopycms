import { defineSchema } from 'canopycms'
import { createSchemaRegistry } from 'canopycms/server'

export const postSchema = defineSchema([
  { name: 'title', type: 'string' },
  { name: 'author', type: 'string' },
  { name: 'date', type: 'string' },
  { name: 'tags', type: 'string', list: true },
  { name: 'body', type: 'mdx' },
] as const)

export const homeSchema = defineSchema([
  { name: 'title', type: 'string' },
  { name: 'tagline', type: 'string' },
  { name: 'featuredPosts', type: 'string', list: true },
] as const)

// Schema registry for CanopyCMS - references schemas by name in .collection.json files
export const schemaRegistry = createSchemaRegistry({
  postSchema,
  homeSchema,
})
