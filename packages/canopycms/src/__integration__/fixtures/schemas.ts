import type { CanopyConfig } from '../../config'

/**
 * Blog schema for testing content workflows
 * Contains posts (collection) and about (singleton)
 */
export const BLOG_SCHEMA: CanopyConfig['schema'] = [
  {
    type: 'collection',
    name: 'posts',
    path: 'posts',
    format: 'mdx',
    fields: [
      { name: 'title', type: 'string', required: true },
      { name: 'author', type: 'string' },
      { name: 'date', type: 'datetime' },
      { name: 'tags', type: 'string', list: true },
      { name: 'body', type: 'markdown', required: true },
    ],
  },
  {
    type: 'singleton',
    name: 'about',
    path: 'about.md',
    format: 'mdx',
    fields: [
      { name: 'title', type: 'string', required: true },
      { name: 'bio', type: 'markdown' },
    ],
  },
]

/**
 * E-commerce schema for testing complex permission scenarios
 * Contains products and categories
 */
export const ECOMMERCE_SCHEMA: CanopyConfig['schema'] = [
  {
    type: 'collection',
    name: 'products',
    path: 'products',
    format: 'json',
    fields: [
      { name: 'name', type: 'string', required: true },
      { name: 'price', type: 'number', required: true },
      { name: 'description', type: 'markdown' },
      { name: 'inStock', type: 'boolean' },
      { name: 'images', type: 'string', list: true },
    ],
  },
  {
    type: 'collection',
    name: 'categories',
    path: 'categories',
    format: 'json',
    fields: [
      { name: 'name', type: 'string', required: true },
      { name: 'description', type: 'string' },
    ],
  },
]
