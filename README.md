# CanopyCMS

A schema-driven, branch-aware content management system for git-backed, statically-generated websites. CanopyCMS provides an editing interface on top of your existing git repository, enabling non-technical users to edit website content without touching Git directly. Content lives as MD/MDX/JSON files in your repo, changes happen on isolated branches, and publication flows through your existing GitHub PR workflow.

**Key features:**

- **Schema-enforced content**: Define your content structure with TypeScript - get runtime validation and type inference
- **Branch-based editing**: Every editor works on an isolated branch, preventing conflicts and enabling review workflows
- **Git as source of truth**: All content is versioned in git with full history, rollback, and PR-based review
- **Live preview**: See changes in real-time with click-to-focus field navigation
- **Framework-agnostic core**: Works with Next.js today, adaptable to other frameworks

## Quick Start

### 1. Install packages

```bash
npm install canopycms canopycms-next canopycms-auth-clerk
```

### 2. Create your config file

Create `canopycms.config.ts` in your project root:

```typescript
import { defineCanopyConfig, defineSchema } from 'canopycms'

// Define your content schemas
const postSchema = defineSchema([
  { name: 'title', type: 'string', label: 'Title', required: true },
  { name: 'author', type: 'string', label: 'Author' },
  { name: 'published', type: 'boolean', label: 'Published' },
  { name: 'body', type: 'markdown', label: 'Body' },
])

const homeSchema = defineSchema([
  { name: 'headline', type: 'string', label: 'Headline', required: true },
  { name: 'tagline', type: 'string', label: 'Tagline' },
  { name: 'content', type: 'markdown', label: 'Content' },
])

export default defineCanopyConfig({
  gitBotAuthorName: 'CanopyCMS Bot',
  gitBotAuthorEmail: 'bot@example.com',
  mode: 'dev', // or 'prod-sim' or 'prod'
  schema: {
    // Collections: repeatable entries with shared schema
    collections: [
      {
        name: 'posts',
        label: 'Blog Posts',
        path: 'posts', // Files at content/posts/*.json
        entries: {
          format: 'json',
          fields: postSchema,
        },
      },
    ],
    // Singletons: unique entries with individual schemas
    singletons: [
      {
        name: 'home',
        label: 'Homepage',
        path: 'home', // File at content/home.json
        format: 'json',
        fields: homeSchema,
      },
    ],
  },
})
```

### 2.5. Configure .gitignore

Update your `.gitignore` to properly handle CanopyCMS files:

```gitignore
# CanopyCMS - ignore all runtime directories
.canopy*
```

**That's it!** The single pattern `.canopy*` ignores all CanopyCMS runtime directories:

- `.canopy-dev/` - Dev mode settings (not committed)
- `.canopy-prod-sim/` - Prod-sim branch workspaces and local git remote (not committed)

**Note**: Branch metadata (`.canopy-meta/`) is automatically excluded via git's info/exclude mechanism inside branch workspaces - you don't need to worry about it in your .gitignore.

**Settings in production modes**: Permissions and groups are stored on a separate git branch (`canopycms-settings-{deploymentName}`) and are version-controlled through that branch, not in your working tree.

### 3. Create the Canopy context (one-time setup)

Create `app/lib/canopy.ts`:

```typescript
import { createNextCanopyContext } from 'canopycms-next'
import { createClerkAuthPlugin } from 'canopycms-auth-clerk'
import config from '../../canopycms.config'

const canopyContext = createNextCanopyContext({
  config: config.server,
  authPlugin: createClerkAuthPlugin({
    useOrganizationsAsGroups: true,
  }),
})

export const getCanopy = canopyContext.getCanopy // For server components
export const handler = canopyContext.handler // For API routes
```

### 4. Add the API route handler

Create `app/api/canopycms/[...canopycms]/route.ts`:

```typescript
import { handler } from '../../../lib/canopy'

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
```

### 5. Create the editor page

Create `app/edit/page.tsx`:

```typescript
'use client'

import { useClerkAuthConfig } from 'canopycms-auth-clerk/client'
import { CanopyEditorPage } from 'canopycms/client'
import config from '../../canopycms.config'

export default function EditPage() {
  const clerkAuth = useClerkAuthConfig()
  const clientConfig = config.client(clerkAuth)
  const EditorPage = CanopyEditorPage(clientConfig)
  return <EditorPage searchParams={{}} />
}
```

### 6. Protect editor routes with middleware

Create `middleware.ts`:

```typescript
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

const isProtectedRoute = createRouteMatcher(['/edit(.*)', '/api/canopycms(.*)'])

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect()
  }
})

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
  ],
}
```

