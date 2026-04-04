# CanopyCMS

A schema-driven, branch-aware content management system for git-backed, statically-generated websites. CanopyCMS provides an editing interface on top of your existing git repository, enabling non-technical users to edit website content without touching Git directly. Content lives as MD/MDX/JSON files in your repo, changes happen on isolated branches, and publication flows through your existing GitHub PR workflow.

**Key features:**

- **Schema-enforced content**: Define your content structure with TypeScript - get runtime validation and type inference
- **Flexible schema definition**: Use config-based schemas, `.collection.json` meta files, or a hybrid approach
- **Branch-based editing**: Every editor works on an isolated branch, preventing conflicts and enabling review workflows
- **Git as source of truth**: All content is versioned in git with full history, rollback, and PR-based review
- **Live preview**: See changes in real-time with click-to-focus field navigation
- **Minimal integration**: Just config, one editor component, and one API route
- **Framework-agnostic core**: Works with Next.js today, adaptable to other frameworks

## Table of Contents

- [Quick Start](#quick-start)
- [Schema Registry and References](#schema-references-system)
- [Configuration Reference](#configuration-reference)
- [Content Identification and References](#content-identification--references)
- [Integration Guide](#integration-guide)
- [Content Tree Builder](#content-tree-builder)
- [Features](#features)
- [AI-Ready Content](#ai-ready-content)
- [Using the Editor](#using-the-editor)
- [Adopter Touchpoints Summary](#adopter-touchpoints-summary)
- [Local Development Sync](#local-development-sync)
- [Environment Variables](#environment-variables)
- [Documentation](#documentation)

## Quick Start

### 1. Run the init command

```bash
npx canopycms init
```

The CLI will interactively ask for:

- **Auth provider** — `dev` (local development, no real auth) or `clerk` (Clerk authentication). This only affects the post-init instructions; the generated code handles both providers at runtime via the `CANOPY_AUTH_MODE` environment variable.
- **Operating mode** — `dev` (full local development with branching and git ops) or `prod` (production deployment). This is written into `canopycms.config.ts`.
- **App directory** — where your Next.js app directory lives (default: `app`, use `src/app` for src-layout projects)
- **Include AI content endpoint?** — generates route files to serve your content as AI-readable markdown (default: yes). See [AI-Ready Content](#ai-ready-content) for details.

You can also pass flags to skip prompts:

```bash
npx canopycms init --app-dir app
```

Use `--non-interactive` for CI (uses defaults), `--force` to overwrite existing files, or `--no-ai` to skip generating the AI content endpoint.

### What it creates

| File                                             | Purpose                                                        |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `canopycms.config.ts`                            | Main configuration (mode, editor settings)                     |
| `{appDir}/lib/canopy.ts`                         | Server-side context setup with auth plugin selection           |
| `{appDir}/schemas.ts`                            | Entry schema definitions and registry                          |
| `{appDir}/api/canopycms/[...canopycms]/route.ts` | Single catch-all API route handler                             |
| `{appDir}/edit/page.tsx`                         | Editor page component                                          |
| `{appDir}/ai/config.ts`                          | AI content configuration (included unless `--no-ai` is passed) |
| `{appDir}/ai/[...path]/route.ts`                 | AI content route handler (included unless `--no-ai` is passed) |

It also updates `.gitignore` to exclude CanopyCMS runtime directories (`.canopy-dev/`).

### 2. Install dependencies

```bash
npm install canopycms canopycms-next canopycms-auth-dev canopycms-auth-clerk
```

The generated `canopy.ts` template imports both auth packages and selects the active one at runtime based on the `CANOPY_AUTH_MODE` environment variable (defaults to `dev`). Both packages must be installed.

**Clerk peer dependencies:** `canopycms-auth-clerk` declares `@clerk/nextjs` and `@clerk/backend` as peer dependencies. If you plan to use Clerk authentication, you must install them yourself:

```bash
npm install @clerk/nextjs @clerk/backend
```

These are not bundled with `canopycms-auth-clerk` so you control the Clerk SDK versions in your project. If you only use dev auth (the default), you can skip this step -- the Clerk peer dependency warnings are harmless when `CANOPY_AUTH_MODE=dev`.

### 3. Configure Next.js

Wrap your Next.js config with `withCanopy()`:

```typescript
// next.config.ts
import { withCanopy } from 'canopycms-next'

export default withCanopy({
  // ...your existing Next.js config
})
```

`withCanopy()` handles two things:

- **Transpilation** — Canopy packages export raw TypeScript; the wrapper adds them to `transpilePackages` automatically.
- **React deduplication** — When developing locally with `file:` references or linked packages (`npm link`, `pnpm link`, etc.), the bundler can follow symlinks and load a second copy of React from the linked package's `node_modules`, causing "Invalid hook call" crashes. The wrapper adds module aliases so React always resolves to your project's copy.

The React aliases are harmless when not strictly needed (e.g., when installing from npm), so `withCanopy()` is the recommended configuration for all adopters.

### 4. Customize your schemas

Edit `{appDir}/schemas.ts` with your content types. See [Schema Registry and References](#schema-references-system) for details.

### 5. Protect editor routes (Clerk only)

If using Clerk auth, add `middleware.ts` to protect editor routes:

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

### 6. Run

```bash
npm run dev
# Visit http://localhost:3000/edit
```

### .gitignore

The init command adds `.canopy-dev/` to your `.gitignore`. Branch metadata is automatically excluded via git's `info/exclude` inside branch workspaces. In production mode, permissions and groups live on a separate git branch (`canopycms-settings-{deploymentName}`).

## Schema Registry and References

CanopyCMS supports two approaches for defining your content schema:

1. **Config-based schemas**: Define everything in `canopycms.config.ts` (traditional approach)
2. **Meta file schemas**: Define collections using `.collection.json` files in your content directories (new approach)
3. **Hybrid**: Mix both approaches - use meta files for some collections and config for others

The meta file approach provides better separation of concerns by colocating schema definitions with content, making it easier to manage large content structures.

### How It Works

The schema references system has three key components:

1. **Schema Registry**: A centralized registry of reusable field schemas defined in TypeScript
2. **Meta Files**: `.collection.json` files that reference schemas from the registry
3. **Automatic Loading**: CanopyCMS automatically scans your content directory for meta files and resolves schema references

### Setting Up a Schema Registry

Create a schemas file (e.g., `app/schemas.ts`) to define your field schemas and registry:

```typescript
import { defineEntrySchema } from 'canopycms'
import { createEntrySchemaRegistry } from 'canopycms/server'

// Define your field schemas
export const postSchema = defineEntrySchema([
  { name: 'title', type: 'string', label: 'Title', required: true },
  {
    name: 'author',
    type: 'reference',
    label: 'Author',
    collections: ['authors'],
    displayField: 'name',
  },
  { name: 'published', type: 'boolean', label: 'Published' },
  { name: 'body', type: 'markdown', label: 'Body' },
])

export const authorSchema = defineEntrySchema([
  { name: 'name', type: 'string', label: 'Name', required: true },
  { name: 'bio', type: 'string', label: 'Bio' },
  { name: 'avatar', type: 'image', label: 'Avatar' },
])

export const homeSchema = defineEntrySchema([
  { name: 'headline', type: 'string', label: 'Headline', required: true },
  { name: 'tagline', type: 'string', label: 'Tagline' },
  { name: 'content', type: 'markdown', label: 'Content' },
])

// Create the registry - validates schemas at creation time
export const entrySchemaRegistry = createEntrySchemaRegistry({
  postSchema,
  authorSchema,
  homeSchema,
})
```

### Creating .collection.json Meta Files

Create `.collection.json` files in your content directories to define collections:

**For a collection** (`content/posts/.collection.json`):

```json
{
  "name": "posts",
  "label": "Blog Posts",
  "entries": [
    {
      "name": "post",
      "format": "json",
      "schema": "postSchema"
    }
  ]
}
```

**For a singleton-like entry** (`content/pages/.collection.json`):

```json
{
  "name": "pages",
  "label": "Pages",
  "entries": [
    {
      "name": "home",
      "label": "Homepage",
      "format": "json",
      "schema": "homeSchema",
      "maxItems": 1
    }
  ]
}
```

**For nested collections** (`content/docs/.collection.json`):

```json
{
  "name": "docs",
  "label": "Documentation",
  "entries": [
    {
      "name": "doc",
      "format": "mdx",
      "schema": "docSchema"
    }
  ]
}
```

Then create nested collections in subfolders (e.g., `content/docs/guides/.collection.json`):

```json
{
  "name": "guides",
  "label": "Guides",
  "entries": [
    {
      "name": "guide",
      "format": "mdx",
      "schema": "guideSchema"
    }
  ]
}
```

### Connecting the Schema Registry

Pass your schema registry to `createNextCanopyContext` in `app/lib/canopy.ts`. The generated template handles auth provider selection at runtime:

```typescript
import { createNextCanopyContext } from 'canopycms-next'
import { createClerkAuthPlugin, createClerkJwtVerifier } from 'canopycms-auth-clerk'
import { createDevAuthPlugin, createDevTokenVerifier } from 'canopycms-auth-dev'
import type { AuthPlugin } from 'canopycms/auth'
import { CachingAuthPlugin, FileBasedAuthCache } from 'canopycms/auth/cache'
import config from '../../canopycms.config'
import { entrySchemaRegistry } from '../schemas'

function getAuthPlugin(): AuthPlugin {
  const mode = config.server.mode
  const authMode = process.env.CANOPY_AUTH_MODE || 'dev'

  // In prod mode: use CachingAuthPlugin (networkless JWT + file-based cache)
  if (mode === 'prod') {
    const cachePath = process.env.CANOPY_AUTH_CACHE_PATH ?? '/mnt/efs/workspace/.cache'
    const tokenVerifier =
      authMode === 'clerk'
        ? createClerkJwtVerifier({ jwtKey: process.env.CLERK_JWT_KEY ?? '' })
        : createDevTokenVerifier()
    return new CachingAuthPlugin(tokenVerifier, new FileBasedAuthCache(cachePath))
  }

  // In dev mode: use auth plugin directly (CachingAuthPlugin is auto-wrapped
  // by createNextCanopyContext when the plugin exposes verifyTokenOnly)
  if (authMode === 'clerk') {
    return createClerkAuthPlugin({ useOrganizationsAsGroups: true })
  }
  return createDevAuthPlugin()
}

// Static deployments don't need auth — no HTTP requests, no users.
// Server deployments should provide authPlugin for authenticated reads.
const isStaticDeploy = config.server.deployedAs === 'static'

const canopyContextPromise = createNextCanopyContext({
  config: config.server,
  ...(!isStaticDeploy ? { authPlugin: getAuthPlugin() } : {}),
  entrySchemaRegistry, // Enable .collection.json file support
})

export const getCanopy = async () => {
  const context = await canopyContextPromise
  return context.getCanopy()
}

export const getHandler = async () => {
  const context = await canopyContextPromise
  return context.handler
}
```

### Meta File Format Reference

**.collection.json structure:**

```typescript
{
  "name": "collectionName",      // Required: collection identifier
  "label": "Display Name",        // Optional: human-readable label
  "entries": [                    // Optional: array of entry types in this collection
    {
      "name": "entryTypeName",    // Required: entry type identifier
      "label": "Display Name",    // Optional: human-readable label
      "format": "json" | "md" | "mdx",  // Optional: defaults to json
      "schema": "schemaRegistryKey",    // Required: key from schema registry
      "maxItems": 1               // Optional: limit instances (1 = singleton-like)
    }
  ]
}
```

**Root .collection.json** (`content/.collection.json`):

```typescript
{
  "entries": [                    // Optional: entry types at root level
    {
      "name": "home",
      "format": "json",
      "schema": "homeSchema",
      "maxItems": 1               // Singleton-like: only one homepage
    }
  ]
}
```

### Directory Structure Example

Here's how your content directory might look with meta files:

```
content/
├── pages/
│   ├── .collection.json      # Pages collection (homepage entry type with maxItems: 1)
│   └── page.home.a1b2c3d4e5f6.json  # Homepage entry (type.slug.id.ext)
├── posts/
│   ├── .collection.json      # Posts collection definition
│   ├── post.my-first-post.x9y8z7w6v5u4.json
│   └── post.another-post.q3r4s5t6u7v8.json
├── authors/
│   ├── .collection.json      # Authors collection definition
│   ├── alice.json
│   └── bob.json
└── docs/
    ├── .collection.json      # Docs collection definition
    ├── intro.mdx
    ├── guides/
    │   ├── .collection.json  # Nested guides collection
    │   ├── getting-started.mdx
    │   └── advanced.mdx
    └── api/
        ├── .collection.json  # Nested API docs collection
        └── reference.mdx
```

### Benefits of Schema References

**Separation of Concerns:**

- Content structure lives near the content itself
- TypeScript schemas provide type safety and reusability
- Easy to reorganize content without touching config

**Scalability:**

- Add new collections by creating a folder and meta file
- Schema registry keeps field definitions DRY
- Large content structures are easier to navigate

**Flexibility:**

- Use meta files for some collections, config for others
- Override or extend meta file schemas in config if needed
- Gradual migration path from config-based to meta file approach

### Hybrid Approach

You can mix both approaches in the same project:

```typescript
// canopycms.config.ts
export default defineCanopyConfig({
  schema: {
    // Config-based collection
    collections: [
      {
        name: 'pages',
        label: 'Pages',
        path: 'pages',
        entries: [
          {
            name: 'page',
            format: 'mdx',
            schema: pageSchema, // Inline schema definition
          },
        ],
      },
    ],
    // Note: Collections defined in .collection.json files will be
    // automatically merged with these config-based collections
  },
  // ...other config
})
```

Collections defined in `.collection.json` files are automatically loaded and merged with any collections defined in your config. This gives you maximum flexibility to choose the best approach for each part of your content structure.

### Schema Validation

CanopyCMS validates schema references at startup:

- **Missing schemas**: Clear error messages if a referenced schema doesn't exist in the registry
- **Invalid meta files**: JSON validation with helpful error messages
- **Type safety**: Schema registry gets full TypeScript type checking

**Example error message:**

```
Error: Schema reference "postSchema" in collection "posts" not found in registry.
Available schemas: authorSchema, homeSchema, docSchema
```

## Configuration Reference

### `defineCanopyConfig` Options

| Option                | Type                   | Required | Default     | Description                                                                                                                                                                                              |
| --------------------- | ---------------------- | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`              | `RootCollectionConfig` | No\*     | -           | Object with `collections` and `entries` arrays defining your content structure. \*Required unless using `.collection.json` meta files                                                                    |
| `gitBotAuthorName`    | `string`               | Yes      | -           | Name used for git commits made by CanopyCMS                                                                                                                                                              |
| `gitBotAuthorEmail`   | `string`               | Yes      | -           | Email used for git commits made by CanopyCMS                                                                                                                                                             |
| `mode`                | `'dev' \| 'prod'`      | No       | `'dev'`     | Operating mode (see below)                                                                                                                                                                               |
| `contentRoot`         | `string`               | No       | `'content'` | Root directory for content files relative to project root                                                                                                                                                |
| `defaultBaseBranch`   | `string`               | No       | `'main'`    | Default git branch to base edits on                                                                                                                                                                      |
| `defaultBranchAccess` | `'allow' \| 'deny'`    | No       | `'deny'`    | Default access policy for new branches                                                                                                                                                                   |
| `defaultPathAccess`   | `'allow' \| 'deny'`    | No       | `'allow'`   | Default access policy for content paths                                                                                                                                                                  |
| `deployedAs`          | `'server' \| 'static'` | No       | `'server'`  | Deployment shape. `'static'`: site is pre-built with no live editor; all CMS API requests return 401 and `authPlugin` is not required. `'server'`: normal server-rendered deployment with auth enforced. |
| `media`               | `MediaConfig`          | No       | -           | Asset storage configuration (local, s3, or lfs)                                                                                                                                                          |
| `editor`              | `EditorConfig`         | No       | -           | Editor UI customization options                                                                                                                                                                          |

**Note**: You must define your schema using at least one of these approaches:

- Config-based: Set the `schema` option in `defineCanopyConfig`
- Meta file-based: Create `.collection.json` files in your content directory (requires passing `entrySchemaRegistry` to `createNextCanopyContext`)
- Hybrid: Use both approaches together - schemas will be merged

See the [Schema Registry and References](#schema-references-system) section for details on using `.collection.json` meta files.

### Operating Modes

- **`dev`**: Full-featured local development with branching and git operations. Uses a local bare remote at `.canopy-dev/remote.git` and branch workspaces at `.canopy-dev/content-branches/`. `defaultBaseBranch` is auto-detected from the current git HEAD if not set. Add `.canopy-dev/` to `.gitignore`.
- **`prod`**: Production deployment with branch workspaces on persistent storage (e.g., AWS Lambda + EFS). Permissions and groups are tracked in git on an orphan settings branch.

### Local Development Sync

When working in `dev` mode, your content lives in two places: the working tree of your repo and the branch workspaces inside `.canopy-dev/content-branches/` that the CMS editor reads from. The `canopycms sync` command keeps them in sync.

**Push** (working tree → branch workspace) -- copies your current working-tree content into a branch workspace and commits it, so the CMS editor sees your latest changes (e.g., after pulling from GitHub or editing files directly):

```bash
npx canopycms sync --push
```

**Pull** (branch workspace → working tree) -- copies content from a CMS branch workspace back into your working tree so you can review, commit, and push the changes yourself:

```bash
npx canopycms sync --pull
```

Both push and pull support `--branch` to target a specific workspace. If multiple branch workspaces exist and no `--branch` is given, the CLI will prompt you to choose one:

```bash
npx canopycms sync --pull --branch update-homepage
```

**Both directions** (3-way merge) -- when neither `--push` nor `--pull` is given, sync merges your working-tree changes with any editor changes using a 3-way git merge, then pulls the merged result back into your working tree:

```bash
npx canopycms sync
```

This is useful when both you and the editor have made changes to the same branch and you want to reconcile them in one step.

**Abort** -- if a merge fails due to conflicts, you can cancel it and restore the branch workspace to its pre-merge state:

```bash
npx canopycms sync --abort
```

### Schema Definition

The schema uses a unified collection-based structure. Collections contain **entry types**, which define the types of content allowed within that collection. Each entry type has its own schema (fields), format, and optional cardinality constraints.

**Entry types** define what kind of content can exist in a collection:

- For repeatable content (blog posts, products), create an entry type without restrictions
- For unique content (homepage, settings), create an entry type with `maxItems: 1`
- You can mix multiple entry types in a single collection

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
        entries: [
          {
            name: 'post',
            format: 'json',   // or 'md', 'mdx'
            schema: [...],
          },
        ],
      },
      // Collection with singleton-like entry (e.g., homepage)
      {
        name: 'pages',
        label: 'Pages',
        path: 'pages',
        entries: [
          {
            name: 'home',
            label: 'Homepage',
            format: 'json',
            schema: [...],
            maxItems: 1,      // Only one homepage allowed
          },
        ],
      },
      // Collection with multiple entry types
      {
        name: 'docs',
        label: 'Documentation',
        path: 'docs',
        entries: [
          {
            name: 'guide',
            label: 'Guide',
            format: 'mdx',
            schema: [...],
          },
          {
            name: 'tutorial',
            label: 'Tutorial',
            format: 'mdx',
            schema: [...],
          },
        ],
        // Nested collections
        collections: [
          {
            name: 'api',
            label: 'API Reference',
            path: 'api',
            entries: [
              {
                name: 'endpoint',
                format: 'mdx',
                schema: [...],
              },
            ],
          },
        ],
      },
    ],
    // Entry types at root level (optional)
    entries: [
      {
        name: 'settings',
        label: 'Site Settings',
        format: 'json',
        schema: [...],
        maxItems: 1,          // Singleton-like at root level
      },
    ],
  },
})
```

**Key concepts:**

- **Collections** are containers for content, organized by path (e.g., `posts`, `docs/guides`)
- **Entry types** define the types of content within a collection, each with its own schema
- **Multiple entry types**: A collection can have multiple entry types (e.g., "guide" and "tutorial" in docs)
- **Singleton-like behavior**: Use `maxItems: 1` to limit an entry type to a single instance
- **Nesting**: Collections can contain nested collections for hierarchical content structures
- **Root entries**: The root schema can have entry types directly (useful for site-wide settings)

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
const schema = defineEntrySchema([
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
const schema = defineEntrySchema([
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

Every entry in your content automatically receives a unique, stable identifier. CanopyCMS uses 12-character UUIDs (Base58-encoded, truncated) that are:

- **Stable across renames**: The ID is embedded in the filename (e.g., `my-post.a1b2c3d4e5f6.json`), so it persists even when you change the slug portion
- **Globally unique**: IDs are automatically generated and guaranteed unique across your entire site (~2.6 × 10^21 possible IDs)
- **Git-friendly**: IDs are visible in filenames, making them easy to track in git diffs and preserved through `git mv`
- **Human-readable**: Filenames show both the human-friendly slug and the unique ID
- **Automatic**: You never manually create or manage IDs - they're generated when entries are created

### Reference Fields

Reference fields let you create typed relationships between content entries. Unlike brittle string links or file paths, references use UUIDs to create robust, move-safe links:

```typescript
const schema = defineEntrySchema([
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

Use `TypeFromEntrySchema` to get TypeScript types from your schema:

```typescript
import { defineEntrySchema, TypeFromEntrySchema } from 'canopycms'

const postSchema = defineEntrySchema([
  { name: 'title', type: 'string', required: true },
  { name: 'tags', type: 'string', list: true },
])

// Inferred type: { title: string; tags: string[] }
type Post = TypeFromEntrySchema<typeof postSchema>
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
- `buildContentTree()`: Build a typed content tree for navigation, sitemaps, etc. (see [Content Tree Builder](#content-tree-builder))
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

## Content Tree Builder

`buildContentTree()` walks your schema and filesystem to produce a typed tree of all your content -- useful for navigation sidebars, sitemaps, search indexes, breadcrumbs, and similar use cases. It replaces hundreds of lines of manual filesystem-walking code.

### Basic Usage

```typescript
// app/layout.tsx (or any server component)
import { getCanopy } from './lib/canopy'

export default async function RootLayout({ children }) {
  const canopy = await getCanopy()

  const tree = await canopy.buildContentTree()
  // tree is ContentTreeNode[] — a hierarchy of collections and entries

  return (
    <html>
      <body>
        <Sidebar tree={tree} />
        {children}
      </body>
    </html>
  )
}
```

Each node in the tree has:

- `path` -- URL path (e.g., `"/docs/getting-started"`)
- `logicalPath` -- CMS logical path
- `kind` -- `"collection"` or `"entry"`
- `collection` -- collection metadata (name, label) when `kind === "collection"`
- `entry` -- entry metadata (slug, entryType, format, raw data) when `kind === "entry"`
- `fields` -- custom fields extracted via your `extract` callback
- `children` -- nested nodes (entries + subcollections, ordered by collection ordering)

### Extracting Custom Fields

Use the generic `extract` callback to pull typed fields from each node's raw data (frontmatter for md/mdx, parsed JSON for json entries):

```typescript
interface NavItem {
  title: string
  draft: boolean
  order: number
}

const tree = await canopy.buildContentTree<NavItem>({
  extract: (data) => ({
    title: (data.title as string) ?? '',
    draft: (data.draft as boolean) ?? false,
    order: (data.order as number) ?? 0,
  }),
})

// tree nodes now have typed `fields: NavItem`
// e.g., tree[0].children?.[0].fields?.title
```

### Filtering Nodes

The `filter` callback runs after `extract`, so you can filter based on extracted fields. Returning `false` excludes a node and all its descendants:

```typescript
const tree = await canopy.buildContentTree<NavItem>({
  extract: (data) => ({
    title: (data.title as string) ?? '',
    draft: (data.draft as boolean) ?? false,
    order: (data.order as number) ?? 0,
  }),
  filter: (node) => node.fields?.draft !== true,
})
```

### Custom Sorting

By default, children at each level are sorted by the collection's `order` array first, then alphabetically. The `sort` option lets you replace this entirely with your own comparator. It runs after `extract` and `filter`, so `fields` is available on every node:

```typescript
const tree = await canopy.buildContentTree<NavItem>({
  extract: (data) => ({
    title: (data.title as string) ?? '',
    draft: (data.draft as boolean) ?? false,
    order: (data.order as number) ?? 0,
  }),
  filter: (node) => node.fields?.draft !== true,
  sort: (a, b) => (a.fields?.order ?? 0) - (b.fields?.order ?? 0),
})
```

### Options Reference

| Option      | Type                                                       | Default                       | Description                                                     |
| ----------- | ---------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------- |
| `rootPath`  | `string`                                                   | Content root                  | Starting collection path (e.g., `"content/docs"` for a subtree) |
| `extract`   | `(data, node) => T`                                        | -                             | Extract typed custom fields from raw entry/collection data      |
| `filter`    | `(node: ContentTreeNode<T>) => boolean`                    | -                             | Return false to exclude a node and its descendants              |
| `buildPath` | `(logicalPath, kind) => string`                            | Strips content root           | Custom URL path builder                                         |
| `sort`      | `(a: ContentTreeNode<T>, b: ContentTreeNode<T>) => number` | Order array then alphabetical | Custom sort for children at each level (replaces default sort)  |
| `maxDepth`  | `number`                                                   | Unlimited                     | Maximum depth to traverse                                       |

### Imports

```typescript
// Types (for use in your components)
import type { ContentTreeNode, BuildContentTreeOptions } from 'canopycms'

// Via CanopyContext (recommended)
const canopy = await getCanopy()
const tree = await canopy.buildContentTree(options)

// Raw function (advanced — requires branchRoot, flatSchema, contentRootName)
import { buildContentTree } from 'canopycms/server'
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

### Live Preview

The editor shows a live preview of your actual site pages in an iframe. Changes update immediately via postMessage. Clicking elements in the preview focuses the corresponding form field.

## AI-Ready Content

CanopyCMS can serve your content as clean markdown for AI consumption (LLM tools, Claude Code, documentation chatbots, etc.). Content is converted from your schema-driven JSON/MD/MDX entries into well-structured markdown with a discovery manifest. No authentication is required -- the output is read-only.

All content is included by default (opt-out exclusion model). You can exclude specific collections, entry types, or entries matching a custom predicate.

### Option 1: Route Handler (Runtime)

Serve AI content dynamically from a Next.js catch-all route. Content is generated on first request and cached (in dev mode, regenerated on every request).

**This is set up automatically by `npx canopycms init`** (unless you pass `--no-ai`). The generated files are `{appDir}/ai/config.ts` and `{appDir}/ai/[...path]/route.ts`. To set it up manually, create `app/ai/[...path]/route.ts`:

```typescript
import { createAIContentHandler } from 'canopycms/ai'
import config from '../../../canopycms.config'
import { entrySchemaRegistry } from '../../schemas'

export const GET = createAIContentHandler({
  config: config.server,
  entrySchemaRegistry,
})
```

This serves:

- `GET /ai/manifest.json` -- discovery manifest listing all collections, entries, and bundles
- `GET /ai/posts/my-post.md` -- individual entry as markdown
- `GET /ai/posts/all.md` -- all entries in a collection concatenated
- `GET /ai/bundles/my-bundle.md` -- custom filtered bundle

### Option 2: Static Build (CLI)

Generate AI content as static files during your build process:

```bash
npx canopycms generate-ai-content --output public/ai
```

Options:

- `--output <dir>` -- output directory (default: `public/ai`)
- `--config <path>` -- path to an AI content config file
- `--app-dir <path>` -- app directory where `schemas.ts` lives (default: `app`; use `src/app` for src-layout projects)

### Option 3: Programmatic API

Call the generator directly from a build script:

```typescript
import { generateAIContentFiles } from 'canopycms/build'
import config from './canopycms.config'
import { entrySchemaRegistry } from './app/schemas'

await generateAIContentFiles({
  config: config.server,
  entrySchemaRegistry,
  outputDir: 'public/ai',
})
```

### AI Content Configuration

Use `defineAIContentConfig` to customize what content is generated and how fields are converted:

```typescript
import { defineAIContentConfig } from 'canopycms/ai'

const aiConfig = defineAIContentConfig({
  // Opt-out exclusions
  exclude: {
    collections: ['drafts'], // Skip entire collections
    entryTypes: ['internal-note'], // Skip entry types everywhere
    where: (entry) => entry.data.hidden === true, // Custom predicate
  },

  // Custom bundles (filtered subsets as single files)
  bundles: [
    {
      name: 'research-guides',
      description: 'All research guide content',
      filter: {
        collections: ['docs'],
        entryTypes: ['guide'],
      },
    },
  ],

  // Per-field markdown overrides
  fieldTransforms: {
    dataset: {
      dataFields: (value) =>
        `## Data Fields\n| Name | Type |\n|---|---|\n${(value as Array<{ name: string; type: string }>).map((f) => `| ${f.name} | ${f.type} |`).join('\n')}`,
    },
  },
})
```

Pass the config to either delivery mechanism:

```typescript
// Route handler
export const GET = createAIContentHandler({
  config: config.server,
  entrySchemaRegistry,
  aiConfig,
})

// Static build
await generateAIContentFiles({
  config: config.server,
  entrySchemaRegistry,
  outputDir: 'public/ai',
  aiConfig,
})
```

### Manifest Format

The manifest at `manifest.json` describes all generated content for tool discovery:

```json
{
  "generated": "2026-03-23T12:00:00.000Z",
  "entries": [],
  "collections": [
    {
      "name": "posts",
      "label": "Blog Posts",
      "path": "posts",
      "allFile": "posts/all.md",
      "entryCount": 5,
      "entries": [{ "slug": "my-post", "title": "My Post", "file": "posts/my-post.md" }]
    }
  ],
  "bundles": [
    {
      "name": "research-guides",
      "description": "All research guide content",
      "file": "bundles/research-guides.md",
      "entryCount": 3
    }
  ]
}
```

## Using the Editor

This section describes how to use the CanopyCMS editor interface from a content editor's perspective.

### Getting Started

1. Navigate to your editor URL (e.g., `/edit`)
2. Sign in with your authentication provider (Clerk, etc.)
3. Select or create a branch to work on

### Working with Branches

**Creating a branch:**

1. Click the branch selector in the header
2. Click "New Branch"
3. Enter a descriptive name (e.g., `update-homepage-hero`)
4. Your branch is created and you can start editing

**Switching branches:**

1. Click the branch selector
2. Choose from available branches
3. The editor loads content from the selected branch

### Editing Content

**Selecting an entry:**

1. Use the sidebar to browse collections
2. Click an entry to open it in the editor
3. Create new entries with the "+" button (disabled for entry types with `maxItems: 1` when one already exists)

**Making changes:**

1. Edit fields using the form on the left
2. See changes reflected in the live preview on the right
3. Click "Save" to persist changes to your branch (changes are NOT committed yet)

**Discarding changes:**

- Use "Discard" to revert unsaved changes to the last saved state

### Submitting for Review

When your changes are ready:

1. Click "Submit for Review" in the header
2. This commits your changes and creates a GitHub PR
3. The PR can be reviewed using standard GitHub workflows
4. Once merged, your changes are deployed with the next site build

### Using Comments

**Adding field comments:**

1. Hover over a field label
2. Click the comment icon
3. Type your comment and submit

**Viewing comments:**

- Comments appear as badges on fields
- Click a comment badge to see the thread and add replies

**Resolving comments:**

- Mark comments as resolved once addressed

### Managing Permissions (Admins)

Admins can configure access control:

1. Go to Settings (gear icon)
2. **Groups**: Create groups and add users
3. **Permissions**: Set path-based access rules

## Adopter Touchpoints Summary

CanopyCMS is designed for minimal integration effort. Run `npx canopycms init` to generate all required files, or create them manually. Use `--app-dir` to customize the app directory path (default: `app`).

| Touchpoint       | File                                             | Purpose                                                      |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| **Config**       | `canopycms.config.ts`                            | Define settings and operating mode                           |
| **Next.js wrap** | `next.config.ts`                                 | Wrap with `withCanopy()` from `canopycms-next`               |
| **Schemas**      | `{appDir}/schemas.ts`                            | Field schemas and registry (for `.collection.json` approach) |
| **Context**      | `{appDir}/lib/canopy.ts`                         | One-time async setup with auth plugin                        |
| **API Route**    | `{appDir}/api/canopycms/[...canopycms]/route.ts` | Single catch-all handler                                     |
| **Editor Page**  | `{appDir}/edit/page.tsx`                         | Embed the editor component                                   |
| **Middleware**   | `middleware.ts`                                  | Protect editor routes with authentication (Clerk only)       |

**Optional touchpoints:**

- **Server components**: Use `await getCanopy()` to read draft content with automatic auth
- **AI content route**: `{appDir}/ai/[...path]/route.ts` -- serve content as AI-readable markdown; generated by default during `init` (see [AI-Ready Content](#ai-ready-content))

To switch between auth providers, set the `CANOPY_AUTH_MODE` environment variable (`dev` or `clerk`). The generated code handles both providers without regenerating files.

Everything else (branch management, content storage, permissions, comments, bootstrap admin groups, meta file loading) is handled automatically by CanopyCMS.

## Environment Variables

For CanopyCMS:

```env
CANOPY_AUTH_MODE=dev                           # Auth provider: "dev" (default) or "clerk"
CANOPY_BOOTSTRAP_ADMIN_IDS=user_123,user_456   # Comma-separated user IDs that get auto-admin access
CANOPY_AUTH_CACHE_PATH=/mnt/efs/workspace/.cache  # Override auth cache location (prod mode only)
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

- [DEVELOPING.md](DEVELOPING.md) - Development guidelines for contributors (note: the CanopyCMS monorepo uses **pnpm** workspaces; see DEVELOPING.md for setup)
- [ARCHITECTURE.md](ARCHITECTURE.md) - Internal architecture (for contributors)
