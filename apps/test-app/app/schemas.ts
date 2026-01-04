import { defineSchema } from 'canopycms'

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