## Migration Guides

### Migrating to Unified Schema (v0.x to v1.0)

The schema structure has changed from an array-based format to a unified object-based model. Here's how to migrate:

**Old format (array-based):**

```typescript
schema: [
  {
    type: 'collection',
    name: 'posts',
    path: 'posts',
    format: 'json',
    fields: [...],
  },
  {
    type: 'singleton',  // Previously called "document" in some versions
    name: 'home',
    path: 'home',
    format: 'json',
    fields: [...],
  },
]
```

**New format (object-based):**

```typescript
schema: {
  collections: [
    {
      name: 'posts',
      path: 'posts',
      entries: {        // New: wrap format and fields in 'entries'
        format: 'json',
        fields: [...],
      },
    },
  ],
  singletons: [        // New: top-level key for singletons
    {
      name: 'home',
      path: 'home',
      format: 'json',   // No 'entries' wrapper for singletons
      fields: [...],
    },
  ],
}
```

**Migration checklist:**

1. Change `schema: [...]` to `schema: { collections: [...], singletons: [...] }`
2. Remove `type: 'collection'` from collection definitions
3. Wrap collection `format` and `fields` in an `entries: { ... }` object
4. Remove `type: 'singleton'` (or `type: 'document'`) from singleton definitions
5. Move singletons to the `singletons` array
6. For nested collections, use `collections: [...]` instead of `children: [...]`

### Migrating from Old API

If you're upgrading from a previous version, here's how to migrate to the new simplified API:

### Before (verbose approach)

```typescript
// Every page had to repeat this boilerplate
import { createContentReader } from 'canopycms/server'
import { ANONYMOUS_USER } from 'canopycms'
import config from '../canopycms.config'

const contentReader = createContentReader({ config: config.server })

const Page = async ({ searchParams }) => {
  const { data } = await contentReader.read({
    entryPath: 'content/home',
    branch: searchParams?.branch,
    user: ANONYMOUS_USER,  // No auth
  })
  return <HomeView data={data} />
}
```

### After (clean approach)

**One-time setup** in `app/lib/canopy.ts`:

```typescript
import { createNextCanopyContext } from 'canopycms-next'
import { createClerkAuthPlugin } from 'canopycms-auth-clerk'
import config from '../../canopycms.config'

const canopyContext = createNextCanopyContext({
  config: config.server,
  authPlugin: createClerkAuthPlugin({ useOrganizationsAsGroups: true }),
})

export const getCanopy = canopyContext.getCanopy
export const handler = canopyContext.handler
```

**Then in every page**:

```typescript
import { getCanopy } from './lib/canopy'

const Page = async ({ searchParams }) => {
  const canopy = await getCanopy()
  const { data } = await canopy.read({
    entryPath: 'content/home',
    branch: searchParams?.branch,  // Optional
  })
  return <HomeView data={data} />
}
```

### Migration checklist

1. Create `app/lib/canopy.ts` with `createNextCanopyContext()` setup
2. Replace `createCanopyCatchAllHandler()` in API route with imported `handler`
3. Replace `createContentReader()` calls in pages with `getCanopy()`
4. Remove `user` parameter from `read()` calls (now automatic)
5. Branch parameter is now optional (defaults to main)

## Configuration Reference

### `defineCanopyConfig` Options

| Option                | Type                            | Required | Default     | Description                                                                       |
| --------------------- | ------------------------------- | -------- | ----------- | --------------------------------------------------------------------------------- |
| `schema`              | `RootCollectionConfig`          | Yes      | -           | Object with `collections` and `singletons` arrays defining your content structure |
| `gitBotAuthorName`    | `string`                        | Yes      | -           | Name used for git commits made by CanopyCMS                                       |
| `gitBotAuthorEmail`   | `string`                        | Yes      | -           | Email used for git commits made by CanopyCMS                                      |
| `mode`                | `'dev' \| 'prod-sim' \| 'prod'` | No       | `'dev'`     | Operating mode (see below)                                                        |
| `contentRoot`         | `string`                        | No       | `'content'` | Root directory for content files relative to project root                         |
| `defaultBaseBranch`   | `string`                        | No       | `'main'`    | Default git branch to base edits on                                               |
| `defaultBranchAccess` | `'allow' \| 'deny'`             | No       | `'deny'`    | Default access policy for new branches                                            |
| `defaultPathAccess`   | `'allow' \| 'deny'`             | No       | `'allow'`   | Default access policy for content paths                                           |
| `media`               | `MediaConfig`                   | No       | -           | Asset storage configuration (local, s3, or lfs)                                   |
| `editor`              | `EditorConfig`                  | No       | -           | Editor UI customization options                                                   |

