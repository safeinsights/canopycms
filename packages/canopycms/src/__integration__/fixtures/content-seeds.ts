import type { ContentStore } from '../../content-store'

/**
 * Sample blog posts for seeding test content
 */
export const SAMPLE_POSTS = [
  {
    slug: 'hello-world',
    data: {
      title: 'Hello World',
      author: 'Test Author',
      date: '2024-01-01T00:00:00Z',
      tags: ['intro', 'test'],
      body: 'Welcome to the test blog! This is the first post.',
    },
  },
  {
    slug: 'second-post',
    data: {
      title: 'Second Post',
      author: 'Test Author',
      date: '2024-01-02T00:00:00Z',
      tags: ['test'],
      body: 'This is the second post for testing purposes.',
    },
  },
  {
    slug: 'draft-post',
    data: {
      title: 'Draft Post',
      author: 'Test Author',
      date: '2024-01-03T00:00:00Z',
      tags: ['draft'],
      body: "This is a draft post that hasn't been published yet.",
    },
  },
]

/**
 * Sample about page content
 */
export const SAMPLE_ABOUT = {
  title: 'About Us',
  bio: 'This is a test about page for integration testing.',
}

/**
 * Sample products for e-commerce schema
 */
export const SAMPLE_PRODUCTS = [
  {
    slug: 'product-1',
    data: {
      name: 'Test Product 1',
      price: 29.99,
      description: 'A great test product',
      inStock: true,
      images: ['product1.jpg'],
    },
  },
  {
    slug: 'product-2',
    data: {
      name: 'Test Product 2',
      price: 49.99,
      description: 'Another test product',
      inStock: false,
      images: ['product2.jpg', 'product2-alt.jpg'],
    },
  },
]

/**
 * Seed blog content into a ContentStore
 */
export async function seedBlogContent(store: ContentStore): Promise<void> {
  // Seed posts
  for (const post of SAMPLE_POSTS) {
    await store.write('content/posts', post.slug, {
      format: 'mdx',
      data: post.data,
      body: post.data.body as string,
    })
  }

  // Seed about page
  await store.write('content/about.md', '', {
    format: 'mdx',
    data: SAMPLE_ABOUT,
    body: SAMPLE_ABOUT.bio as string,
  })
}

/**
 * Seed e-commerce content into a ContentStore
 */
export async function seedEcommerceContent(store: ContentStore): Promise<void> {
  for (const product of SAMPLE_PRODUCTS) {
    await store.write('content/products', product.slug, {
      format: 'json',
      data: product.data,
    })
  }
}
