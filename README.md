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

// Define your content schema
const postSchema = defineSchema([
  { name: 'title', type: 'string', label: 'Title', required: true },
  { name: 'author', type: 'string', label: 'Author' },
  { name: 'published', type: 'boolean', label: 'Published' },
  { name: 'body', type: 'markdown', label: 'Body' },
])

export default defineCanopyConfig({
  gitBotAuthorName: 'CanopyCMS Bot',
  gitBotAuthorEmail: 'bot@example.com',
  mode: 'local-simple', // or 'local-prod-sim' or 'prod'
  schema: [
    {
      type: 'collection',
      name: 'posts',
      label: 'Blog Posts',
      path: 'posts',
      format: 'json',
      fields: postSchema,
    },
  ],
})
```

### 3. Add the API route handler

Create `app/api/canopycms/[...canopycms]/route.ts`:

```typescript
import { createCanopyCatchAllHandler } from 'canopycms-next'
import { createClerkAuthPlugin } from 'canopycms-auth-clerk'
import config from '../../../../canopycms.config'

const handler = createCanopyCatchAllHandler({
  config: config.server,
  authPlugin: createClerkAuthPlugin({
    useOrganizationsAsGroups: true,
  }),
})

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
```

### 4. Create the editor page

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

### 5. Protect editor routes with middleware

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

## Configuration Reference

### `defineCanopyConfig` Options

| Option                | Type                                           | Required | Default          | Description                                                         |
| --------------------- | ---------------------------------------------- | -------- | ---------------- | ------------------------------------------------------------------- |
| `schema`              | `SchemaItem[]`                                 | Yes      | -                | Array of collections and singletons defining your content structure |
| `gitBotAuthorName`    | `string`                                       | Yes      | -                | Name used for git commits made by CanopyCMS                         |
| `gitBotAuthorEmail`   | `string`                                       | Yes      | -                | Email used for git commits made by CanopyCMS                        |
| `mode`                | `'local-simple' \| 'local-prod-sim' \| 'prod'` | No       | `'local-simple'` | Operating mode (see below)                                          |
| `contentRoot`         | `string`                                       | No       | `'content'`      | Root directory for content files relative to project root           |
| `defaultBaseBranch`   | `string`                                       | No       | `'main'`         | Default git branch to base edits on                                 |
| `defaultBranchAccess` | `'allow' \| 'deny'`                            | No       | `'deny'`         | Default access policy for new branches                              |
| `defaultPathAccess`   | `'allow' \| 'deny'`                            | No       | `'allow'`        | Default access policy for content paths                             |
| `media`               | `MediaConfig`                                  | No       | -                | Asset storage configuration (local, s3, or lfs)                     |
| `editor`              | `EditorConfig`                                 | No       | -                | Editor UI customization options                                     |

### Operating Modes

- **`local-simple`**: Direct file editing in your current checkout. Best for solo development.
- **`local-prod-sim`**: Simulates production locally with per-branch clones in `.canopycms/branches/`. Use for testing branch workflows.
- **`prod`**: Full production deployment with branch workspaces on persistent storage (e.g., AWS Lambda + EFS).

### Schema Definition

Define collections (multiple entries) and singletons (single entry):

```typescript
const config = defineCanopyConfig({
  // ...required fields...
  schema: [
    // Collection: multiple entries (e.g., blog posts)
    {
      type: 'collection',
      name: 'posts',
      label: 'Blog Posts',
      path: 'posts',        // Files at content/posts/*.json
      format: 'json',       // or 'md', 'mdx'
      fields: [...],
    },
    // Singleton: single entry (e.g., homepage)
    {
      type: 'singleton',
      name: 'home',
      label: 'Homepage',
      path: 'home',         // File at content/home.json
      format: 'json',
      fields: [...],
    },
    // Nested collections
    {
      type: 'collection',
      name: 'categories',
      label: 'Categories',
      path: 'categories',
      format: 'json',
      fields: [...],
      children: [
        {
          type: 'collection',
          name: 'subcategories',
          path: 'sub',      // Files at content/categories/{parent}/sub/*.json
          // ...
        }
      ],
    },
  ],
})
```

### Field Types

| Type        | Description                          | Options                                          |
| ----------- | ------------------------------------ | ------------------------------------------------ |
| `string`    | Single-line text                     | -                                                |
| `number`    | Numeric value                        | -                                                |
| `boolean`   | True/false toggle                    | -                                                |
| `datetime`  | Date and time picker                 | -                                                |
| `markdown`  | Markdown text editor                 | -                                                |
| `mdx`       | MDX editor with component support    | -                                                |
| `rich-text` | Rich text editor                     | -                                                |
| `image`     | Image upload/selection               | -                                                |
| `code`      | Code editor with syntax highlighting | -                                                |
| `select`    | Dropdown selection                   | `options: string[] \| {label, value}[]`          |
| `reference` | Reference to another collection      | `collections: string[]`, `displayField?: string` |
| `object`    | Nested object                        | `fields: FieldConfig[]`                          |
| `block`     | Block-based content                  | `templates: BlockTemplate[]`                     |

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

### Reading Content Server-Side

Use `createContentReader` to read content from branch workspaces:

```typescript
// app/posts/[slug]/page.tsx
import { createContentReader } from 'canopycms/server'
import config from '../../../canopycms.config'

const reader = createContentReader({ config: config.server })

export default async function PostPage({ params, searchParams }) {
  const branch = searchParams?.branch ?? 'main'

  const { data } = await reader.read({
    entryPath: 'content/posts',
    slug: params.slug,
    branch,
  })

  return <PostView post={data} />
}
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

Comments are stored in `.canopycms/comments.json` per branch and are NOT committed to git (they're review artifacts).

### Permission Model

Access control uses three layers:

1. **Branch access**: Per-branch ACLs control who can access each branch
2. **Path permissions**: Glob patterns restrict who can edit specific content paths
3. **Reserved groups**: `admins` (full access) and `reviewers` (review branches, approve PRs)

Permissions are stored in `.canopycms/groups.json` and `.canopycms/permissions.json` and ARE committed to git for version control and PR-reviewable changes.

### Live Preview

The editor shows a live preview of your actual site pages in an iframe. Changes update immediately via postMessage. Clicking elements in the preview focuses the corresponding form field.

## Adopter Touchpoints Summary

CanopyCMS is designed for minimal integration effort. You need:

1. **Config file** (`canopycms.config.ts`): Schema and settings
2. **API route** (`/api/canopycms/[...canopycms]`): Single catch-all handler
3. **Editor page** (`/edit`): Embed the editor component
4. **Middleware**: Protect editor routes with authentication

Everything else (branch management, content storage, permissions, comments) is handled internally by CanopyCMS.

## Environment Variables

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