### Operating Modes

- **`dev`**: Direct file editing in your current checkout. Best for solo development. Settings stored in `.canopy-dev/`.
- **`prod-sim`**: Simulates production locally with per-branch clones in `.canopy-prod-sim/branches/`. Use for testing branch workflows.
- **`prod`**: Full production deployment with branch workspaces on persistent storage (e.g., AWS Lambda + EFS).

### Schema Definition

The schema uses a unified object-based structure. The root can contain `collections` (repeatable entries with shared schema) and `singletons` (unique entries with individual schemas). Collections can be nested and can themselves contain entries, subcollections, and singletons.

```typescript
const config = defineCanopyConfig({
  // ...required fields...
  schema: {
    collections: [
      // Collection with repeatable entries (e.g., blog posts)
      {
        name: 'posts',
        label: 'Blog Posts',
        path: 'posts',        // Files at content/posts/*.json
        entries: {
          format: 'json',     // or 'md', 'mdx'
          fields: [...],
        },
      },
      // Nested collections example
      {
        name: 'docs',
        label: 'Documentation',
        path: 'docs',
        entries: {
          format: 'json',
          fields: [...],
        },
        collections: [
          {
            name: 'guides',
            path: 'guides',   // Files at content/docs/{parent}/guides/*.json
            entries: {
              format: 'json',
              fields: [...],
            },
          },
        ],
        singletons: [
          {
            name: 'overview',
            path: 'overview', // File at content/docs/{parent}/overview.json
            format: 'json',
            fields: [...],
          },
        ],
      },
    ],
    singletons: [
      // Singleton: single unique entry (e.g., homepage)
      {
        name: 'home',
        label: 'Homepage',
        path: 'home',         // File at content/home.json
        format: 'json',
        fields: [...],
      },
    ],
  },
})
```

**Key concepts:**

- **Collections** define a set of repeatable entries with a shared schema. Use the `entries` property to define the format and fields.
- **Singletons** define unique, one-off entries with individual schemas. Each singleton has its own `format` and `fields`.
- **Nesting**: Collections can contain `collections` and `singletons` for hierarchical content structures.
- **Unified model**: The same structure applies everywhere - root, collections, and nested collections all work the same way.

### Field Types

| Type        | Description                                     | Options                                          |
| ----------- | ----------------------------------------------- | ------------------------------------------------ |
| `string`    | Single-line text                                | -                                                |
| `number`    | Numeric value                                   | -                                                |
| `boolean`   | True/false toggle                               | -                                                |
| `datetime`  | Date and time picker                            | -                                                |
| `markdown`  | Markdown text editor                            | -                                                |
| `mdx`       | MDX editor with component support               | -                                                |
| `rich-text` | Rich text editor                                | -                                                |
| `image`     | Image upload/selection                          | -                                                |
| `code`      | Code editor with syntax highlighting            | -                                                |
| `select`    | Dropdown selection                              | `options: string[] \| {label, value}[]`          |
| `reference` | Reference to another content entry (UUID-based) | `collections: string[]`, `displayField?: string` |
| `object`    | Nested object                                   | `fields: FieldConfig[]`                          |
| `block`     | Block-based content                             | `templates: BlockTemplate[]`                     |

**Common field options:**

```typescript
{
  name: 'fieldName',      // Required: unique field identifier
  type: 'string',         // Required: field type
  label: 'Field Label',   // Optional: display label (defaults to name)
  required: true,         // Optional: validation requirement
  list: true,             // Optional: allow multiple values
}
```

**Example with reference field:**

```typescript
const schema = defineSchema([
  { name: 'title', type: 'string', label: 'Title', required: true },
  { name: 'body', type: 'markdown', label: 'Content' },
  {
    name: 'author',
    type: 'reference',
    label: 'Author',
    collections: ['authors'], // Load options from 'authors' collection
    displayField: 'name', // Show the author's name in the dropdown
  },
  {
    name: 'relatedPosts',
    type: 'reference',
    label: 'Related Posts',
    collections: ['posts'],
    displayField: 'title',
    list: true, // Allow multiple references
  },
])
```

**Example with all field types:**

