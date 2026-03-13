import type { RootCollectionConfig } from '../../config'

/**
 * Blog schema for testing content workflows
 * Contains posts collection
 */
export const BLOG_SCHEMA: RootCollectionConfig = {
  collections: [
    {
      name: 'posts',
      path: 'posts',
      entries: [
        {
          name: 'post',
          format: 'mdx',
          schema: [
            { name: 'title', type: 'string', required: true },
            { name: 'author', type: 'string' },
            { name: 'date', type: 'datetime' },
            { name: 'tags', type: 'string', list: true },
            { name: 'body', type: 'markdown', required: true },
          ],
        },
      ],
    },
  ],
}

/**
 * E-commerce schema for testing complex permission scenarios
 * Contains products and categories
 */
export const ECOMMERCE_SCHEMA: RootCollectionConfig = {
  collections: [
    {
      name: 'products',
      path: 'products',
      entries: [
        {
          name: 'product',
          format: 'json',
          schema: [
            { name: 'name', type: 'string', required: true },
            { name: 'price', type: 'number', required: true },
            { name: 'description', type: 'markdown' },
            { name: 'inStock', type: 'boolean' },
            { name: 'images', type: 'string', list: true },
          ],
        },
      ],
    },
    {
      name: 'categories',
      path: 'categories',
      entries: [
        {
          name: 'category',
          format: 'json',
          schema: [
            { name: 'name', type: 'string', required: true },
            { name: 'description', type: 'string' },
          ],
        },
      ],
    },
  ],
}
