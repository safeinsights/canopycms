import { defineEntrySchema, defineInlineFieldGroup } from 'canopycms'
import { createEntrySchemaRegistry } from 'canopycms/server'

export const postSchema = defineEntrySchema([
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'author', type: 'string', label: 'Author' },
  { name: 'date', type: 'string', label: 'Date' },
  { name: 'tags', type: 'string', list: true, label: 'Tags' },
  // Structured image field: exercises the upload -> finalize -> transform ->
  // MediaLibrary pipeline end to end. Deliberately has no `aspect`, so picking
  // an image commits immediately instead of opening the canvas crop step
  // (crop math is unit-tested; driving react-easy-crop from Playwright is not).
  { name: 'heroImage', type: 'image', label: 'Hero Image' },
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

// Entry schema registry. Intentionally kept on the keyless schema-variable-name
// convention (postSchema / homeSchema / settingsSchema) so this app exercises
// the supported "Path B" registry shape — `example1` and the CLI template
// demonstrate the recommended entry-type-name convention.
// See README "Migrating from the schema-name-keyed registry" for both paths.
export const entrySchemaRegistry = createEntrySchemaRegistry({
  postSchema,
  homeSchema,
  settingsSchema,
})