```typescript
const schema = defineSchema([
  { name: 'title', type: 'string', label: 'Title', required: true },
  { name: 'views', type: 'number', label: 'View Count' },
  { name: 'published', type: 'boolean', label: 'Published' },
  { name: 'publishDate', type: 'datetime', label: 'Publish Date' },
  { name: 'body', type: 'markdown', label: 'Content' },
  { name: 'featuredImage', type: 'image', label: 'Featured Image' },
  {
    name: 'category',
    type: 'select',
    label: 'Category',
    options: ['tech', 'lifestyle', 'news'],
  },
  {
    name: 'author',
    type: 'reference',
    label: 'Author',
    collections: ['authors'],
    displayField: 'name',
  },
  {
    name: 'metadata',
    type: 'object',
    label: 'SEO Metadata',
    fields: [
      { name: 'description', type: 'string' },
      { name: 'keywords', type: 'string', list: true },
    ],
  },
  {
    name: 'blocks',
    type: 'block',
    label: 'Page Blocks',
    templates: [
      {
        name: 'hero',
        label: 'Hero Section',
        fields: [
          { name: 'headline', type: 'string' },
          { name: 'body', type: 'markdown' },
        ],
      },
      {
        name: 'cta',
        label: 'Call to Action',
        fields: [
          { name: 'text', type: 'string' },
          { name: 'link', type: 'string' },
        ],
      },
    ],
  },
])
```

## Content Identification & References

### UUID-Based IDs

Every entry in your content automatically receives a unique, stable identifier. CanopyCMS uses 22-character UUIDs (Base58-encoded) that are:

- **Stable across renames and moves**: When you rename a file or move it to a different directory, the ID never changes
- **Globally unique**: IDs are automatically generated and guaranteed unique across your entire site
- **Git-friendly**: IDs are stored as symlinks in `content/_ids_/` (e.g., `content/_ids_/abc123DEF456ghi789`), making them visible in git diff
- **Automatic**: You never manually create or manage IDs - they're generated when entries are created

### Reference Fields

Reference fields let you create typed relationships between content entries. Unlike brittle string links or file paths, references use UUIDs to create robust, move-safe links:

```typescript
const schema = defineSchema([
  { name: 'title', type: 'string', label: 'Title' },
  {
    name: 'category',
    type: 'reference',
    label: 'Category',
    collections: ['categories'], // Only allow references to entries in 'categories'
    displayField: 'name', // Show the category name (not the ID) in the UI
  },
  {
    name: 'tags',
    type: 'reference',
    label: 'Tags',
    collections: ['tags'],
    displayField: 'label',
    list: true, // Allow multiple references
  },
])
```

**Key benefits:**

- **Type safety**: The editor validates that references always point to valid entries
- **Dynamic options**: The reference field automatically loads available options from the specified collections
- **Move-safe**: References survive file renames and directory moves - the ID is permanent
- **No broken links**: If you delete an entry, you'll see validation errors on any entries referencing it
- **Display flexibility**: Show any field from the referenced entry (title, name, slug, etc.) in dropdowns

### How References Work in the Editor

When editing a reference field:

1. Click the dropdown to see all available entries from the configured collections
2. Search by the display field value (e.g., search for author names)
3. Select an entry - CanopyCMS stores the UUID internally
4. When reading content, the UUID is resolved to the actual entry data

### Using References in Your Code

When you read content with references, CanopyCMS stores the UUIDs. To resolve them back to data:

```typescript
// In your server component
const { data } = await canopy.read({
  entryPath: 'content/posts',
  slug: 'my-post',
})

// data.author is a UUID string (e.g., "abc123DEF456ghi789")
// You would need to separately load the author entry if needed
const author = await canopy.read({
  entryPath: 'content/authors',
  id: data.author,
})
```

### Type Inference

Use `TypeFromSchema` to get TypeScript types from your schema:

```typescript
import { defineSchema, TypeFromSchema } from 'canopycms'

const postSchema = defineSchema([
  { name: 'title', type: 'string', required: true },
  { name: 'tags', type: 'string', list: true },
])

// Inferred type: { title: string; tags: string[] }
type Post = TypeFromSchema<typeof postSchema>
```

## Integration Guide

### Reading Content in Server Components

The `getCanopy()` function provides automatic authentication and branch handling in Next.js server components:

```typescript
// app/posts/[slug]/page.tsx
import { getCanopy } from '../lib/canopy'

export default async function PostPage({ params, searchParams }) {
  const canopy = await getCanopy()

  const { data } = await canopy.read({
    entryPath: 'content/posts',
    slug: params.slug,
    branch: searchParams?.branch,  // Optional: defaults to main
  })

  return <PostView post={data} />
}
```

**Key benefits:**

- **Automatic authentication**: Current user extracted from request headers via auth plugin
- **Bootstrap admin groups**: Admin users automatically get `admins` group membership
- **Build mode support**: Permissions bypassed during `next build` for static generation
- **Type-safe**: Full TypeScript support with inferred types from your schema
- **Per-request caching**: Context is cached using React's `cache()` for the request lifecycle

**The context object provides:**

