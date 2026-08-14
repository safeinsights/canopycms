import {
  type EntryTypesFromRegistry,
  defineBlockTemplate,
  defineEntrySchema,
  defineInlineFieldGroup,
  defineNestedFieldGroup,
  defineSeoFieldGroup,
} from 'canopycms'
import { createEntrySchemaRegistry } from 'canopycms/server'

// The recommended SEO group, shipped by CanopyCMS: metaTitle / metaDescription / ogImage /
// ogType / canonical / noindex / twitterCard, all optional. Flat by default, so
// TypeFromEntrySchema merges them into the top-level shape and entryToMetadata reads them with
// no configuration. `noindex` drives BOTH robots and sitemap exclusion (see app/sitemap.ts).
const seoGroup = defineSeoFieldGroup()

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

// Reusable "page block" templates: define each section once with defineBlockTemplate(), then drop the
// same consts into any schema's `block` field. A `block` field holds an ordered, repeatable list of
// these heterogeneous templates, discriminated by `template` — the "flexible content" pattern.
const heroBlock = defineBlockTemplate({
  name: 'hero',
  label: 'Hero',
  fields: [
    { name: 'headline', type: 'string' },
    { name: 'body', type: 'markdown' },
  ],
})

const ctaBlock = defineBlockTemplate({
  name: 'cta',
  label: 'CTA',
  fields: [
    { name: 'title', type: 'string' },
    { name: 'ctaText', type: 'string' },
  ],
})

// Shared/referenced block recipe (see README's "Shared / Referenced Blocks"): the actual
// content lives once, in its own entry type below; the block template just holds a
// reference to it, scoped by entryTypes so it isn't tied to any one collection. Editing
// the snippet entry updates every page block that references it.
export const snippetSchema = defineEntrySchema([
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'ctaText', type: 'string', label: 'Button Text' },
])

const sharedCtaBlock = defineBlockTemplate({
  name: 'sharedCta',
  label: 'Shared CTA',
  fields: [
    {
      name: 'snippet',
      type: 'reference',
      label: 'CTA Snippet',
      entryTypes: ['snippet'],
      resolvedSchema: snippetSchema,
    },
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

export const authorSchema = defineEntrySchema([
  { name: 'name', type: 'string', label: 'Name' },
  { name: 'bio', type: 'string', label: 'Bio' },
  // Nested group: author.location.city / author.location.country in content files
  locationGroup,
])

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
  // Ordered, repeatable list of heterogeneous section blocks. The shared templates above are
  // reused here (and could be embedded in other schemas the same way).
  { name: 'blocks', type: 'block', templates: [heroBlock, ctaBlock, sharedCtaBlock] },
])

export const docSchema = defineEntrySchema([
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'description', type: 'string', label: 'Description' },
  // Inline SEO group: metaTitle/metaDescription stored flat in doc frontmatter
  seoGroup,
  // Inline nav group: navText stored flat in doc frontmatter
  navGroup,
  { name: 'body', type: 'markdown', label: 'Body', isBody: true },
])

// Entry schema registry — keyed by entry-type name (the filename token, also the
// string `.collection.json` files reference via the `schema:` property). Keying
// this way lets `EntryTypesFromRegistry<typeof entrySchemaRegistry>` derive the
// typed entry-type map automatically.
export const entrySchemaRegistry = createEntrySchemaRegistry({
  post: postSchema,
  author: authorSchema,
  doc: docSchema,
  home: homeSchema,
  snippet: snippetSchema,
})

// Typed entry-type map — pass as the second generic to `canopy.buildContentTree<NavFields, EntryTypes>`
// to get narrowed access to `meta.indexEntry.data` after switching on `meta.entryType`.
export type EntryTypes = EntryTypesFromRegistry<typeof entrySchemaRegistry>

// Per-schema aliases derive from EntryTypes — single source of truth.
export type HomeContent = EntryTypes['home']
export type AuthorContent = EntryTypes['author']
export type PostContent = EntryTypes['post'] & { slug: string }
export type DocContent = EntryTypes['doc'] & { slug: string }
export type SnippetContent = EntryTypes['snippet']
