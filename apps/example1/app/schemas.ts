import {
  TypeFromEntrySchema,
  defineEntrySchema,
  defineInlineFieldGroup,
  defineNestedFieldGroup,
} from 'canopycms'
import { createEntrySchemaRegistry } from 'canopycms/server'

// Shared inline field group: fields are stored flat in the content file.
// TypeFromEntrySchema on a schema that includes this group will have
// { metaTitle: string, metaDescription: string } merged into the top-level shape.
const seoGroup = defineInlineFieldGroup({
  name: 'seo',
  label: 'SEO',
  description: 'Search engine optimization settings',
  fields: [
    { name: 'metaTitle', type: 'string', label: 'Meta Title' },
    { name: 'metaDescription', type: 'string', label: 'Meta Description' },
  ],
})

// Shared inline field group for navigation metadata.
const navGroup = defineInlineFieldGroup({
  name: 'nav',
  label: 'Navigation',
  fields: [{ name: 'navText', type: 'string', label: 'Nav Text' }],
})

// Nested field group: fields are stored under the group's name as a sub-object.
// TypeFromEntrySchema on a schema that includes this group will have
// { location: { city: string, country: string } } in the shape.
const locationGroup = defineNestedFieldGroup({
  name: 'location',
  label: 'Location',
  fields: [
    { name: 'city', type: 'string', label: 'City' },
    { name: 'country', type: 'string', label: 'Country' },
  ],
})

export const homeSchema = defineEntrySchema([
  {
    name: 'hero',
    type: 'object',
    label: 'Hero',
    fields: [
      { name: 'title', type: 'string', label: 'Title', isTitle: true },
      { name: 'body', type: 'markdown', label: 'Body' },
    ],
  },
  {
    name: 'features',
    type: 'object',
    label: 'Features',
    list: true,
    fields: [
      { name: 'title', type: 'string', label: 'Title' },
      { name: 'description', type: 'string', label: 'Description' },
    ],
  },
  {
    name: 'cta',
    type: 'object',
    label: 'CTA',
    fields: [
      { name: 'text', type: 'string', label: 'Text' },
      { name: 'link', type: 'string', label: 'Link' },
    ],
  },
])

export type HomeContent = TypeFromEntrySchema<typeof homeSchema>

export const authorSchema = defineEntrySchema([
  { name: 'name', type: 'string', label: 'Name' },
  { name: 'bio', type: 'string', label: 'Bio' },
  // Nested group: author.location.city / author.location.country in content files
  locationGroup,
])

export type AuthorContent = TypeFromEntrySchema<typeof authorSchema>

export const postSchema = defineEntrySchema([
  { name: 'title', type: 'string', label: 'Title' },
  {
    name: 'author',
    type: 'reference',
    label: 'Author',
    collections: ['authors'],
    displayField: 'name',
    resolvedSchema: authorSchema,
  },
  {
    name: 'tags',
    type: 'select',
    label: 'Tags',
    list: true,
    options: ['typed', 'fast', 'diagram', 'mdx'],
  },
  { name: 'published', type: 'boolean', label: 'Published' },
  // Inline SEO group: metaTitle/metaDescription stored flat alongside other fields
  seoGroup,
  { name: 'body', type: 'markdown', label: 'Body', isBody: true },
  {
    name: 'blocks',
    type: 'block',
    templates: [
      {
        name: 'hero',
        label: 'Hero',
        fields: [
          { name: 'headline', type: 'string' },
          { name: 'body', type: 'markdown' },
        ],
      },
      {
        name: 'cta',
        label: 'CTA',
        fields: [
          { name: 'title', type: 'string' },
          { name: 'ctaText', type: 'string' },
        ],
      },
    ],
  },
])

export type PostContent = TypeFromEntrySchema<typeof postSchema> & {
  slug: string
}

export const docSchema = defineEntrySchema([
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'description', type: 'string', label: 'Description' },
  // Inline SEO group: metaTitle/metaDescription stored flat in doc frontmatter
  seoGroup,
  // Inline nav group: navText stored flat in doc frontmatter
  navGroup,
  { name: 'body', type: 'markdown', label: 'Body', isBody: true },
])

export type DocContent = TypeFromEntrySchema<typeof docSchema> & {
  slug: string
}

// Entry schema registry for CanopyCMS - references entry schemas by name in .collection.json files
export const entrySchemaRegistry = createEntrySchemaRegistry({
  postSchema,
  authorSchema,
  docSchema,
  homeSchema,
})