- `read()`: Read content with automatic auth and branch resolution
- `user`: Current authenticated user (with bootstrap admin groups applied)
- `services`: Underlying CanopyCMS services for advanced use cases

### Advanced: Using createContentReader Directly

For cases where you need more control (e.g., reading as a specific user or in non-request contexts), you can use the lower-level `createContentReader`:

```typescript
import { createContentReader } from 'canopycms/server'
import { ANONYMOUS_USER } from 'canopycms'
import config from '../canopycms.config'

const reader = createContentReader({ config: config.server })

const { data } = await reader.read({
  entryPath: 'content/posts',
  slug: 'my-post',
  branch: 'main',
  user: ANONYMOUS_USER, // Explicit user required
})
```

### Media Configuration

Not Yet Implemented

### Editor Customization

```typescript
editor: {
  title: 'My CMS',
  subtitle: 'Content Editor',
  theme: {
    colors: {
      brand: '#4f46e5',
      accent: '#0ea5e9',
      neutral: '#0f172a',
    },
  },
}
```

## Features

### Robust Content Relationships

Every entry gets an automatic UUID that stays the same even when you rename or move files. Reference fields use these IDs to create type-safe relationships that never break. The editor shows human-readable labels while storing stable identifiers, optimizing both for user experience and data integrity.

### Branch-Based Editing Workflow

1. **Create or select a branch**: Each editor works in isolation
2. **Make changes**: Edits are saved to the branch workspace
3. **Submit for review**: Creates a GitHub PR with all changes
4. **Review and merge**: Standard PR workflow on GitHub
5. **Deploy**: Your CI/CD rebuilds the site after merge

### Comments System

Comments enable asynchronous review workflows at three levels:

- **Field comments**: Attached to specific form fields for targeted feedback
- **Entry comments**: General feedback on an entire content entry
- **Branch comments**: Discussion about the overall changeset

Comments are stored in `.canopy-meta/comments.json` per branch workspace and are NOT committed to git (they're review artifacts, excluded via git's info/exclude mechanism).

### Permission Model

Access control uses three layers:

1. **Branch access**: Per-branch ACLs control who can access each branch
2. **Path permissions**: Glob patterns restrict who can edit specific content paths
3. **Reserved groups**: `admins` (full access) and `reviewers` (review branches, approve PRs)

**Bootstrap admin groups**: When using `getCanopy()`, users with IDs matching the `bootstrapAdminIds` configuration automatically receive the `admins` group membership, even before groups are set up in the repository. This makes initial setup easier.

**Build mode bypass**: During `next build`, all permission checks are bypassed to allow static generation of all content, regardless of auth configuration.

**Settings storage by mode:**

- **Dev mode**: Settings stored in `.canopy-dev/groups.json` and `.canopy-dev/permissions.json` (gitignored, for local development only)
- **Prod/Prod-sim modes**: Settings stored on a separate orphan branch named `canopycms-settings-{deploymentName}` (version-controlled, deployment-specific)

Settings files include a `contentVersion` field for optimistic locking to prevent concurrent admin updates from overwriting each other.

### Live Preview

The editor shows a live preview of your actual site pages in an iframe. Changes update immediately via postMessage. Clicking elements in the preview focuses the corresponding form field.

## Adopter Touchpoints Summary

CanopyCMS is designed for minimal integration effort. You need:

1. **Config file** (`canopycms.config.ts`): Schema and settings
2. **Canopy context** (`app/lib/canopy.ts`): One-time setup with auth plugin
3. **API route** (`/api/canopycms/[...canopycms]`): Export the handler from context
4. **Editor page** (`/edit`): Embed the editor component
5. **Middleware**: Protect editor routes with authentication
6. **Server components**: Use `getCanopy()` to read content with automatic auth

Everything else (branch management, content storage, permissions, comments, bootstrap admin groups) is handled automatically by CanopyCMS.

## Environment Variables

For CanopyCMS:

```env
CANOPY_BOOTSTRAP_ADMIN_IDS=user_123,user_456  # Comma-separated user IDs that get auto-admin access
```

For Clerk authentication:

```env
CLERK_SECRET_KEY=sk_...
CLERK_PUBLISHABLE_KEY=pk_...
CLERK_JWT_KEY=...           # Optional: for networkless JWT verification
CLERK_AUTHORIZED_PARTIES=... # Optional: comma-separated domains
```

For GitHub integration (production mode):

```env
GITHUB_BOT_TOKEN=ghp_...    # Bot token for PR creation
```

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - Internal architecture and design decisions
- [DEVELOPING.md](DEVELOPING.md) - Development guidelines for contributors
