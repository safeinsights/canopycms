import type { CanopyConfig } from '../../config'

/**
 * Blog schema for testing content workflows
 * Contains posts (collection) and about (singleton)
 */
export const BLOG_SCHEMA: CanopyConfig['schema'] = {
  collections: [
    {
      name: 'posts',
      path: 'posts',
      entries: {
        format: 'mdx',
        fields: [
          { name: 'title', type: 'string', required: true },
          { name: 'author', type: 'string' },
          { name: 'date', type: 'datetime' },
          { name: 'tags', type: 'string', list: true },
          { name: 'body', type: 'markdown', required: true },
        ],
      },
    },
  ],
  singletons: [
    {
      name: 'about',
      path: 'about.md',
      format: 'mdx',
      fields: [
        { name: 'title', type: 'string', required: true },
        { name: 'bio', type: 'markdown' },
      ],
    },
  ],
}

/**
 * E-commerce schema for testing complex permission scenarios
 * Contains products and categories
 */
export const ECOMMERCE_SCHEMA: CanopyConfig['schema'] = {
  collections: [
    {
      name: 'products',
      path: 'products',
      entries: {
        format: 'json',
        fields: [
          { name: 'name', type: 'string', required: true },
          { name: 'price', type: 'number', required: true },
          { name: 'description', type: 'markdown' },
          { name: 'inStock', type: 'boolean' },
          { name: 'images', type: 'string', list: true },
        ],
      },
    },
    {
      name: 'categories',
      path: 'categories',
      entries: {
        format: 'json',
        fields: [
          { name: 'name', type: 'string', required: true },
          { name: 'description', type: 'string' },
        ],
      },
    },
  ],
  singletons: [],
}
