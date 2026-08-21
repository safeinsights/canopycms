# CanopyCMS

A schema-driven, branch-aware content management system for git-backed, statically-generated websites. CanopyCMS provides an editing interface on top of your existing git repository, enabling non-technical users to edit website content without touching Git directly. Content lives as MD/MDX/JSON files in your repo, changes happen on isolated branches, and publication flows through your existing GitHub PR workflow.

**Key features:**

- **Schema-enforced content**: Define your content structure with TypeScript - get runtime validation and type inference
- **Schema-driven content**: Define entry schemas once with `defineEntrySchema`, register them with `createEntrySchemaRegistry`, and reference them from `.collection.json` files alongside your content
- **Branch-based editing**: Every editor works on an isolated branch, preventing conflicts and enabling review workflows
- **Git as source of truth**: All content is versioned in git with full history, rollback, and PR-based review
- **Live preview**: See changes in real-time with click-to-focus field navigation
- **Minimal integration**: Just config, one editor component, and one API route
- **Framework-agnostic core**: Works with Next.js today, adaptable to other frameworks

## Requirements

- **Next.js**: `^13.5.7`, `^14.2.25`, `^15.2.3`, or `16.x` excluding `16.2.x` (see [Known-bad version: Next 16.2.x](#known-bad-version-next-162x) below). This is `canopycms-next`'s `next` peer dependency range -- installing a version outside it triggers your package manager's peer-dependency warning.
- **React**: `^18.0.0` or `^19.0.0`
- **Node.js**: `>=18` to consume the published packages; `>=22` to work in this monorepo (see `.nvmrc`).

### Known-bad version: Next 16.2.x

Next 16.2.x fork-bombs `next dev --turbopack`: the dev server boots, logs `○ Compiling /`, and the Node process tree self-replicates (255 → 511 → 1023 ...) until the machine saturates. Bisected to Turbopack's PostCSS plugin resolution triggering on any imported CSS file -- including `@mantine/core/styles.css`, which the CanopyCMS editor depends on, so any adopter using the default editor hits this on first `pnpm dev` after upgrading. Not reproducible on Next 16.1.7.

`canopycms-next`'s `next` peer dependency excludes `16.2.x` specifically -- 16.0.x and 16.1.x are unaffected, and 16.3.x+ is allowed because the regression has only been observed and bisected in 16.2.x; it has not been verified as still broken (or fixed) in later releases, so blocking them preemptively would be a guess, not a documented constraint. If you hit this on a version outside 16.2.x, please file an issue so this range can be corrected.

If you're currently on 16.2.x, downgrade to `~16.1.7` (known-good) until this is resolved upstream.

## Table of Contents

- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Schema Registry and References](#schema-registry-and-references)
- [Configuration Reference](#configuration-reference)
- [Content Identification and References](#content-identification--references)
  - [Type Inference](#type-inference)
- [Integration Guide](#integration-guide)
  - [Load Content by URL Path](#load-content-by-url-path)
  - [Index Entries and URL Resolution](#index-entries-and-url-resolution)
  - [Static Export with generateStaticParams](#static-export-with-generatestaticparams)
- [Sanitizing URLs from CMS Content](#sanitizing-urls-from-cms-content)
- [Content Tree Builder](#content-tree-builder)
- [Listing Entries](#listing-entries)
- [Features](#features)
- [AI-Ready Content](#ai-ready-content)
- [Using the Editor](#using-the-editor)
- [Adopter Touchpoints Summary](#adopter-touchpoints-summary)
- [Deploying to AWS](#deploying-to-aws)
- [Local Development Sync](#local-development-sync)
- [Migrating Existing Content](#migrating-existing-content)
- [Environment Variables](#environment-variables)
- [Documentation](#documentation)

## Quick Start

### 1. Run the init command

```bash
npx canopycms init
```

The CLI will interactively ask for:

- **Auth provider** — `dev` (local development, no real auth) or `clerk` (Clerk authentication). `canopy.ts` and the edit page handle both providers at runtime via the `CANOPY_AUTH_MODE` environment variable; `middleware.ts` does not (see [Adopter Touchpoints Summary](#adopter-touchpoints-summary)).
- **Operating mode** — `dev` (full local development with branching and git ops) or `prod` (production deployment). This is written into `canopycms.config.ts` as the required `mode` field -- CanopyCMS has no default and refuses to start without it.
- **Dual-build** — whether you'll build a static public site and a separate server CMS build from the same repo (default: no). When enabled, CMS-only files use `.server.tsx`/`.server.ts` extensions (e.g. `route.server.ts`) so a static export build doesn't pick them up.
- **App directory** — where your Next.js app directory lives (default: `app`, use `src/app` for src-layout projects)
- **Include AI content endpoint?** — generates route files to serve your content as AI-readable markdown (default: yes). See [AI-Ready Content](#ai-ready-content) for details.

You can also pass flags to skip prompts:

```bash
npx canopycms init --app-dir app
```

Use `--non-interactive` for CI (uses defaults), `--force` to overwrite existing files, or `--no-ai` to skip generating the AI content endpoint.

`--auth <clerk|dev>` and `--dual-build` preset the auth-provider and dual-build choices described above directly from the command line -- useful for scripted/CI scaffolding that needs something other than the `--non-interactive` defaults (dev auth, no dual-build):

```bash
npx canopycms init --non-interactive --auth clerk --dual-build --force
```

These two flags apply the same way whether or not `--non-interactive` is set: passing one skips that prompt and uses the given value, while omitting it falls back to the interactive prompt (or, under `--non-interactive`, to the default).

### What it creates

| File                                             | Purpose                                                                                                                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canopycms.config.ts`                            | Main configuration (mode, editor settings)                                                                                                                                        |
| `{appDir}/lib/canopy.ts`                         | Server-side context setup; exports `getCanopy`, phase-selecting `read`/`readByUrlPath`, `contentStaticParams`, `getHandler` (and `getCanopyForBuild` as an advanced escape hatch) |
| `{appDir}/schemas.ts`                            | Entry schema definitions and registry                                                                                                                                             |
| `{appDir}/api/canopycms/[...canopycms]/route.ts` | Single catch-all API route handler                                                                                                                                                |
| `{appDir}/edit/page.tsx`                         | Editor page component                                                                                                                                                             |
| `{appDir}/ai/config.ts`                          | AI content configuration (included unless `--no-ai` is passed)                                                                                                                    |
| `{appDir}/ai/[...path]/route.ts`                 | AI content route handler (included unless `--no-ai` is passed)                                                                                                                    |
| `middleware.ts`                                  | Route protection for `/edit` and `/api/canopycms` (passthrough by default; commented Clerk example inside)                                                                        |
| `next.config.ts`                                 | Next.js config wrapped with `withCanopy()` for transpilation and dual-build support                                                                                               |

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

### 3. Next.js configuration (auto-generated)

The `init` command creates a `next.config.ts` that wraps your config with `withCanopy()` from `canopycms-next/config`. You do not need to set this up manually.

If you already have a `next.config.ts`, the init command will ask before overwriting. To add the wrapper to an existing config, merge it like this:

```typescript
// next.config.ts
import { withCanopy } from 'canopycms-next/config'

export default withCanopy({
  // ...your existing Next.js config
})
```

`withCanopy()` handles three things:

- **Transpilation** — Canopy packages export raw TypeScript; the wrapper auto-detects which Canopy packages are installed and adds only those to `transpilePackages`. You never need to maintain this list manually.
- **React deduplication** — When developing locally with `file:` references or linked packages (`npm link`, `pnpm link`, etc.), the bundler can follow symlinks and load a second copy of React from the linked package's `node_modules`, causing "Invalid hook call" crashes. The wrapper adds module aliases so React always resolves to your project's copy.
- **Dual-build page extensions** — By default, adds `server.ts` and `server.tsx` to Next.js `pageExtensions`, enabling the dual-build convention (see below).

The React aliases are harmless when not strictly needed (e.g., when installing from npm), so `withCanopy()` is the recommended configuration for all adopters.

#### Dual-Build Sites (Static Export + CMS Server)

If you deploy both a **static public site** and a **separate CMS server** from the same Next.js app, use the `staticBuild` option and the `.server.ts`/`.server.tsx` file extension convention:

1. **Name CMS-only files** with `.server.ts` or `.server.tsx` extensions (e.g., `route.server.ts`, `page.server.tsx`). These files contain your API route handler and editor page -- things the static site does not need.

2. **Toggle the build** using an environment variable:

```typescript
// next.config.ts
import { withCanopy } from 'canopycms-next/config'

// CANOPY_BUILD=static -> static export of the public site (editor/API excluded)
// CANOPY_BUILD=cms    -> standalone Node.js server for the CMS
// unset (next dev, or a plain `next build`) -> regular server build with the editor included
const buildFlavor = process.env.CANOPY_BUILD

export default withCanopy(
  {
    ...(buildFlavor === 'static'
      ? { output: 'export' as const }
      : buildFlavor === 'cms'
        ? { output: 'standalone' as const }
        : {}),
  },
  { staticBuild: buildFlavor === 'static' },
)
```

When `staticBuild` is `true` (`CANOPY_BUILD=static`), CMS-only `.server.ts`/`.server.tsx` files are excluded, making them invisible to the static export build. Otherwise — including plain `next dev` — `withCanopy()` adds those extensions to `pageExtensions` so Next.js processes them, which is why the editor works in local development without any env var.

Pair this with `deployedAs: process.env.CANOPY_BUILD === 'static' ? 'static' : 'server'` in `canopycms.config.ts` (generated by init when you choose dual-build) so the static export also skips auth and git operations at build time. This static build never needs `CLERK_SECRET_KEY` -- it's not read until the first authenticated request, which only happens on the CMS server build.

3. **Split content routes** that are shared by both builds (dynamic routes like `app/[slug]/`, and any fixed content page such as the home route). Two constraints force the split. First, `output: 'export'` requires `dynamicParams = false`, but on the CMS/server build `dynamicParams = false` makes an unknown slug throw Next's internal `NoFallbackError` (a 500) before your page's own `notFound()` runs -- and Next statically parses route-segment config, it does not evaluate expressions, so a single page cannot switch `dynamicParams` on an environment variable (`process.env.CANOPY_BUILD !== 'static'` fails the build with "Invalid segment configuration export detected"). Second, the CMS/server build must not statically prerender content pages at all: a build-time prerender serves build-time content to every visitor, bypassing runtime path ACLs, and a slug outside `generateStaticParams()` is rendered as on-demand _static_ generation, where the request-scoped read's `headers()` call throws `DYNAMIC_SERVER_USAGE` (also a 500). Put the implementation in a plain (non-route) file and add two thin route variants, with no plain `page.tsx` for that route:

```tsx
// app/[slug]/slug-page.tsx -- shared implementation
// (default-exports the page component, exports generateStaticParams)

// app/[slug]/page.static.tsx -- static export build only: prerender every slug
export { default, generateStaticParams } from './slug-page'
export const dynamicParams = false

// app/[slug]/page.server.tsx -- CMS/server builds (and next dev): render every
// request at request time, branch-aware and ACL-enforced. No generateStaticParams
// re-export -- prerendering is what bypasses ACLs and breaks unknown slugs.
export { default } from './slug-page'
export const dynamic = 'force-dynamic'
```

`withCanopy(nextConfig, { staticBuild })` selects the right variant per build: static builds add `static.ts`/`static.tsx` to `pageExtensions` (so only `page.static.tsx` is seen), while CMS/server builds and plain `next dev` add `server.ts`/`server.tsx` instead (so only `page.server.tsx` is seen). Fixed content pages (e.g. the home route) follow the same shape minus `generateStaticParams`/`dynamicParams`: the `.static.tsx` variant is a bare re-export, the `.server.tsx` variant re-exports plus `export const dynamic = 'force-dynamic'`.

`slug-page.tsx`'s shared implementation should resolve content with the null-safe [`readByUrlPath()`](#load-content-by-url-path) (or catch errors from `read()`, see [Error Handling Utilities](#error-handling-utilities)) so an ACL denial on the `page.server.tsx` variant renders as `notFound()` instead of an uncaught 500. See [Public read on server deployments](#public-read-on-server-deployments) if you also want anonymous visitors to read published content on that build.

4. **Build each target** separately in your CI:

```bash
# Static public site (no CMS code included)
CANOPY_BUILD=static next build

# CMS server (includes editor + API routes)
CANOPY_BUILD=cms next build
```

If you are not doing dual-build deployment (most setups), you can ignore this option entirely -- the default behavior works for both development and single-build production.

> **Note:** `withCanopy()` adds `server.ts`/`server.tsx` (or, with `staticBuild: true`, `static.ts`/`static.tsx`) to Next.js `pageExtensions`. If you already have files ending in `.server.ts`, `.server.tsx`, `.static.ts`, or `.static.tsx` inside your app directory for non-CMS purposes, they will be treated as pages/routes by Next.js. Rename them or use a different naming convention to avoid conflicts.

### 4. Customize your schemas

Edit `{appDir}/schemas.ts` with your content types. See [Schema Registry and References](#schema-registry-and-references) for details.

### 5. Protect editor routes

The `init` command generates a `middleware.ts` that matches `/edit` and `/api/canopycms` routes. By default it is a passthrough (suitable for dev auth mode). For Clerk auth, replace the file contents with the commented example inside, or use this:

Unlike `canopy.ts` and the edit page, `middleware.ts` does not switch on `CANOPY_AUTH_MODE` at runtime -- if you switch auth providers later, replace this file too (or re-run `init --force`).

```typescript
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

const isProtectedRoute = createRouteMatcher(['/edit(.*)', '/api/canopycms(.*)'])

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect()
  }
})

export const config = {
  matcher: ['/edit(.*)', '/api/canopycms(.*)'],
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

Schemas live in TypeScript (declared via `defineEntrySchema`) and are registered with `createEntrySchemaRegistry`. Your content lives in `.collection.json` files that reference schemas from the registry by name.

### How It Works

Three components:

1. **Schema Registry** — a TypeScript object mapping entry-type names to their field schemas, created with `createEntrySchemaRegistry`.
2. **Meta Files** — `.collection.json` files in your content directories that reference schemas from the registry via their `entry.schema` property.
3. **Automatic Loading** — CanopyCMS scans your content directory for meta files and resolves schema references when the editor starts and at build time.

### Setting Up a Schema Registry

Create a schemas file (e.g., `app/schemas.ts`):

```typescript
import { defineEntrySchema, type EntryTypesFromRegistry } from 'canopycms'
import { createEntrySchemaRegistry } from 'canopycms/server'

// 1. Declare your entry schemas.
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

// 2. Register them. KEY EACH SCHEMA BY ENTRY-TYPE NAME — the same string
// that appears in your `.collection.json` files' `entry.schema` property,
// in filenames (`post.<slug>.<id>.mdx`), and in `meta.entryType` from the
// tree builder. Keying this way lets EntryTypesFromRegistry derive your
// typed entry-type map automatically (see step 3).
export const entrySchemaRegistry = createEntrySchemaRegistry({
  post: postSchema,
  author: authorSchema,
  home: homeSchema,
})

// 3. Derive a typed entry-type map. Pass `EntryTypes` as the second generic
// to `canopy.buildContentTree<NavFields, EntryTypes>(...)` to get narrowed
// access to `meta.indexEntry.data` after switching on `meta.entryType`.
export type EntryTypes = EntryTypesFromRegistry<typeof entrySchemaRegistry>

// 4. Per-schema aliases derive cleanly from EntryTypes — single source of truth.
export type PostContent = EntryTypes['post']
export type AuthorContent = EntryTypes['author']
export type HomeContent = EntryTypes['home']
```

#### Convention: why key the registry by entry-type name?

The string in `.collection.json`'s `entry.schema` field is a lookup key into the registry. Picking the **entry-type name** as that key:

- Removes one level of indirection (`entry.name` and `entry.schema` are the same string in the common case).
- Makes error messages clearer (`Available schemas: post, author, home` rather than `postSchema, authorSchema, homeSchema`).
- Lets `EntryTypesFromRegistry<typeof entrySchemaRegistry>` derive the typed entry-type map automatically. Without it you'd declare a parallel `MyEntries` interface using `TypeFromEntrySchema<typeof postSchema>` per entry — the previously-documented fallback.

If you have multiple entry types that share one schema (`{ partner-v1: ..., partner-v2: ... }` both pointing at `partnerSchema`), name-keying still works — it just means two registry entries hold the same schema reference. Workable; ugly. If that's your situation, see the migration section below for the manual `MyEntries` fallback.

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
      "schema": "post"
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
      "schema": "home",
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
      "schema": "doc"
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
      "schema": "guide"
    }
  ]
}
```

### Connecting the Schema Registry

Pass your schema registry to `createNextCanopyContext` in `app/lib/canopy.ts`. The `npx canopycms init` command generates this file automatically:

```typescript
import { createNextCanopyContext, type GenerateContentStaticParamsOptions } from 'canopycms-next'
import { createClerkAuthPlugin } from 'canopycms-auth-clerk'
import { createDevAuthPlugin } from 'canopycms-auth-dev'
import config from '../../canopycms.config'
import { entrySchemaRegistry } from '../schemas'

const canopyContextPromise = createNextCanopyContext({
  config: config.server,
  authPlugin:
    process.env.CANOPY_AUTH_MODE === 'clerk'
      ? createClerkAuthPlugin({ useOrganizationsAsGroups: true })
      : createDevAuthPlugin(),
  entrySchemaRegistry, // Enable .collection.json file support
})

// For server component pages (request-scoped, auth-aware)
export const getCanopy = async () => {
  const context = await canopyContextPromise
  return context.getCanopy()
}

// Phase-selecting reads: filesystem-direct at build, branch-aware (ACL-enforced) at request time.
// Recommended for resolving a page by URL/path in a [...slug] / [slug] route.
export const readByUrlPath = async <T = unknown>(urlPath: string) => {
  const context = await canopyContextPromise
  return context.readByUrlPath<T>(urlPath)
}

// Enumeration-only static params (no admin context exposed). Use in generateStaticParams.
export const contentStaticParams = async (options?: GenerateContentStaticParamsOptions) => {
  const context = await canopyContextPromise
  return context.generateContentStaticParams(options)
}

// Advanced escape hatch: bypasses all ACLs (synthetic admin) and throws if used at request time on a
// production server. Prefer readByUrlPath/read/contentStaticParams above.
export const getCanopyForBuild = async () => {
  const context = await canopyContextPromise
  return context.getCanopyForBuild()
}

// For API routes
export const getHandler = async () => {
  const context = await canopyContextPromise
  return context.handler
}
```

For production deployments that need networkless JWT verification (e.g., AWS Lambda without internet access), you can replace the auth setup with `CachingAuthPlugin` and `createClerkJwtVerifier`. See the [ARCHITECTURE.md](ARCHITECTURE.md) deployment section for details.

**Writing a custom auth plugin?** In `mode: 'prod'`, CanopyCMS only accepts auth plugins that affirmatively set `readonly verifiesCredentials = true` on the plugin instance -- an allowlist marker meaning the plugin cryptographically verifies credentials (as `createClerkAuthPlugin` does). Any plugin missing the marker (including `createDevAuthPlugin`, which trusts request headers without verification) is rejected at startup in prod, so a header-trusting plugin can never be silently deployed to production.

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
  ],
  "order": ["<contentId>", ...]   // Optional: explicit item ordering; omitted/empty = alphabetical
}
```

**Root .collection.json** (`content/.collection.json`):

```typescript
{
  "entries": [                    // Optional: entry types at root level
    {
      "name": "home",
      "format": "json",
      "schema": "home",
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

### Migrating from the schema-name-keyed registry

If your registry currently uses schema-variable names as keys (the convention previously generated by `npx canopycms init`), you have two paths.

**Path A — Migrate to the entry-type-name convention (recommended).** Mechanical changes only; runtime behavior is identical afterward.

1. Rename the registry keys in `schemas.ts`:

   ```ts
   // Before
   export const entrySchemaRegistry = createEntrySchemaRegistry({
     postSchema,
     authorSchema,
     homeSchema,
   })

   // After
   export const entrySchemaRegistry = createEntrySchemaRegistry({
     post: postSchema,
     author: authorSchema,
     home: homeSchema,
   })
   ```

2. Update every `.collection.json` file to match. The `entry.schema` strings reference the registry keys you just renamed:

   ```diff
    {
      "entries": [
        {
          "name": "post",
          "format": "mdx",
   -      "schema": "postSchema"
   +      "schema": "post"
        }
      ]
    }
   ```

   A find-and-replace across `content/**/.collection.json` covers it: `"schema": "postSchema"` → `"schema": "post"`, repeated per schema. Then verify with `grep -r "Schema\"" content/`.

3. Add the typed entry-type map and switch per-schema aliases to derive from it:

   ```ts
   import { type EntryTypesFromRegistry } from 'canopycms'

   export type EntryTypes = EntryTypesFromRegistry<typeof entrySchemaRegistry>

   // These names stay the same at every call site — they just source from EntryTypes now.
   export type PostContent = EntryTypes['post']
   export type AuthorContent = EntryTypes['author']
   export type HomeContent = EntryTypes['home']
   ```

4. Pass `EntryTypes` as the second generic to `buildContentTree` wherever you call it:

   ```ts
   await canopy.buildContentTree<NavFields, EntryTypes>({
     extract: (data, meta) => {
       if (meta.kind === 'collection' && meta.indexEntry?.entryType === 'partner') {
         // meta.indexEntry.data is now typed as PartnerContent — no `unknown` casting.
       }
       return {}
     },
   })
   ```

5. Run `pnpm typecheck`. If a `.collection.json` still references an old schema name, you'll get a clear error pointing at the file (`Schema reference "postSchema" ... not found in registry. Available schemas: post, author, home`). Fix and rerun.

No content files, frontmatter, or `.canopy-meta/` cache files need migration. In dev mode, editing `.collection.json` automatically invalidates the schema cache; the next read picks up the new strings.

**Behavior change for both paths:** `createEntrySchemaRegistry` now runs the same field-shape checks that previously ran via `validateCanopyConfig` (select fields must have `options`, reference fields must have `collections` or `entryTypes`, no inline groups inside object/block fields, no field-name collisions after group flattening). Schemas that passed registry creation before but quietly held one of these mistakes will throw at registry creation now. The error messages cite the specific field; fix the schema and rerun.

**Config is now strict:** `defineCanopyConfig` rejects unknown top-level keys instead of silently ignoring them. A leftover inline `schema:` from the old config-based approach — or any typo'd/unsupported key — now throws `Unrecognized key(s) in object`. Remove any keys not listed in the [Configuration Reference](#configuration-reference).

**Path B — Keep your existing keyless shorthand.** Your code keeps working exactly as today. You don't get the auto-derived `EntryTypes` map, so if you want typed access to `meta.indexEntry.data`, declare a parallel interface manually:

```ts
import { type TypeFromEntrySchema } from 'canopycms'

interface MyEntries {
  partner: TypeFromEntrySchema<typeof partnerSchema>
  doc: TypeFromEntrySchema<typeof docSchema>
}

await canopy.buildContentTree<NavFields, MyEntries>({ ... })
```

This is the right choice if you have multiple entry types sharing one schema and prefer one registry entry per _schema_ rather than per _entry type_, or if you're not ready to touch `.collection.json` files yet. The migration is always available later.

### Schema Validation

CanopyCMS validates schema references at startup:

- **Missing schemas**: Clear error messages if a referenced schema doesn't exist in the registry
- **Invalid meta files**: JSON validation with helpful error messages
- **Type safety**: Schema registry gets full TypeScript type checking

**Example error message:**

```
Error: Schema reference "post" in collection "posts" not found in registry.
Available schemas: author, home, doc
```

## Configuration Reference

### `defineCanopyConfig` Options

| Option                | Type                                             | Required | Default     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------ | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitBotAuthorName`    | `string`                                         | Yes      | -           | Name used for git commits made by CanopyCMS                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `gitBotAuthorEmail`   | `string`                                         | Yes      | -           | Email used for git commits made by CanopyCMS                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `mode`                | `'dev' \| 'prod'`                                | **Yes**  | -           | Operating mode (see below). No default — a deploy that omits `mode` fails config validation at startup with a clear error, rather than silently running insecure dev auth semantics in production.                                                                                                                                                                                                                                                                           |
| `contentRoot`         | `string`                                         | No       | `'content'` | Root directory for content files relative to project root                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `defaultBaseBranch`   | `string`                                         | No       | `'main'`    | Git branch used as the fork point for CMS content branches (typically `main`). This branch can never be submitted for review, and in `prod` mode it's read-only in the editor — see [Submitting for Review](#submitting-for-review).                                                                                                                                                                                                                                         |
| `defaultActiveBranch` | `string`                                         | No       | (see below) | Which workspace the dev server serves content from and which branch the editor opens by default. In dev mode, auto-detected from the current git branch. In prod mode, falls back to `defaultBaseBranch`                                                                                                                                                                                                                                                                     |
| `defaultBranchAccess` | `'allow' \| 'deny'`                              | No       | `'deny'`    | Fallback access policy for a branch with no ACL — what `canopycms init` scaffolds. Three grants are exempt from it: admins/reviewers, the creator of an un-ACL'd branch, and the protected base branch (which takes no ACL and is where every user lands). So `'deny'` means "branches you neither created nor were invited to", not a lockout. An explicit ACL outranks the creator and base-branch grants, which is how an admin locks down a branch someone else created. |
| `defaultPathAccess`   | `'allow' \| 'deny' \| { read?, edit?, review? }` | No       | `'deny'`    | Default access policy for content paths when no permission rule matches. The object form scopes the default per permission level (e.g. `{ read: 'allow' }` for public read without opening edit/review). An unspecified level resolves to `'deny'`. See [Public read on server deployments](#public-read-on-server-deployments).                                                                                                                                             |
| `deployedAs`          | `'server' \| 'static'`                           | No       | `'server'`  | Deployment shape. `'static'`: site is pre-built with no live editor; all CMS API requests return 401 and `authPlugin` is not required. `'server'`: normal server-rendered deployment with auth enforced.                                                                                                                                                                                                                                                                     |
| `media`               | `MediaConfig`                                    | No       | -           | Asset storage configuration (local, s3, or lfs)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `editor`              | `EditorConfig`                                   | No       | -           | Editor UI customization options                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `dev`                 | `DevConfig`                                      | No       | -           | Dev-mode-only behavior. `dev.contentSync: 'off' \| 'warn'` (default `'warn'`) controls how the dev server detects/reports working-tree edits vs. the served branch clone (see [Local Development Sync](#local-development-sync)). Ignored when `mode !== 'dev'`.                                                                                                                                                                                                             |
| `validateEntry`       | `ValidateEntryHook`                              | No       | -           | Save-time validation hook, run server-side before the entry file is written. Return `level: 'error'` issues to reject the save, or `'warning'` issues to surface alongside it. See [Save-Time Validation](#save-time-validation-validateentry).                                                                                                                                                                                                                              |

**Note**: Schemas are declared in TypeScript with `defineEntrySchema`, registered with `createEntrySchemaRegistry`, and referenced from `.collection.json` files alongside your content. See the [Schema Registry and References](#schema-registry-and-references) section for details.

### Save-Time Validation (`validateEntry`)

Schema validation keeps field shapes clean, but it can't know that a markdown body must, say, compile as MDX for your production build to succeed. The optional `validateEntry` hook lets the site refuse (or flag) saves that would break it:

```typescript
// canopycms.config.ts
import { defineCanopyConfig, type EntryValidationIssue } from 'canopycms'
import { compile } from '@mdx-js/mdx'

export default defineCanopyConfig({
  // ...
  validateEntry: async ({ format, body }): Promise<EntryValidationIssue[]> => {
    if ((format === 'mdx' || format === 'md') && body) {
      try {
        await compile(body)
      } catch (err) {
        return [
          {
            level: 'error', // 'error' rejects the save; 'warning' saves but notifies
            fieldPath: 'body',
            message: `MDX failed to compile: ${err instanceof Error ? err.message : String(err)}`,
          },
        ]
      }
    }
    return []
  },
})
```

The hook receives `{ entryPath, branch, entryType?, format, data, body }` for every editor content save (`entryType` is set when the editor specifies one, e.g. in collections with multiple entry types). `error` issues reject the save with the message shown to the editor; `warning` issues let the save through and appear as a notification. The hook gates content writes only — renames and deletes do not invoke it. Pair it with the preview error channel (see [Live Preview](#live-preview)) so authors see compile failures while typing, not just at save time.

### Operating Modes

`mode` is required in `defineCanopyConfig` — there is no default. CanopyCMS throws at config validation time if it's omitted, so a deployment can't accidentally run in production with dev-mode auth semantics.

- **`dev`**: Full-featured local development with branching and git operations. Uses a local bare remote at `.canopy-dev/remote.git` and branch workspaces at `.canopy-dev/content-branches/`. `defaultActiveBranch` is auto-detected from the current git branch (e.g., if you are on `feat-bar`, the dev server and editor default to that branch). The dev server silently follows branch switches — no restart needed. Add `.canopy-dev/` to `.gitignore`.
- **`prod`**: Production deployment with branch workspaces on persistent storage (e.g., AWS Lambda + EFS). `defaultActiveBranch` falls back to `defaultBaseBranch` (usually `main`) but can be explicitly configured (e.g., to a staging branch). Because editors typically land on the base branch by default, it's read-only in the editor in `prod` mode (see [Submitting for Review](#submitting-for-review)). Permissions and groups are tracked in git on an orphan settings branch. In `prod` mode, your configured `authPlugin` must declare `verifiesCredentials: true` (see [Connecting the Schema Registry](#connecting-the-schema-registry)) — CanopyCMS refuses to start otherwise.

### Local Development Sync

When working in `dev` mode, your content lives in two places: the working tree of your repo and the branch workspaces inside `.canopy-dev/content-branches/` that the CMS editor reads from. If you edit files in the working tree directly (or pull from GitHub) while the dev server serves a branch clone, the two can drift — the classic "builds fine, but the dev editor shows blank/stale content" trap.

**Automatic divergence detection.** The `dev.contentSync` config option controls how the dev server detects and reports working-tree edits that have drifted from the served branch clone (dev mode only; ignored when `mode !== 'dev'`):

```typescript
// canopycms.config.ts
export default defineCanopyConfig({
  // ...
  dev: {
    contentSync: 'warn', // 'off' | 'warn' (default)
  },
})
```

| Value    | Behavior                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------- |
| `'warn'` | Default. On startup and on `content/**` changes, logs a warning naming the files that diverge from the branch clone |
| `'off'`  | No watcher, no warnings                                                                                             |

> **Why there is no `'auto'` mode:** auto-pushing the working tree into the branch clone could silently clobber uncommitted editor "Save" state, with no Canopy-level recovery path for the editor. Reconcile explicitly instead with `canopycms sync push`, which is interactive and conflict-aware.

To keep the two in sync, use the `canopycms sync` command.

**Push** (working tree → branch workspace) -- copies your current working-tree content into a branch workspace and commits it, so the CMS editor sees your latest changes (e.g., after pulling from GitHub or editing files directly). By default, targets the workspace matching your current git branch (auto-creating it if needed):

```bash
npx canopycms sync push
```

**Pull** (branch workspace → working tree) -- copies content from a CMS branch workspace back into your working tree so you can review, commit, and push the changes yourself:

```bash
npx canopycms sync pull
```

Both push and pull support `--branch` to target a specific workspace. If multiple branch workspaces exist and no `--branch` is given, the CLI will prompt you to choose one:

```bash
npx canopycms sync pull --branch update-homepage
```

**Both directions** (3-way merge) -- merges your working-tree changes with any editor changes using a 3-way git merge, then pulls the merged result back into your working tree:

```bash
npx canopycms sync both
```

This is useful when both you and the editor have made changes to the same branch and you want to reconcile them in one step.

**Abort** -- if a merge fails due to conflicts, you can cancel it and restore the branch workspace to its pre-merge state:

```bash
npx canopycms sync abort
```

> All project-bound CLI commands (`sync`, `migrate`, `generate-ai-content`, `worker run-once`) resolve the project root by walking up from the current directory to the nearest `canopycms.config.ts`, like git does — running them from a subdirectory works.

### Migrating Existing Content

Adopting CanopyCMS on a site with existing content? `canopycms migrate` converts a plain content tree into CanopyCMS conventions — entry files become `{type}.{slug}.{id}.{ext}`, content-bearing directories get ID suffixes and a `.collection.json`, and the root gets one when entry files live directly in it:

```bash
npx canopycms migrate --entry-type doc --format md --schema docSchema --dry-run
npx canopycms migrate --entry-type doc --format md --schema docSchema
```

- `--dry-run` prints the full rename/create plan without touching anything; omitted flags are prompted for.
- Only files of the chosen format are migrated. Assets, other formats, and directories without matching content are left untouched.
- Re-running is a no-op: already-conforming names are skipped.
- Entry order is left unset (alphabetical). Source-specific ordering conventions (e.g. Nextra `_meta.json`) are out of scope — apply those with a follow-up script if needed.

After migrating, make sure the schema key you chose (e.g. `docSchema`) exists in your entry schema registry.

### Schema Definition

The schema uses a unified collection-based structure. Collections contain **entry types**, which define the types of content allowed within that collection. Each entry type has its own schema (fields), format, and optional cardinality constraints.

**Entry types** define what kind of content can exist in a collection:

- For repeatable content (blog posts, products), create an entry type without restrictions
- For unique content (homepage, settings), create an entry type with `maxItems: 1`
- You can mix multiple entry types in a single collection

Declare your schemas once in `schemas.ts` and register them by entry-type name:

```typescript
// app/schemas.ts
import { defineEntrySchema } from 'canopycms'
import { createEntrySchemaRegistry } from 'canopycms/server'

export const postSchema = defineEntrySchema([
  /* fields */
])
export const homeSchema = defineEntrySchema([
  /* fields */
])
export const guideSchema = defineEntrySchema([
  /* fields */
])
export const tutorialSchema = defineEntrySchema([
  /* fields */
])
export const endpointSchema = defineEntrySchema([
  /* fields */
])
export const settingsSchema = defineEntrySchema([
  /* fields */
])

export const entrySchemaRegistry = createEntrySchemaRegistry({
  post: postSchema,
  home: homeSchema,
  guide: guideSchema,
  tutorial: tutorialSchema,
  endpoint: endpointSchema,
  settings: settingsSchema,
})
```

Then place a `.collection.json` next to each collection's content. The directory tree decides where each collection lives — there is no `path` field.

**Repeatable entries** — `content/posts/.collection.json`:

```json
{
  "name": "posts",
  "label": "Blog Posts",
  "entries": [{ "name": "post", "format": "json", "schema": "post" }]
}
```

**Singleton-like entry** — `content/pages/.collection.json`:

```json
{
  "name": "pages",
  "label": "Pages",
  "entries": [
    {
      "name": "home",
      "label": "Homepage",
      "format": "json",
      "schema": "home",
      "maxItems": 1
    }
  ]
}
```

**Multiple entry types in one collection** — `content/docs/.collection.json`:

```json
{
  "name": "docs",
  "label": "Documentation",
  "entries": [
    { "name": "guide", "label": "Guide", "format": "mdx", "schema": "guide" },
    { "name": "tutorial", "label": "Tutorial", "format": "mdx", "schema": "tutorial" }
  ]
}
```

**Nested collections** — add a `.collection.json` in a subdirectory of `content/docs/`, e.g. `content/docs/api/.collection.json`:

```json
{
  "name": "api",
  "label": "API Reference",
  "entries": [{ "name": "endpoint", "format": "mdx", "schema": "endpoint" }]
}
```

**Root-level entries** (e.g., site-wide settings) — `content/.collection.json`:

```json
{
  "entries": [
    {
      "name": "settings",
      "label": "Site Settings",
      "format": "json",
      "schema": "settings",
      "maxItems": 1
    }
  ]
}
```

**Key concepts:**

- **Collections** are containers for content, organized by path (e.g., `posts`, `docs/guides`)
- **Entry types** define the types of content within a collection, each with its own schema
- **Multiple entry types**: A collection can have multiple entry types (e.g., "guide" and "tutorial" in docs)
- **Singleton-like behavior**: Use `maxItems: 1` to limit an entry type to a single instance
- **Nesting**: Collections can contain nested collections for hierarchical content structures
- **Root entries**: The root schema can have entry types directly (useful for site-wide settings)

### Field Types

| Type        | Description                                     | Options                                                                                                                 |
| ----------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `string`    | Single-line text                                | -                                                                                                                       |
| `number`    | Numeric value                                   | -                                                                                                                       |
| `boolean`   | True/false toggle                               | -                                                                                                                       |
| `datetime`  | Date and time picker                            | -                                                                                                                       |
| `markdown`  | Markdown text editor                            | -                                                                                                                       |
| `mdx`       | MDX editor with component support               | -                                                                                                                       |
| `image`     | Image upload/selection                          | -                                                                                                                       |
| `code`      | Code editor with syntax highlighting            | -                                                                                                                       |
| `select`    | Dropdown selection                              | `options: string[] \| {label, value}[]`                                                                                 |
| `reference` | Reference to another content entry (UUID-based) | `collections?: string[]`, `entryTypes?: string[]`, `displayField?: string`, `resolvedSchema?: Schema`                   |
| `object`    | Nested object                                   | `fields: FieldConfig[]`                                                                                                 |
| `block`     | Block-based "flexible content" / page blocks    | `templates: BlockTemplate[]` (define each with `defineBlockTemplate`, see [Page Blocks](#page-blocks-flexible-content)) |

**Common field options:**

```typescript
{
  name: 'fieldName',      // Required: unique field identifier
  type: 'string',         // Required: field type
  label: 'Field Label',   // Optional: display label (defaults to name)
  required: true,         // Optional: validation requirement
  list: true,             // Optional: allow multiple values
  isTitle: true,          // Optional: use this field as the display title in the editor sidebar
}
```

**Note**: For `type: 'string'` fields, `list: true` renders as a tag input — type a value and press Enter to add it, each value shows as a removable pill, and Backspace on an empty input removes the last one.

#### Rendering `markdown` / `mdx` content on your site

CanopyCMS stores and edits markdown; it deliberately does **not** ship a renderer. Two sites
render the same markdown differently on purpose — different component mappings, different
sanitization needs — so choosing the presentation layer is yours, and forcing one would take
away a degree of freedom adopters legitimately want.

One trap is worth knowing before you pick one, because it fails confusingly:

> **`react-markdown` does not work in a React Server Component.** Rendering its default export
> from a server component crashes a static prerender with `Element type is invalid … got:
undefined`, while the same code resolves fine once it is in the client bundle. The fix is to
> put `'use client'` on your own wrapper component.

That fix is correct, but it is not free: the wrapper and its markdown subtree ship to the
browser and lose server-only rendering for that part of the page. If the content is static
prose, consider a build-time renderer (`remark`/`rehype` to HTML, or MDX compiled at build
time) and keep the component on the server instead.

`apps/example1` shows the client-wrapper shape.

### Field Groups

Field groups let you visually organize related fields in the editor without forcing you to restructure your content files. Two helpers are available:

**`defineInlineFieldGroup`** — groups fields under a labeled, bordered section in the editor. The fields are stored **flat** in your content file alongside other top-level fields.

**`defineNestedFieldGroup`** — groups fields under a labeled section and stores them as a **nested object** in your content file (equivalent to `type: 'object'` with ergonomic sugar).

```typescript
import { defineInlineFieldGroup, defineNestedFieldGroup, defineEntrySchema } from 'canopycms'

// Inline group: fields stored flat (metaTitle, metaDescription at top level)
const seoGroup = defineInlineFieldGroup({
  name: 'seo',
  label: 'SEO',
  description: 'Search engine metadata', // optional
  fields: [
    { name: 'metaTitle', type: 'string', label: 'Meta Title' },
    { name: 'metaDescription', type: 'string', label: 'Meta Description' },
  ],
})

// Nested group: fields stored under a key (seo.metaTitle, seo.metaDescription)
const seoGroupNested = defineNestedFieldGroup({
  name: 'seo',
  label: 'SEO',
  fields: [
    { name: 'metaTitle', type: 'string', label: 'Meta Title' },
    { name: 'metaDescription', type: 'string', label: 'Meta Description' },
  ],
})

const docSchema = defineEntrySchema([
  { name: 'title', type: 'string', required: true },
  seoGroup, // or seoGroupNested
  { name: 'body', type: 'markdown' },
])
// TypeFromEntrySchema with inline group → { title: string; metaTitle: string; metaDescription: string; body: string }
// TypeFromEntrySchema with nested group → { title: string; seo: { metaTitle: string; metaDescription: string }; body: string }
```

Groups are reusable — define them once and include them in multiple schemas. Both helpers accept an optional `description` that appears as hint text in the editor.

### Reusable Field Fragments

Without a shared pattern for it, a common field cluster (a call-to-action's label + link, a preview object's title + image + description) tends to get retyped inline in every schema that needs it. That's not just repetition — in an audited real-world schema, one such cluster was spelled out eight times and a preview object three times, and the copies had already drifted apart on their `select` field's option lists. The drift was invisible in any one schema; it only showed up when content authored against one copy didn't validate against another.

Two mechanisms compose a shared field cluster without any special CMS support — both already work today, because `defineEntrySchema` and `defineBlockTemplate` infer literal types from a `const` array regardless of where that array came from:

**1. Spread a `const`-inferred field array into `fields`.** Define the cluster once, spread it into as many schemas as you need:

```typescript
import { defineEntrySchema, defineFieldFragment, type TypeFromEntrySchema } from 'canopycms'

// defineFieldFragment is a 3-line const-inference identity helper — purely for
// discoverability alongside defineInlineFieldGroup/defineNestedFieldGroup. A plain
// `const ctaFields = [...] as const` spread works exactly the same way.
const ctaFields = defineFieldFragment([
  { name: 'ctaLabel', type: 'string', label: 'Button Label' },
  { name: 'ctaHref', type: 'string', label: 'Button Link' },
])

const heroSchema = defineEntrySchema([{ name: 'headline', type: 'string' }, ...ctaFields])
const bannerSchema = defineEntrySchema([{ name: 'message', type: 'string' }, ...ctaFields])

type Hero = TypeFromEntrySchema<typeof heroSchema>
// { headline: string; ctaLabel: string; ctaHref: string }
```

**Per-use overrides** fall out of the same mechanism: don't spread the one field that needs to differ, and provide your own version of it instead. This is exactly the case that pushes people toward copy-paste in the first place — one schema needs the shared field `required`, another needs a different `label`:

```typescript
const ctaLabelField = { name: 'ctaLabel', type: 'string', label: 'Button Label' } as const
const ctaHrefField = { name: 'ctaHref', type: 'string', required: false } as const

// Most schemas: spread both fields as-is.
const heroSchema = defineEntrySchema([
  { name: 'headline', type: 'string' },
  ctaLabelField,
  ctaHrefField,
])

// This one needs ctaHref required — compose from the same const, override just that key.
const bannerSchema = defineEntrySchema([
  { name: 'message', type: 'string' },
  ctaLabelField,
  { ...ctaHrefField, required: true },
])
```

**2. Nest `defineInlineFieldGroup()` inside a block template.** Where the shared cluster should also appear visually grouped in the editor (a bordered "Call to Action" section rather than loose fields), nest an inline group inside a block template's `fields` instead of spreading a plain array. Inline groups are transparent all the way down the stack — the type derivation flattens them (see [Field Groups](#field-groups)), and so does data storage, validation, reference resolution, and the editor — so this works inside a block template exactly like it works inside a top-level schema:

```typescript
import { defineBlockTemplate, defineInlineFieldGroup, defineEntrySchema } from 'canopycms'

const ctaGroup = defineInlineFieldGroup({
  name: 'cta',
  label: 'Call to Action',
  fields: [
    { name: 'ctaLabel', type: 'string', label: 'Button Label' },
    { name: 'ctaHref', type: 'string', label: 'Button Link' },
  ],
})

const heroBlock = defineBlockTemplate({
  name: 'hero',
  fields: [{ name: 'headline', type: 'string' }, ctaGroup],
})
const bannerBlock = defineBlockTemplate({
  name: 'banner',
  fields: [{ name: 'message', type: 'string' }, ctaGroup],
})

const pageSchema = defineEntrySchema([
  { name: 'sections', type: 'block', templates: [heroBlock, bannerBlock] },
])
// Both templates' value shapes include { ctaLabel: string; ctaHref: string } flat —
// no 'cta' key, and the editor renders it as one bordered group in each block.
```

### Page Blocks (Flexible Content)

A `block` field holds an ordered, repeatable list of heterogeneous section blocks discriminated by a `template` key — the "flexible content" / page-builder pattern. Each block in the list picks one of the field's templates, so a page entry becomes an array of typed sections that editors can add, remove, and reorder.

Use `defineBlockTemplate()` (from `canopycms`) to define a reusable section template once and embed it in multiple entry schemas' `block` fields, instead of duplicating the template inline in every schema:

```typescript
import { defineBlockTemplate, defineEntrySchema } from 'canopycms'

const heroBlock = defineBlockTemplate({
  name: 'hero',
  label: 'Hero',
  fields: [
    { name: 'heading', type: 'string' },
    { name: 'subheading', type: 'string', required: false },
  ],
})

const ctaBlock = defineBlockTemplate({
  name: 'cta',
  label: 'Call to Action',
  fields: [
    { name: 'label', type: 'string' },
    { name: 'href', type: 'string' },
  ],
})

// Reuse the same templates across multiple page schemas:
const pageSchema = defineEntrySchema([
  { name: 'title', type: 'string', required: true },
  { name: 'sections', type: 'block', templates: [heroBlock, ctaBlock] },
])

type Page = TypeFromEntrySchema<typeof pageSchema>
// Page['sections'] narrows to a discriminated union:
//   Array<
//     | { template: 'hero'; value: { heading: string; subheading?: string } }
//     | { template: 'cta';  value: { label: string; href: string } }
//   >
```

`defineBlockTemplate()` is an identity/type-inference helper (like `defineEntrySchema` and the field-group helpers): it returns the template unchanged but preserves the literal types so `TypeFromEntrySchema` derives the correct discriminated union. Switch on `block.template` to render each section (see [Typed Block Discriminated Unions](#typed-block-discriminated-unions)).

**Example with reference field:**

```typescript
const schema = defineEntrySchema([
  { name: 'title', type: 'string', label: 'Title', required: true, isTitle: true },
  { name: 'body', type: 'markdown', label: 'Content' },
  {
    name: 'author',
    type: 'reference',
    label: 'Author',
    collections: ['authors'], // Load options from 'authors' collection
    displayField: 'name', // Show the author's name in the dropdown
    resolvedSchema: authorSchema, // Optional: enables typed inference (see Type Inference section)
  },
  {
    name: 'relatedPosts',
    type: 'reference',
    label: 'Related Posts',
    collections: ['posts'],
    displayField: 'title',
    list: true, // Allow multiple references
  },
  {
    name: 'partners',
    type: 'reference',
    label: 'Partners',
    entryTypes: ['partner'], // Find entries by type across all collections
    displayField: 'name',
    list: true,
    resolvedSchema: partnerSchema,
  },
])
```

**Example with all field types:**

```typescript
const schema = defineEntrySchema([
  { name: 'title', type: 'string', label: 'Title', required: true, isTitle: true },
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

### Shared / Referenced Blocks

A block template is just a schema, so a block field can hold a `reference` field like any other field — which makes a **shared content block** possible without any dedicated CMS feature: define the shared content as its own entry type (a small "snippet" collection), then give a block template a single `reference` field pointing at it. Editing the snippet once updates every page block that references it, instead of a find-every-page-and-paste-the-new-copy edit. In one audited real-world content set, the same call-to-action block was byte-duplicated across a dozen pages and had already drifted; every edit meant a dozen synchronized file changes.

**The recipe:**

```typescript
import { defineBlockTemplate, defineEntrySchema } from 'canopycms'

// 1. The shared content lives in its own entry type, like any other collection.
const ctaSnippetSchema = defineEntrySchema([
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'ctaText', type: 'string', label: 'Button Text' },
])

// 2. A one-field block template holds a reference to it. entryTypes scopes the picker to
//    that entry type regardless of which collection it lives in.
const sharedCtaBlock = defineBlockTemplate({
  name: 'sharedCta',
  label: 'Shared CTA',
  fields: [
    {
      name: 'snippet',
      type: 'reference',
      label: 'CTA Snippet',
      entryTypes: ['ctaSnippet'],
      resolvedSchema: ctaSnippetSchema, // typed as the resolved snippet, not a bare id
    },
  ],
})

const pageSchema = defineEntrySchema([
  { name: 'sections', type: 'block', templates: [sharedCtaBlock /* , ...other templates */] },
])
```

Reading resolves it automatically — reference resolution inside block templates is not something you opt into separately. `read()` and `readByUrlPath()` already recurse into block templates and resolve any `reference` field they find there, the same as a top-level reference field:

```typescript
const { data } = await canopy.read<Page>({ entryPath: 'content/pages', slug: 'landing' })

for (const section of data.sections) {
  if (section.template === 'sharedCta' && section.value.snippet) {
    // section.value.snippet is the full resolved entry — { title, ctaText, ... } — not an id
  }
}
```

> **In a listing, ask for resolution explicitly.** Everything above is `read()`-time behavior, where references resolve automatically. [`listEntries()`](#listing-entries) and `buildContentTree()` read content files raw off disk and resolve nothing **unless you pass `{ resolveReferences: true }`** — so a surface built from a listing without that option sees a shared block's reference field as `null` or a bare id string, never the snippet's data, and a search index built that way silently contains nothing for those blocks. Turn the option on for any listing-derived surface that needs shared-block content; see [Resolving References in a Listing](#resolving-references-in-a-listing) for what it costs and the two caveats that come with it. (The AI-content export is separate: it disables reference resolution on purpose, so shared-block content is not duplicated into every referencing page's export.)

## Content Identification & References

### UUID-Based IDs

Every entry in your content automatically receives a unique, stable identifier. CanopyCMS uses 12-character UUIDs (Base58-encoded, truncated) that are:

- **Stable across renames**: The ID is embedded in the filename (e.g., `my-post.a1b2c3d4e5f6.json`), so it persists even when you change the slug portion
- **Globally unique**: IDs are automatically generated and guaranteed unique across your entire site (~2.6 × 10^21 possible IDs)
- **Git-friendly**: IDs are visible in filenames, making them easy to track in git diffs and preserved through `git mv`
- **Human-readable**: Filenames show both the human-friendly slug and the unique ID
- **Automatic**: You never manually create or manage IDs - they're generated when entries are created

### Reference Fields

Reference fields let you create typed relationships between content entries. Unlike brittle string links or file paths, references use UUIDs to create robust, move-safe links.

Reference fields accept `collections`, `entryTypes`, or both to scope which entries can be referenced. At least one must be specified:

- **`collections`** — Scope by collection path(s), including all subcollections within that tree
- **`entryTypes`** — Scope by entry type name(s), regardless of which collection the entries live in
- **Both** — Combine for precise scoping (e.g., only `partner` entries within the `data-catalog` tree)

> Every `entryTypes` value is validated against the entry type names actually defined in your `.collection.json` files. A name that doesn't match any of them is a hard error at schema resolution — naming the field, its location, a "did you mean" suggestion when there's a close match, and the full list of known entry types — rather than a picker that silently returns zero options. **Upgrade note:** if you have an existing `entryTypes` typo, it previously failed silently; it will now fail loudly until corrected.

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
  {
    name: 'partners',
    type: 'reference',
    label: 'Partners',
    entryTypes: ['partner'], // Find all 'partner' entries across any collection
    displayField: 'name',
    list: true,
    resolvedSchema: partnerSchema,
  },
  {
    name: 'catalogPartner',
    type: 'reference',
    label: 'Catalog Partner',
    collections: ['data-catalog'], // Search within data-catalog and all its subcollections
    entryTypes: ['partner'], // But only entries of type 'partner'
    displayField: 'name',
  },
])
```

**Key benefits:**

- **Type safety**: The editor validates that references always point to valid entries
- **Dynamic options**: The reference field automatically loads available options from the specified collections and/or entry types
- **Move-safe**: References survive file renames and directory moves - the ID is permanent
- **No broken links**: If you delete an entry, you'll see validation errors on any entries referencing it
- **Display flexibility**: Show any field from the referenced entry (title, name, slug, etc.) in dropdowns
- **Co-located data**: Use `entryTypes` to reference entries that live alongside their related content in subcollections, without needing a dedicated collection

### How References Work in the Editor

When editing a reference field:

1. Click the dropdown to see all available entries matching the configured collections and/or entry types
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

The type inference covers all field types: `string` and `markdown` fields become `string`, `number` becomes `number`, `boolean` becomes `boolean`, `object` fields become nested objects, and `list: true` wraps the value in an array.

#### Select Fields

A `select` field infers the **literal union of its own `options`**, not a bare `string`:

```typescript
const postSchema = defineEntrySchema([
  { name: 'status', type: 'select', options: ['draft', 'published'] },
  {
    name: 'tier',
    type: 'select',
    options: [
      { label: 'Free', value: 'free' },
      { label: 'Paid', value: 'paid' },
    ],
  },
])

// { status: 'draft' | 'published'; tier: 'free' | 'paid' }
type Post = TypeFromEntrySchema<typeof postSchema>
```

Both option forms work, including one array that mixes them. A bare string option
contributes itself; a `{ label, value }` option contributes its **`value`** — so
comparing against the label is a compile error, which is usually the bug you wanted
caught. With `list: true` you get an array of the union.

Two cases fall back to `string` rather than a union, deliberately:

- **The options are no longer literals.** `defineEntrySchema` (or `as const`) preserves
  them; an options array annotated as the runtime type — `const options: SelectOption[]`
  — has no literals left to infer.
- **There are no options to infer.** A `select` with no `options`, or with
  `options: []`. Both are rejected with a clear message by `createEntrySchemaRegistry`
  — not by `defineCanopyConfig` — so a schema you never register through the registry is
  only ever checked at the type level. Either way the inferred type stays usable instead
  of collapsing to `never`.

One caveat when reading existing content: the validator treats an empty string as "not
filled in" for any field that is not explicitly `required: true`, so a select can hold
`''` on disk. `''` is **not** in the inferred union — like the rest of
`TypeFromEntrySchema`, it describes the shape your schema declares rather than
everything the validator tolerates. If you need to branch on a cleared select, add `''`
to that field's `options` so it becomes a declared state.

#### Optional Fields

A field with an explicit `required: false` becomes an **optional property** (`subheading?: string`), not a required property typed `string | undefined`:

```typescript
const heroSchema = defineEntrySchema([
  { name: 'heading', type: 'string' },
  { name: 'subheading', type: 'string', required: false },
])

// { heading: string; subheading?: string }
type Hero = TypeFromEntrySchema<typeof heroSchema>

// So a literal can simply omit the field — no `subheading: undefined` filler:
const hero: Hero = { heading: 'Welcome' }
```

Reading is unchanged: `hero.subheading` is still `string | undefined`. What changes is construction — you no longer have to spell out every unset field, and adding a new optional field to a schema does not break existing hand-written literals.

Only an **explicit** `required: false` does this. A field that omits `required` entirely stays a required property — that is the type-level default, chosen so a schema author must opt in to optionality rather than getting it silently. Note this is stricter than the runtime validator, whose default is the opposite: `validateEntryData` only enforces fields with `required: true`, so an omitted `required` is _not_ enforced at runtime either. A field with no `required` is therefore typed as present but validated as absent-tolerant — pass `required: false` explicitly if you want the two to agree.

| Field declaration                                | Inferred property |
| ------------------------------------------------ | ----------------- |
| `{ name: 'a', type: 'string', required: true }`  | `a: string`       |
| `{ name: 'a', type: 'string' }`                  | `a: string`       |
| `{ name: 'a', type: 'string', required: false }` | `a?: string`      |

The rule applies at every level — top-level fields, fields nested inside `object` fields, and fields inside block templates. If your project sets `exactOptionalPropertyTypes: true`, note that explicitly assigning `undefined` to an optional key (`hero.subheading = undefined`) is an error under that flag; assign nothing, or widen the field's type yourself.

**`exactOptionalPropertyTypes: true` also requires `skipLibCheck: true`** (the Next.js default) to compile against this package at all today. With `skipLibCheck: false`, a `reference` field's `resolvedSchema` type inference hits a pre-existing library-internal type error unrelated to the assignment-level advice above. If your project sets `skipLibCheck: false` alongside `exactOptionalPropertyTypes: true`, you will hit this before you write a line against the schema — there is no workaround short of `skipLibCheck: true` today.

#### Typed Block Discriminated Unions

Block fields produce a proper **discriminated union** based on their templates. This means you can switch on `block.template` and TypeScript will narrow `block.value` to the correct shape for that template:

```typescript
const pageSchema = defineEntrySchema([
  {
    name: 'blocks',
    type: 'block',
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
          { name: 'title', type: 'string' },
          { name: 'ctaText', type: 'string' },
        ],
      },
    ],
  },
])

type Page = TypeFromEntrySchema<typeof pageSchema>

// Page['blocks'] is:
//   Array<
//     | { template: 'hero'; value: { headline: string; body: string } }
//     | { template: 'cta'; value: { title: string; ctaText: string } }
//   >

for (const block of page.blocks) {
  switch (block.template) {
    case 'hero':
      // block.value is narrowed to { headline: string; body: string }
      return <HeroSection headline={block.value.headline} body={block.value.body} />
    case 'cta':
      // block.value is narrowed to { title: string; ctaText: string }
      return <CtaSection title={block.value.title} ctaText={block.value.ctaText} />
  }
}
```

#### Block Component Registries

The `switch` above works, but it is easy to leave it with a `default: return null` clause "for forward compatibility" — which quietly turns a schema typo or a renamed template into a block that renders nothing, with a green build and green tests. A **mapped type keyed off the block union** makes the mapping exhaustive _by construction_: TypeScript refuses to compile if a template is missing its component, or if the registry has a key that doesn't match any template name. (The missing-key direction is airtight in every form; the stray-key direction relies on TypeScript's excess-property check, which is literal-only — assigning a pre-typed or aliased object with an extra key through a variable is not caught. Every example on this page constructs the registry as an object literal, which is the normal way to write one, so the check applies.) That is strictly stronger than a runtime test asserting the handled set matches the schema's declared templates, because it fails the build instead of failing at render time.

`BlockValueOf<Blocks, N>` pulls one template's value shape out of the union. `BlockComponentRegistry<Blocks, ExtraProps>` builds the exhaustive component map from it — one `ComponentType<{ data: ... } & ExtraProps>` per template:

```typescript
import type { BlockComponentRegistry } from 'canopycms'
import type { ComponentType } from 'react'

type Blocks = Page['blocks'][number]

const blockRegistry: BlockComponentRegistry<Blocks> = {
  hero: ({ data }) => <HeroSection headline={data.headline} body={data.body} />,
  cta: ({ data }) => <CtaSection title={data.title} ctaText={data.ctaText} />,
  // Missing a key here, or adding one that isn't a template name, is a compile error.
}
```

CanopyCMS does not ship a `renderBlocks()` helper — it would have to pick a key strategy, an unknown-template policy, and how extra props reach each component, and any one of those choices is wrong for someone. The registry is the whole primitive; reading it is a small loop you own:

```typescript
function renderBlocks(blocks: Blocks[]) {
  return blocks.map((block, i) => {
    // One contained assertion: `block.template` and `block.value` come from the same
    // object, so the lookup and the data always agree at runtime — TypeScript just
    // can't correlate a dynamic key lookup with a discriminated union's narrowing on
    // its own. This is the one place that trust is spent; the registry above is what
    // makes it safe to spend for every template the SCHEMA currently declares.
    const Component = blockRegistry[block.template] as
      | ComponentType<{ data: typeof block.value }>
      | undefined
    // Compile-time exhaustiveness covers the schema, not data at rest. A content file
    // can still carry a `template` name that used to exist and was since renamed or
    // removed -- the build-time schema-validity guard catches that for a production
    // static export, but request-time rendering (a dev server, or an on-demand render
    // of content saved after the last build) reads content with no such guard, so a
    // stale name reaches this lookup as `undefined`. Without this check, React throws
    // "Element type is invalid" and takes the page down.
    if (!Component) return null
    return <Component key={i} data={block.value} />
  })
}
```

Pass a second type argument to thread extra props — an index, a `fieldProps` callback for live-preview highlighting, whatever your renderer needs — into every component in the registry, and widen the assertion to match:

```typescript
type BlockProps = { index: number }

const blockRegistry: BlockComponentRegistry<Blocks, BlockProps> = {
  hero: ({ data, index }) => <HeroSection headline={data.headline} position={index} />,
  cta: ({ data, index }) => <CtaSection title={data.title} position={index} />,
}

function renderBlocks(blocks: Blocks[]) {
  return blocks.map((block, i) => {
    const Component = blockRegistry[block.template] as
      | ComponentType<{ data: typeof block.value } & BlockProps>
      | undefined
    if (!Component) return null // see the schema-vs-data-at-rest note above
    return <Component key={i} data={block.value} index={i} />
  })
}
```

#### Typed References with `resolvedSchema`

By default, reference fields infer as `string | null` (the UUID). If you want the inferred type to reflect the resolved entry's shape instead, pass `resolvedSchema` pointing to the target schema:

```typescript
const authorSchema = defineEntrySchema([
  { name: 'name', type: 'string', label: 'Name' },
  { name: 'bio', type: 'string', label: 'Bio' },
])

const postSchema = defineEntrySchema([
  { name: 'title', type: 'string', label: 'Title' },
  {
    name: 'author',
    type: 'reference',
    label: 'Author',
    collections: ['authors'],
    displayField: 'name',
    resolvedSchema: authorSchema, // Infer the resolved type from this schema
  },
])

type Post = TypeFromEntrySchema<typeof postSchema>

// Without resolvedSchema: Post['author'] would be string | null
// With resolvedSchema:    Post['author'] is { name: string; bio: string } | null
```

The `resolvedSchema` option is used only for type inference -- it does not affect how content is read, written, or validated at runtime, and is automatically stripped from API responses. It accepts any schema created with `defineEntrySchema`, so you can share the same schema objects between your entry type definitions and your reference fields.

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

> **Request-time errors:** `read()` throws if the entry is missing or the current user can't read it (e.g. an anonymous visitor on a `server` deployment with [public read](#public-read-on-server-deployments) enabled) -- an uncaught throw becomes a 500 page, not a 404. Catch it explicitly (see [Error Handling Utilities](#error-handling-utilities)) or prefer [`readByUrlPath()`](#load-content-by-url-path), which returns `null` instead.

**Key benefits:**

- **Automatic authentication**: Current user extracted from request headers via auth plugin
- **Bootstrap admin groups**: Admin users automatically get `admins` group membership
- **Build mode support**: Permissions bypassed during `next build` for static generation
- **Type-safe**: Full TypeScript support with inferred types from your schema
- **Per-request caching**: Context is cached using React's `cache()` for the request lifecycle

**The context object provides:**

- `read()`: Read content with automatic auth and branch resolution
- `readByUrlPath()`: Read content by URL path, resolving the collection/entry split automatically (see below)
- `buildContentTree()`: Build a typed content tree for navigation, sitemaps, etc. (see [Content Tree Builder](#content-tree-builder))
- `listEntries()`: Get a flat array of all entries for `generateStaticParams`, search indexes, sitemaps (see [Listing Entries](#listing-entries))
- `user`: Current authenticated user (with bootstrap admin groups applied)
- `services`: Underlying CanopyCMS services for advanced use cases

### Load Content by URL Path

`readByUrlPath()` maps a URL path directly to a content entry, handling the collection/slug split and index entry resolution automatically. This is the simplest way to load content when your routes mirror your content structure:

```typescript
// app/[...slug]/page.tsx
import { notFound } from 'next/navigation'
import { getCanopy } from '../lib/canopy'

export default async function Page({ params }) {
  const canopy = await getCanopy()
  const urlPath = '/' + (params.slug?.join('/') ?? '')

  const result = await canopy.readByUrlPath<{ title: string; body: string }>(urlPath)
  if (!result) return notFound()

  return <Article title={result.data.title} body={result.data.body} />
}
```

**Resolution order:**

1. `/docs/getting-started` -- tries `content/docs` + slug `"getting-started"` (direct entry match)
2. If that fails, tries `content/docs/getting-started` + slug `"index"` (index entry fallback)
3. `/docs/guides` -- resolves to the index entry of the `guides` collection (if one exists)
4. `/` -- resolves to the root index entry at the content root (if one exists)

Returns `null` when no content matches the path, or when the current user is not permitted to read it (a `FORBIDDEN` denial renders as a 404 via your existing `if (!result) return notFound()`, rather than throwing). The strict `read()` API still throws on permission errors.

### Index Entries and URL Resolution

Index entries (entries with slug `"index"`) represent the default content for a collection URL. All three content APIs -- `readByUrlPath`, `listEntries`, and `buildContentTree` -- treat index entries consistently:

- **`readByUrlPath('/guides')`** resolves to the index entry in the `guides` collection
- **`readByUrlPath('/')`** resolves to the index entry at the content root
- **`listEntries()`** returns `urlPath: '/guides'` (not `'/guides/index'`) for index entries, and `urlPath: '/'` for a root index entry
- **`buildContentTree()`** generates `path: '/guides'` (not `'/guides/index'`) for index entries by default

This means `entry.urlPath` from `listEntries()` is round-trip safe: `readByUrlPath(entry.urlPath)` always resolves back to the same entry.

### Static Export with generateStaticParams

For static-export sites you need a `generateStaticParams` that enumerates every content URL directly from your CanopyCMS content, so you do not have to hand-roll the path-segment mapping. This is exposed as a **bound helper** on the result of `createNextCanopyContext` — wire it once in your `lib/canopy.ts` and call it from each page. Because it is bound to the build context internally, your page modules never import the admin `getCanopyForBuild`.

The scaffolded `lib/canopy.ts` already exports it as `contentStaticParams`:

```typescript
// app/lib/canopy.ts
import { createNextCanopyContext, type GenerateContentStaticParamsOptions } from 'canopycms-next'

const canopyContextPromise = createNextCanopyContext({
  config: config.server,
  authPlugin,
  entrySchemaRegistry,
})

export const contentStaticParams = async (options?: GenerateContentStaticParamsOptions) => {
  const context = await canopyContextPromise
  return context.generateContentStaticParams(options)
}
```

**Catch-all route** (`app/[...slug]/page.tsx`) — emits `{ slug: segments[] }` for each entry:

```typescript
// app/[...slug]/page.tsx
import { contentStaticParams } from '../lib/canopy'

export const generateStaticParams = () => contentStaticParams()
```

**Collection-scoped single-segment route** (`app/posts/[slug]/page.tsx`) — pass `shape: 'single'` (emits `{ slug }`) and `rootPath` to scope to one collection:

```typescript
// app/posts/[slug]/page.tsx
import { contentStaticParams } from '../../lib/canopy'

export const generateStaticParams = () =>
  contentStaticParams({ rootPath: 'content/posts', shape: 'single' })
```

**Catch-all nested under a URL prefix** (`app/docs/[[...slug]]/page.tsx`) — pass `basePath` so the emitted `segments` are relative to that prefix and match the route:

```typescript
// app/docs/[[...slug]]/page.tsx
import { contentStaticParams } from '../../lib/canopy'

export const generateStaticParams = () =>
  contentStaticParams({ rootPath: 'content/docs', basePath: '/docs' })
```

**Options:**

| Option      | Type                      | Default       | Description                                                                                                                                                                            |
| ----------- | ------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shape`     | `'catch-all' \| 'single'` | `'catch-all'` | `'catch-all'` emits the URL `segments` array; `'single'` emits the entry `slug`                                                                                                        |
| `paramName` | `string`                  | `'slug'`      | Route param name (matches your `[...name]` / `[name]` folder)                                                                                                                          |
| `rootPath`  | `string`                  | Content root  | Scope to a subtree (e.g., `'content/posts'`), useful with `shape: 'single'`                                                                                                            |
| `basePath`  | `string`                  | -             | For a catch-all nested under a URL prefix (e.g. `app/docs/[[...slug]]`): set to the route base (`'/docs'`) so entries are scoped to that prefix and `segments` are made relative to it |
| `filter`    | `(entry) => boolean`      | -             | Exclude entries; e.g. drop the root index from a non-optional catch-all: `(e) => e.segments.length > 0`                                                                                |

> A root index (`/`) produces empty `segments` — keep it only for an optional catch-all `[[...slug]]`, otherwise exclude it with `filter`.
>
> **Advanced (framework-agnostic):** if you need to call the enumeration with a build context you already hold, the free helper `collectStaticParams(buildCtx, options)` from `canopycms-next` takes the build context directly. The bound `contentStaticParams` above is preferred for ordinary page code.
>
> **Schema-invalid entries fail the build.** During an actual production `next build`, `contentStaticParams` checks every entry against its schema and throws if any fail, listing each offending entry path. This typically means an abandoned create-scaffold -- an empty draft the editor's "+" button writes before you fill it in, then never finished or deleted. Finish or delete the entry in the editor and rebuild. `next dev` is unaffected, since in-progress scaffolds legitimately exist there while editing. The same guard runs during sitemap generation (below), so an app with no `generateStaticParams` at all still gets it.
>
> **A file CanopyCMS can't parse into an entry fails the build too.** Content files are named `{type}.{slug}.{id}.{ext}`; a `.md`/`.mdx`/`.json`/`.yaml` file inside a collection directory that doesn't match that shape -- most often a schema rename that left a stale file behind, or an entry type declared in one collection but not another -- is a production `next build` error listing the offending file, for the same reason as the schema-invalid case above: silently dropping a page out of the build is worse than a red build. Outside an actual production build (`next dev`, the admin UI) it's skipped instead, since in-progress renames legitimately leave such a file around while editing.

### Sitemap and SEO Metadata

These two ship together, and the reason is the `noindex` flag: it has to suppress a page in **both** surfaces -- `robots: { index: false }` on the page and absence from the sitemap. Both read it through the same core predicate, so they cannot disagree about which pages are advertised.

#### The recommended SEO field group

`defineSeoFieldGroup()` adds the seven fields the metadata helpers read by default -- `metaTitle`, `metaDescription`, `ogImage`, `ogType`, `canonical`, `noindex`, `twitterCard` -- all optional:

```typescript
// app/schemas.ts
import { defineEntrySchema, defineSeoFieldGroup } from 'canopycms'

export const postSchema = defineEntrySchema([
  { name: 'title', type: 'string' },
  defineSeoFieldGroup(),
])
// TypeFromEntrySchema: { title: string; metaTitle?: string; metaDescription?: string; ... }
```

The fields are stored **flat** in the content file by default. For the nested convention, pass `defineSeoFieldGroup({ group: 'seo' })` -- and then pass the same `{ group: 'seo' }` to `entryToMetadata` / `extractSeoFields` so the read side looks in the same place.

**Set it once, not per call.** `generateContentSitemap`'s `noindex` exclusion and `entryToMetadata`'s field extraction both need to agree on where the SEO fields live, or a page can end up `noindex` while the sitemap still advertises its URL (or the reverse) because one call site forgot the `group`/`fields` override the other one has. Pass `seo` to `createNextCanopyContext` instead of repeating it on every `contentSitemap`/`entryToMetadata` call -- both bound helpers pick it up automatically, and a per-call `seo`/`group`/`fields` still overrides it for just that call:

```typescript
// app/lib/canopy.ts
const canopyContextPromise = createNextCanopyContext({
  config: config.server,
  authPlugin,
  entrySchemaRegistry,
  seo: { group: 'seo' }, // shared by contentSitemap and entryToMetadata below
})
```

#### `sitemap.ts`

`generateContentSitemap` is a bound helper on the `createNextCanopyContext` result, like `contentStaticParams`:

```typescript
// app/lib/canopy.ts
export const contentSitemap = async (options: GenerateContentSitemapOptions) => {
  const context = await canopyContextPromise
  return context.generateContentSitemap(options)
}
```

```typescript
// app/sitemap.ts
import type { MetadataRoute } from 'next'
import { contentSitemap } from './lib/canopy'

// Required for output: 'export' -- metadata routes must opt into static generation.
export const dynamic = 'force-static'

export default function sitemap(): Promise<MetadataRoute.Sitemap> {
  return contentSitemap({
    siteUrl: 'https://example.com',
    trailingSlash: true,
    exclude: (entry) => entry.entryType === 'author',
    priority: (entry) => (entry.urlPath === '/' ? 1 : undefined),
  })
}
```

**Every routable entry type is included by default.** There is no list of sitemap-able entry types to keep in sync -- omitting a URL takes an explicit `exclude` predicate or a `noindex` flag on the entry. A sitemap built from a remembered list of entry types silently omits whichever type nobody added, ships green, and takes those pages out of search results with no warning.

**The mirror failure: a type with no route.** "Every entry type by default" only holds if every entry type actually has a page serving its `urlPath` shape. An entry type that exists for embedding elsewhere -- content addressed by a `reference` field inside a block, never visited directly -- is schema-routable but has no route for it, so leaving it unexcluded advertises a URL that 404s. The tell is the same either way: ask whether some route in your app actually serves that `urlPath` shape, not whether the schema happens to allow it. Exclude any entry type without one, same as `author` above.

**Options:**

| Option          | Type                                     | Default       | Description                                                                                                                           |
| --------------- | ---------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `siteUrl`       | `string`                                 | required      | Site origin. A sitemap must carry absolute URLs -- **enforced**: throws if this isn't an absolute URL (e.g. missing scheme, or empty) |
| `trailingSlash` | `boolean`                                | `false`       | Emit `/contact/` rather than `/contact`. **Set it to match your `next.config`** -- CanopyCMS cannot read that file                    |
| `rootPath`      | `string`                                 | Content root  | Scope to a subtree (e.g. `'content/posts'`)                                                                                           |
| `exclude`       | `(entry) => boolean`                     | -             | Drop entries, on top of the non-optional `noindex` exclusion                                                                          |
| `lastModified`  | `(entry) => Date \| string \| undefined` | `updatedAt`   | `<lastmod>` per entry; return `undefined` to omit it                                                                                  |
| `priority`      | `(entry) => number \| undefined`         | -             | `<priority>` per entry                                                                                                                |
| `extraUrls`     | `SitemapExtraUrl[]`                      | -             | URLs with no entry behind them (hand-written routes, feeds)                                                                           |
| `seo`           | `{ fields?, group? }`                    | flat defaults | Where the SEO fields live, when they aren't the defaults                                                                              |

> **`lastModified` is filesystem mtime by default.** `updatedAt` is the entry file's mtime, not an editorial timestamp -- a fresh CI clone resets it to checkout time, so on a clean build agent the default dates every URL to when the tree was cloned. Supply a real content date via the callback, or return `undefined` to omit `<lastmod>` rather than assert a date you cannot stand behind.
>
> `changeFrequency` is not emitted for entries: a blanket value asserted for every URL carries no information, and search engines say they ignore it. Set it per-URL via `extraUrls` if you want it.
>
> **`robots.txt` is out of scope** -- it is a few static lines with no CMS content behind it. Write `app/robots.ts` yourself and point its `sitemap` field at this route.
>
> **Colliding URLs are deduped, not silently doubled.** Two entries resolving to the same `<loc>` -- an index entry collapsing onto a sibling's path, or two `urlPath`s that only differ by case (`urlPath` is always lowercased) -- is not fatal to a crawler, but it almost always means two entries are unintentionally sharing one URL. `generateContentSitemap` keeps the first and drops the rest, and warns on the duplicate so you notice instead of shipping a sitemap with fewer URLs than you expect.

#### `generateMetadata`

```typescript
// app/posts/[slug]/page.tsx
import { entryToMetadata, readByUrlPath } from '../../lib/canopy'

export const generateMetadata = async ({ params }): Promise<Metadata> => {
  const { slug } = await params
  const result = await readByUrlPath<PostContent>(`/posts/${slug}`)
  return entryToMetadata(result?.data, {
    path: `/posts/${slug}`,
    siteUrl: 'https://example.com',
    siteName: 'Example',
    fallbackTitle: result?.data.title,
    defaultOgType: 'article',
  })
}
```

Returns `title`, `description`, `openGraph`, `twitter`, `alternates.canonical` and `robots`. Notes:

- **Empty CMS fields count as unset.** CanopyCMS writes optional fields present-but-empty, so an untouched SEO group is `metaTitle: ''` on disk. It falls back to `fallbackTitle` rather than emitting a blank title.
- **An absolute `canonical` passes through verbatim** -- that is how an entry points at a copy of itself hosted elsewhere. Only site-relative canonicals get the origin and trailing-slash treatment.
- **`noindex: true`** emits `robots: { index: false, follow: false }` _and_ drops the entry from the sitemap. It does **not** stop the page being built: `contentStaticParams` still enumerates it, so the URL resolves for anyone holding the link.
- Pass `titleTemplate` from your root layout for the `%s | Site` pattern.

> **Advanced (framework-agnostic):** the free `generateContentSitemap(buildCtx, options)` and `entryToMetadata(data, options)` are exported from `canopycms-next` directly, and the neutral core -- `collectRoutableEntries`, `extractSeoFields`, `isNoindexEntry` -- from `canopycms/server`, for non-Next frameworks.

### Reading Content at Build Time

For ordinary page work you should **not** need a build-specific context. The recommended page surface is:

- **Content** — the phase-selecting `readByUrlPath`/`read` helpers (below), which read the working tree during static generation and the branch-aware, ACL-enforced runtime context at request time.
- **Paths** — the bound `contentStaticParams` helper for `generateStaticParams` (see [Static Export with generateStaticParams](#static-export-with-generatestaticparams)).

Both are exported from your scaffolded `lib/canopy.ts`, so your page modules never import an admin context.

```typescript
// app/posts/[slug]/page.tsx
import { contentStaticParams, read } from '../../lib/canopy'

// Build-only: enumeration of paths, no admin context in the page module
export const generateStaticParams = () =>
  contentStaticParams({ rootPath: 'content/posts', shape: 'single' })

export async function generateMetadata({ params }) {
  // Phase-selecting read: working tree at build, ACL-enforced runtime at request time
  const { data } = await read({ entryPath: 'content/posts', slug: params.slug })
  return { title: data.title }
}

export default async function PostPage({ params }) {
  const { data } = await read({ entryPath: 'content/posts', slug: params.slug })
  return <PostView post={data} />
}
```

> At request time (a slug outside `generateStaticParams`, or any non-static render), the phase-selecting `read()` still throws on missing or forbidden content -- same caveat as the plain `read()` above. If this route is reachable by anonymous or otherwise unauthorized visitors on a `server` deployment, catch the error (see [Error Handling Utilities](#error-handling-utilities)) or switch to the null-safe [`readByUrlPath()`](#load-content-by-url-path) so a denial resolves to an ordinary 404 instead of a 500.

#### Advanced: `getCanopyForBuild()`

`getCanopyForBuild()` is an **advanced escape hatch** that returns a context not tied to request headers. The scaffolded `lib/canopy.ts` exports it but no longer leads with it — reach for it only when the phase-selecting helpers above are not enough (e.g. a standalone build script, or scanning the whole content set with `listEntries`/`buildContentTree` outside a page):

```typescript
// Standalone build script (not a page module)
import { getCanopyForBuild } from '../lib/canopy'

const canopy = await getCanopyForBuild()
const entries = await canopy.listEntries()
```

**When to use which:**

| Function                                            | Auth                                              | Request scope needed | Use for                                                        |
| --------------------------------------------------- | ------------------------------------------------- | -------------------- | -------------------------------------------------------------- |
| `read()` / `readByUrlPath()` (from `lib/canopy.ts`) | Phase-selecting (admin at build, user at request) | No (auto)            | Page modules that render in both phases — recommended surface  |
| `contentStaticParams()`                             | Build-only enumeration                            | No                   | `generateStaticParams`                                         |
| `getCanopy()`                                       | Current user                                      | Yes                  | Server components, route handlers                              |
| `getCanopyForBuild()`                               | Full admin (bypasses all auth/permissions)        | No                   | Advanced: build scripts, whole-collection scans outside a page |

> **Security note:** `getCanopyForBuild()` runs as a synthetic admin user with unrestricted read access, bypassing all branch and path ACLs. Only use it in build-time code paths that are not exposed to end users at request time. On a **production `server` deployment** (`mode: 'prod'` **and** `deployedAs: 'server'`), its operations **throw if invoked at request time** (i.e. outside the build phase) — a guard rail so the ACL-bypassing reader cannot be accidentally used to serve live requests. The guard intentionally does **not** fire in dev: Next legitimately invokes `generateStaticParams`/`generateMetadata` through the build context during `next dev` with the same not-build-phase signature as misuse, so a dev guard would false-positive on idiomatic code; in prod that ambiguity is gone (`generateStaticParams` is build-only). Use `getCanopy()` (or the phase-selecting helpers above) for request-time reads.

The build context also exposes a build-safe `readByUrlPath()` that returns `null` for non-entry paths (e.g. `/favicon.ico`, `/robots.txt`) instead of throwing, so a single `[...slug]` page can resolve real entries and cleanly `notFound()` everything else.

### Phase-Selecting `readByUrlPath` / `read`

For a `[...slug]`/`[slug]` page that must work in both phases, `createNextCanopyContext` returns top-level `readByUrlPath` and `read` helpers that automatically pick the right context: the admin build context during static generation (reads the working tree) and the branch-aware, ACL-enforced runtime context at request time (branch-clone preview in dev). This is the recommended way to resolve a page by URL — page code never has to hand-pick the admin build context.

Export them from your `lib/canopy.ts` alongside `getCanopy`:

```typescript
// app/lib/canopy.ts
const canopyContextPromise = createNextCanopyContext({
  config: config.server,
  authPlugin,
  entrySchemaRegistry,
})

export const readByUrlPath = async <T = unknown>(urlPath: string) => {
  const context = await canopyContextPromise
  return context.readByUrlPath<T>(urlPath)
}
```

```typescript
// app/[...slug]/page.tsx
import { notFound } from 'next/navigation'
import { readByUrlPath } from '../lib/canopy'

export default async function Page({ params }) {
  const urlPath = '/' + (params.slug?.join('/') ?? '')
  const result = await readByUrlPath<{ title: string; body: string }>(urlPath)
  if (!result) return notFound()
  return <Article title={result.data.title} body={result.data.body} />
}
```

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

### Sanitizing URLs from CMS Content

When rendering links from CMS-managed content, user-provided URLs may contain dangerous schemes like `javascript:` or `data:`. CanopyCMS exports a `sanitizeHref` utility that parses untrusted URLs -- both absolute (`https://example.com`) and relative (`/about`, `#section`) -- and only allows `http:` and `https:` protocols, returning a safe fallback for anything else.

```typescript
import { sanitizeHref } from 'canopycms'
```

**Basic usage:**

```tsx
// In your component that renders CMS content
<a href={sanitizeHref(entry.data.link)}>{entry.data.linkText}</a>
```

**With a custom fallback:**

```tsx
// Returns '/fallback-page' instead of '#' for invalid URLs
<a href={sanitizeHref(entry.data.link, '/fallback-page')}>Click here</a>
```

**Behavior:**

| Input                           | Output                             |
| ------------------------------- | ---------------------------------- |
| `"https://example.com/page"`    | `"https://example.com/page"`       |
| `"http://example.com"`          | `"http://example.com"`             |
| `"/about"`                      | `"/about"` (root-relative)         |
| `"docs/guide"`                  | `"/docs/guide"` (relative)         |
| `"#section"`                    | `"#section"` (same-page)           |
| `"//evil.com/x"`                | `"#"` (protocol-relative, blocked) |
| `"\\evil.com/x"`                | `"#"` (protocol-relative, blocked) |
| `"not a url"`                   | `"/not%20a%20url"` (relative)      |
| `"javascript:alert(1)"`         | `"#"` (blocked scheme)             |
| `"data:text/html,<h1>bad</h1>"` | `"#"` (blocked scheme)             |
| `"http://"`                     | `"#"` (invalid URL)                |
| `""`                            | `"#"` (invalid URL)                |

Note that any input **without a scheme** is treated as a site-relative path, so a
string that isn't a URL at all (`"not a url"`) comes back as an escaped relative
link rather than the fallback. That is the safe direction — it can only ever
point at your own origin — but it means `sanitizeHref` is not a validity check:
if you want to reject junk, validate the value before rendering it.

Use `sanitizeHref` anywhere you render an `href` attribute with a value that comes from CMS content -- call-to-action links, navigation URLs, author website fields, etc. It constructs a fresh string from the parsed URL rather than passing the original input through, which also satisfies static analysis tools (e.g., CodeQL taint tracking).

### Error Handling Utilities

The typed error helpers CanopyCMS uses internally are available to adopters from the `canopycms/utils/error` subpath:

```typescript
import {
  getErrorMessage,
  isNodeError,
  isNotFoundError,
  isPermissionError,
  isFileExistsError,
} from 'canopycms/utils/error'
```

- `getErrorMessage(err)` — safely extract a string message from an `unknown` caught value (avoids `any`)
- `isNodeError(err)` — type guard narrowing to `NodeJS.ErrnoException` (gives you `.code`, `.path`, etc.)
- `isNotFoundError(err)` / `isPermissionError(err)` / `isFileExistsError(err)` — classify common **filesystem** failures (`ENOENT`, `EACCES`/`EPERM`, `EEXIST`) — useful when your own code does filesystem work, e.g. reading colocated files via `meta.physicalPath`

Note that CMS reads do **not** throw Node filesystem errors, so the helpers above will not match them. `read()` throws a `ContentStoreError` whose `code` field is one of `'NOT_FOUND' | 'NO_SCHEMA_ITEM' | 'FORBIDDEN' | 'VALIDATION'`. To branch on those (e.g., to render a `notFound()` vs. a `403`), check the `code` field:

```typescript
import { notFound } from 'next/navigation'

try {
  const { data } = await canopy.read({ entryPath: 'content/posts', slug })
  return <PostView post={data} />
} catch (err) {
  const code = err instanceof Error && 'code' in err ? err.code : undefined
  if (code === 'NOT_FOUND' || code === 'NO_SCHEMA_ITEM') return notFound()
  if (code === 'FORBIDDEN') return notFound() // or render a 403 — notFound() avoids leaking that the entry exists
  throw err
}
```

For URL-driven pages, [`readByUrlPath()`](#load-content-by-url-path) is usually simpler: it already resolves `NOT_FOUND`/`FORBIDDEN` to `null` so you can `if (!result) return notFound()` without a try/catch.

### Media Configuration

CanopyCMS stores uploaded images and PDFs in a content-addressed asset store and serves
images through an on-demand transform layer. Configure it with the `media` key:

```typescript
media: {
  adapter: 's3',
  bucket: 'my-site-assets',
  region: 'us-east-1',
  // Optional: absolute base URL when the editor is served from a different origin
  // than the public site (e.g. a dedicated editor domain). Omit for same-origin.
  publicBaseUrl: 'https://assets.example.com',
  // Optional: max upload size for presigned direct uploads (default 50 MiB).
  maxUploadBytes: 52_428_800,
}
```

For local development, omit `media` entirely (uploads go to `.canopy-dev/assets/` via the
built-in local adapter), or point at your real bucket to test the S3 path:

```typescript
media: { adapter: 'local', directory: '.canopy-dev/assets' }
```

**How it works**

- **Upload** — editors add images through the Media Library (a right-hand drawer opened
  from the editor's Settings menu) or directly from an `image` field / the MDX "Insert
  Image" dialog. Uploads go **straight from the browser to S3** via a presigned POST; the
  bytes never pass through your API route. On completion the server sniffs the real file
  type, strips EXIF metadata (including GPS), sanitizes SVGs, hashes the bytes, and records
  the asset.
- **Content addressing** — every asset is keyed by a hash of its bytes, so uploads are
  immutable and deduplicated. Content on a draft branch references its images immediately;
  publishing needs no separate asset step, and rollbacks always resolve.
- **Delivery** — images are served from `/assets/t/{directives}/…` URLs that transform on
  first request (resize, format-convert to WebP, crop) and cache immutably at the CDN
  thereafter. Use the exported helpers to build responsive markup:

  ```typescript
  import { assetUrl, assetSrcSet } from 'canopycms'

  <img
    src={assetUrl(image, { width: 960 })}
    srcSet={assetSrcSet(image, [480, 960, 1600])}
    sizes="(max-width: 700px) 100vw, 960px"
    alt={image.alt}
    width={image.width}
    height={image.height}
  />
  ```

  SVGs and PDFs are served statically (no transform).

**`image` fields** hold a structured value — `{ src, alt, width, height, crop? }` — so alt
text is enforced, intrinsic dimensions prevent layout shift, and crops are stored as a
directive rather than a derived file. Declare an `aspect` on the field (e.g. `'16:9'`,
`'1:1'`) to enable the interactive crop step, and `altOptional: true` for decorative
images.

**Permissions** — any authenticated editor can upload and list assets. Deleting an asset
from the library requires being an admin **or** the person who uploaded it, and removes
only the library record — existing content references keep resolving.

> **The asset store is site-wide, not branch-scoped.** Because assets are content-addressed
> and shared (which is what lets a branch merge avoid moving files), branch and path ACLs do
> **not** apply to them. Any authenticated editor can list and fetch every asset in the site,
> including images uploaded on branches they cannot otherwise access. Asset URLs are
> unguessable, but the library listing is open to all signed-in users, so treat "uploaded to
> CanopyCMS" as visible to your whole editorial team — confidential material does not belong
> in the asset store.

**Infrastructure** — the `canopycms-cdk` package ships an `AssetSupport` construct that
provisions the bucket (or attaches to an existing one), the transform Lambda, and the
CloudFront behaviors. See [docs/deploying-to-aws.md](docs/deploying-to-aws.md).

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

### Custom Field Renderers

Every [field type](#field-types) ships with a default control. `customRenderers` replaces the control for one or more types, keyed by the field's `type`, without forking the editor:

```tsx
// app/edit/page.tsx
'use client'
import { NextCanopyEditorPage } from 'canopycms-next/client'
import type { CustomFieldRenderers } from 'canopycms/client'
import config from '../../canopycms.config'

const customRenderers: CustomFieldRenderers = {
  // Every field declared `type: 'number'` now renders this instead.
  number: ({ value, onChange, id, field }) => (
    <label htmlFor={id}>
      {field.label ?? field.name}
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        value={typeof value === 'number' ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  ),
}

const EditorPage = NextCanopyEditorPage(config.client(), customRenderers)
export default function Page() {
  return <EditorPage />
}
```

Each renderer receives `CustomFieldRenderProps`:

| Prop       | Description                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `field`    | The full `FieldConfig`, so one renderer can vary on `label`, `required`, `options`, etc.            |
| `value`    | Current value, typed `unknown` — narrow it yourself                                                 |
| `onChange` | Call with the new value to update the draft                                                         |
| `path`     | Canonical path to this field (e.g. `['blocks', 0, 'title']`), so nested and list instances differ   |
| `id`       | The id the default control would have used — attach it to your input so labels and tests still work |

Renderers apply **by field type, everywhere** — top-level fields, fields inside `object` and `block` templates, and each item of a `list: true` field. There is no per-field override; scope with `field.name` inside the renderer if you need one.

**The value you pass to `onChange` must still satisfy the field's declared type.** CanopyCMS validates entries at the server write boundary with the same rules regardless of what rendered the input, so a renderer that stores a string into a `type: 'number'` field produces a `422` on save rather than a bad file. Custom rendering changes the control, not the schema contract.

`customRenderers` is also accepted directly by `<CanopyEditor>` and `<Editor>` if you compose the editor yourself instead of using the page factory.

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

- `path` -- URL path, lowercased by default (e.g., `"/docs/getting-started"`)
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

The `extract` callback receives a second `meta` argument with structural context:

- `meta.kind` -- `"collection"` or `"entry"`
- `meta.logicalPath` -- the node's logical path
- `meta.entryType`, `meta.format` -- present when `kind === "entry"`
- `meta.indexEntry` -- present when `kind === "collection"` and the directory contains an entry with `slug === "index"`. Carries that entry's `entryType`, `format`, and raw `data`. This represents the collection's identity under the **directory-as-page pattern** (e.g., a partner's metadata for `/data-catalog/<partner>/`, a section landing for `/docs/<section>/`).

Narrow on `meta.indexEntry.entryType` before reading type-specific fields:

```typescript
const tree = await canopy.buildContentTree({
  extract: (data, meta) => {
    if (meta.kind === 'collection' && meta.indexEntry?.entryType === 'partner') {
      return { isFictional: Boolean(meta.indexEntry.data.isFictional) }
    }
    return {}
  },
})
```

Note: `meta.indexEntry` is undefined for collections at the `maxDepth` cap (entries aren't loaded there).

#### Typed `meta.indexEntry.data` via Entry-Type Registry

`buildContentTree<T, TEntryTypes>` accepts an optional second generic — an adopter-supplied map from entry-type names to their data shapes. When provided, narrowing on `meta.indexEntry.entryType` types `meta.indexEntry.data` as the matching shape (a discriminated union), so you can drop `as` casts and `unknown` checks. The default for `TEntryTypes` is a loose `Record<string, unknown>`-style shape, so existing callers work unchanged. Reuse the schemas you already defined with `defineEntrySchema` via `TypeFromEntrySchema` — no redeclaration. The exported `EntryTypeMap` type alias documents the expected shape (`Record<string, object>`); adopters don't have to extend it, any matching interface works.

```typescript
import { defineEntrySchema, type TypeFromEntrySchema, buildContentTree } from 'canopycms'

const partnerSchema = defineEntrySchema([
  { name: 'name', type: 'string', isTitle: true },
  { name: 'isFictional', type: 'boolean' },
])
const docSchema = defineEntrySchema([{ name: 'title', type: 'string' }])

interface MyEntries {
  partner: TypeFromEntrySchema<typeof partnerSchema>
  doc: TypeFromEntrySchema<typeof docSchema>
}

const canopy = await getCanopyForBuild()
const tree = await canopy.buildContentTree<NavFields, MyEntries>({
  extract: (data, meta) => {
    if (meta.kind === 'collection' && meta.indexEntry?.entryType === 'partner') {
      // meta.indexEntry.data is typed as the partner shape — no casting needed
      return { isFictional: Boolean(meta.indexEntry.data.isFictional) }
    }
    return { isFictional: false }
  },
})
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

| Option      | Type                                                       | Default                                                  | Description                                                                                                                                      |
| ----------- | ---------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rootPath`  | `string`                                                   | Content root                                             | Starting collection path (e.g., `"content/docs"` for a subtree)                                                                                  |
| `extract`   | `(data, meta: ContentTreeExtractMeta) => T`                | -                                                        | Extract typed custom fields from raw entry/collection data. `meta.indexEntry` exposes a collection's directory-as-page index entry when present. |
| `filter`    | `(node: ContentTreeNode<T>) => boolean`                    | -                                                        | Return false to exclude a node and its descendants                                                                                               |
| `buildPath` | `(logicalPath, kind) => string`                            | Strips content root, lowercases, collapses index entries | Custom URL path builder (default collapses index entries to parent path and lowercases)                                                          |
| `sort`      | `(a: ContentTreeNode<T>, b: ContentTreeNode<T>) => number` | Order array then alphabetical                            | Custom sort for children at each level (replaces default sort)                                                                                   |
| `maxDepth`  | `number`                                                   | Unlimited                                                | Maximum depth to traverse                                                                                                                        |

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

## Listing Entries

`listEntries()` returns a flat array of every content entry in your site. It is designed for search indexing, sitemaps, and any other case where you need to iterate over all content without the tree hierarchy. (For `generateStaticParams`, prefer the bound `contentStaticParams` helper — see [Static Export with generateStaticParams](#static-export-with-generatestaticparams) — which enumerates routable paths without handing an admin context to your page module.)

> **`listEntries()` does not resolve `reference` fields unless you ask it to.** By default it reads content files raw off disk for speed across a whole site scan, so a `reference` field (top-level or inside a block template — see [Shared / Referenced Blocks](#shared--referenced-blocks)) comes back as a bare id string, or `null`. Pass `{ resolveReferences: true }` and it resolves them exactly as `read()`/`readByUrlPath()` do, at any nesting depth. Build a search index over content that leans on referenced/shared blocks with the option **on**, or that referenced content is silently missing from your index; leave it **off** for sitemaps and `generateStaticParams`, which only need paths and timestamps. See [Resolving References in a Listing](#resolving-references-in-a-listing) for the cost and the caveats.
>
> **An unparseable content file fails a production build.** Content files are named `{type}.{slug}.{id}.{ext}`; during an actual production `next build`, a `.md`/`.mdx`/`.json`/`.yaml` file in a collection directory that doesn't match that shape throws instead of being silently dropped from the result — the same "a page that vanishes from the build is worse than a red build" reasoning as the schema-invalid-entry guard above. Outside a production build it's still just skipped (logged only with `CANOPYCMS_DEBUG=true`), since in-progress renames legitimately leave such a file around while editing.

### Basic Usage

`listEntries()` is available on both the request-scoped context (`getCanopy()`) and the advanced build context (`getCanopyForBuild()`); use the latter for build scripts or whole-collection scans that run outside a request:

```typescript
// build script or non-request context
import { getCanopyForBuild } from '../lib/canopy'

const canopy = await getCanopyForBuild()
const entries = await canopy.listEntries()

// urlPath has index collapsing applied — preferred for URL generation
const slugs = entries.map((entry) => entry.urlPath.split('/').filter(Boolean))
```

Each entry includes `urlPath` -- a URL-ready string with index entries collapsed to their parent path (e.g., `'/guides'` instead of `'/guides/index'`, `'/'` for root index entries). This is round-trip safe with `readByUrlPath()`: calling `readByUrlPath(entry.urlPath)` resolves to the same entry. The raw `pathSegments` array is also available for consumers that need the unmodified filesystem structure.

### Each Entry Includes

| Field            | Type       | Description                                                                                                                                                                                                       |
| ---------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pathSegments`   | `string[]` | URL path segments (e.g., `['researchers', 'guides', 'glossary']`)                                                                                                                                                 |
| `urlPath`        | `string`   | URL-ready path with index entries collapsed (e.g., `'/guides'` instead of `'/guides/index'`; `'/'` for root index)                                                                                                |
| `slug`           | `string`   | Entry slug within its collection                                                                                                                                                                                  |
| `entryPath`      | `string`   | Full CMS logical path                                                                                                                                                                                             |
| `entryId`        | `string`   | 12-char Base58 content ID from the filename                                                                                                                                                                       |
| `collectionId`   | `string?`  | Collection content ID (if present)                                                                                                                                                                                |
| `collectionPath` | `string`   | Logical path of the parent collection                                                                                                                                                                             |
| `entryType`      | `string`   | Entry type name                                                                                                                                                                                                   |
| `format`         | `string`   | Content format (`json`, `md`, or `mdx`)                                                                                                                                                                           |
| `data`           | `T`        | Entry data (frontmatter + body for md/mdx, JSON fields for json)                                                                                                                                                  |
| `updatedAt`      | `string?`  | ISO 8601 timestamp, populated on every result. This is the file's filesystem mtime, not an editorial "last changed" date -- treat it as "changed since the last build," not an authoritative last-modified value. |

For md/mdx entries, `data.body` contains the raw markdown content.

### Extracting Custom Data

Use the `extract` callback to control what ends up in `data`. This is useful for dropping large fields (like body) from memory when you only need metadata:

```typescript
interface PostMeta {
  title: string
  publishDate: string
}

const entries = await canopy.listEntries<PostMeta>({
  extract: (raw) => ({
    title: (raw.title as string) ?? '',
    publishDate: (raw.publishDate as string) ?? '',
  }),
})

// entries[0].data.title is typed as string
```

### Filtering and Sorting

```typescript
const entries = await canopy.listEntries<PostMeta>({
  extract: (raw) => ({
    title: (raw.title as string) ?? '',
    publishDate: (raw.publishDate as string) ?? '',
  }),
  filter: (entry) => entry.entryType === 'post',
  sort: (a, b) => b.data.publishDate.localeCompare(a.data.publishDate),
})
```

### Scoping to a Subtree

Use `rootPath` to only load entries under a specific collection path, skipping everything else:

```typescript
const guideEntries = await canopy.listEntries({
  rootPath: 'content/docs/guides',
})
```

### Resolving References in a Listing

By default a listing leaves `reference` fields as the bare id string (or `null`) — it reads content files straight off disk and never looks the target up. Pass `resolveReferences` and each one becomes the referenced entry's data, exactly as `read()`/`readByUrlPath()` return it, at any nesting depth: top-level fields, inside `object` fields and inline `group`s, and inside block templates — which is what makes [shared/referenced blocks](#shared--referenced-blocks) usable from a listing at all.

```typescript
// A search index that must see the text inside shared blocks:
const entries = await canopy.listEntries({ resolveReferences: true })

// entries[0].data.snippet
//   off: 'a1b2c3d4e5f6'
//   on:  { id: 'a1b2c3d4e5f6', slug: 'signup', collection: 'content/snippets',
//          urlPath: '/snippets/signup', title: '...' }
```

`buildContentTree()` takes the same option (it also applies to the `indexEntry` handed to a collection's `extract`), and so does `collectRoutableEntries()`. `collectStaticPaths()` does not, because it discards entry data.

**Why it is off by default, when `read()` resolves automatically.** A resolved reference is a different shape, and a listing's `data` is your own type parameter — so nothing in the type system would flag the change if the default flipped. An `/authors/${data.author}` template would keep compiling and start emitting `/authors/[object Object]`. Deciding per call site keeps that where the code that reads the field is.

**What it costs.** Resolution needs the content ID index, so an opted-in call adds one index scan plus one read per _distinct_ referenced entry — not per referencing entry. All the resolution in one call shares a cache, so a block referenced from 40 pages is read once, not 40 times. With the option off, none of that machinery is built. Note that the shared read is what the cache saves; each referencing entry still gets its own copy of the resolved value, which is what `includeBody` (below) makes worth thinking about for large targets.

**Every resolved reference carries a `urlPath`** — the referenced entry's URL, following the same rule `listEntries` uses for `item.urlPath` (an `index` entry collapses to its parent path). Both come from one shared function, so a link built from a resolved reference reaches the entry the listing enumerates. You do not need a second pass to build an id → URL table.

**A target's body is opt-in, per field.** By default a resolved **md/mdx** target gives you its frontmatter, not its prose. Set `includeBody: true` on the reference field and the body arrives too, under that target entry type's own body field name:

```ts
{ name: 'snippet', type: 'reference', entryTypes: ['ctaSnippet'], includeBody: true }
```

The distinction is embed-vs-link, and it belongs on the field because it is a property of your content model rather than of any one call. A reference that **embeds** its target — a shared CTA rendered inline — wants the prose. One that **links** to it — related posts, an author byline — wants `urlPath` and a title, and definitely not the target's whole body inlined into every page read. Since a single call routinely contains both kinds, the field is the only place the answer can differ per reference. (No-op for json/yaml targets, whose whole document is already their data.)

Turning it on has a cost worth knowing: the body becomes part of every referencing entry's resolved value, so a long document embedded by many pages is carried — and copied — once per page. That is exactly why it is opt-in per field rather than resolution's default. For a snippet-sized shared block it is nothing; for a full article you probably wanted a link.

**`id`, `slug`, `collection` and `urlPath` are reserved** on a resolved reference. If the target models one of them as a real content field, the resolution value wins and the content field is not visible here — read that entry directly if you need it.

**Two caveats.** Path permissions are not applied to the resolved _targets_, matching `read()` — a reference can resolve to an entry the current user could not open directly. (The entries being listed are still permission-filtered as always, and an entry that is filtered out is never resolved.) And within a single call, a given id is looked up once and every occurrence shares that answer, so one listing is internally consistent rather than deciding per entry — though each occurrence still gets its own copy of the resolved object, so nothing you do to one entry's resolved reference can affect another's.

### Options Reference

| Option              | Type                                                       | Default      | Description                                               |
| ------------------- | ---------------------------------------------------------- | ------------ | --------------------------------------------------------- |
| `extract`           | `(raw, meta) => T`                                         | -            | Transform raw data; controls what `data` contains         |
| `filter`            | `(entry: ListEntriesItem<T>) => boolean`                   | -            | Return false to exclude an entry                          |
| `rootPath`          | `string`                                                   | Content root | Scope to a subtree (e.g., `"content/docs"`)               |
| `sort`              | `(a: ListEntriesItem<T>, b: ListEntriesItem<T>) => number` | -            | Custom sort comparator                                    |
| `resolveReferences` | `boolean`                                                  | `false`      | Resolve `reference` fields to the referenced entry's data |

### Imports

```typescript
// Types (for use in your components)
import type { ListEntriesItem, ListEntriesOptions } from 'canopycms'

// Via CanopyContext (recommended)
const canopy = await getCanopy()
const entries = await canopy.listEntries(options)

// Raw function (advanced -- requires branchRoot, flatSchema, contentRootName)
import { listEntries } from 'canopycms/server'
```

## Features

### Robust Content Relationships

Every entry gets an automatic UUID that stays the same even when you rename or move files. Reference fields use these IDs to create type-safe relationships that never break. The editor shows human-readable labels while storing stable identifiers, optimizing both for user experience and data integrity.

### Branch-Based Editing Workflow

1. **Create or select a branch**: Each editor works in isolation
2. **Make changes**: Edits are saved to the branch workspace
3. **Submit for review**: Creates a GitHub PR with all changes
4. **Review and merge**: Standard PR workflow on GitHub
5. **Auto-archive**: The CMS worker detects the merge on its next git-sync cycle (default every 5 minutes), archives the branch, and fast-forwards the base branch's content view automatically — no manual cleanup needed. If a PR is closed without merging, the branch stays "submitted" with a "PR closed" badge for an admin to follow up.
6. **Deploy**: Your CI/CD rebuilds the site after merge

The base branch itself (the PR target, usually `main`) is protected — it can never be submitted for review, and in production it's read-only in the editor until someone creates a branch off of it. See [Submitting for Review](#submitting-for-review).

The branch list also surfaces live sync-status badges — `syncing`, `sync-failed`, and `conflict` — visible to every user, so anyone can see at a glance when a branch's underlying git clone needs attention, alongside the existing `Merged` and `PR closed` badges.

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

Every content read and write must pass **both** layer 1 and layer 2.

> **Assets are outside this model.** Uploaded images and PDFs live in a content-addressed
> store that is site-wide, not branch-scoped, so neither layer applies to them: any
> authenticated editor can list and fetch every asset in the site, including images uploaded
> on branches they cannot otherwise access. This is a deliberate tradeoff — content addressing
> is what lets a branch merge avoid moving files. See [Media Configuration](#media-configuration)
> for the full statement.

**Branch access precedence**, highest first — admins/reviewers; an explicit `managerOrAdminAllowed` lockdown; an explicit user/group ACL; and finally, only when the branch has no ACL at all, the branch's creator, then `defaultBranchAccess`, and then the protected base branch.

Two exemptions are what make the fail-closed `defaultBranchAccess: 'deny'` default workable rather than a lockout:

- **The creator of an un-ACL'd branch always has access to it.** Otherwise a user could create a branch, delete it, and rewrite its ACL, but not read a single file on it.
- **The protected base branch always passes this layer.** It takes no ACL by design (an entry there would confer Withdraw rights on it) and its creator is the system, so nothing else could ever grant it — and it is where every user lands by default. Its contents are still governed by path permissions, submitting it is still impossible, and in prod it is still read-only.

Because both exemptions are scoped to branches with **no ACL**, writing an explicit ACL still restricts the branch — including against its own creator, which is how an admin locks down a branch someone else created.

**Bootstrap admin groups**: When using `getCanopy()`, users with IDs matching the `bootstrapAdminIds` configuration automatically receive the `admins` group membership, even before groups are set up in the repository. This makes initial setup easier.

**Build mode bypass**: During `next build`, all permission checks are bypassed to allow static generation of all content, regardless of auth configuration. In page modules, drive `generateStaticParams` with the bound `contentStaticParams` helper and resolve content with the phase-selecting `read`/`readByUrlPath` (both from `lib/canopy.ts`) so you avoid request-scope errors without importing an admin context.

#### Public read on server deployments

By default `defaultPathAccess` is `'deny'`, so an anonymous or unauthenticated request on a `server` deployment gets no content at all. To let unauthenticated visitors read published content while keeping edit/review locked down, scope the path default per permission level. Every content read must pass **both** the branch layer and the path layer, but you do **not** need to open branch access to do this — anonymous public pages resolve against the protected base branch, which always passes the branch layer:

```typescript
// canopycms.config.ts
export default defineCanopyConfig({
  // ...
  defaultBranchAccess: 'deny', // work branches stay private; the base branch is exempt
  defaultPathAccess: { read: 'allow' }, // edit/review still resolve to 'deny'
})
```

One thing to weigh before enabling this:

- **`{ read: 'allow' }` inverts deny-by-default for reads.** Any content path with **no matching rule** becomes publicly readable, and a rule that only targets `edit` does not restrict reading (an unmatched `read` still falls through to the allow default). To keep a subtree private, add an explicit rule whose `read` target denies it — don't rely on the absence of a rule.

Keep `defaultBranchAccess` at `'deny'` here. It is not read-scoped — it is the fallback for _any_ branch with no ACL, so setting it to `'allow'` to enable public read would also expose un-ACL'd **work** branches to every signed-in user. The base branch that serves your public pages is exempt from it regardless, so `'allow'` buys you nothing on this path.

A `FORBIDDEN` denial from a server-component read via `readByUrlPath` renders as `null`, so your page's existing `if (!result) return notFound()` produces an ordinary 404 -- not a 500, and without revealing that the content exists but is restricted. The denial reason is still emitted to the debug log (`CANOPYCMS_DEBUG=true`) for troubleshooting.

For this to work, pages that render content at request time should use the null-safe `readByUrlPath` rather than the strict `read()`: `read()` throws on both missing and forbidden content, which surfaces as a 500 error page unless you catch it yourself. Reserve `read()` for contexts where the content is known to exist and be readable (build-time generation, or after an explicit access check).

### System Health (Admins)

Admins get a "System health" panel in the editor's Settings menu for observing the CMS's operational state. It requires no extra integration -- it rides the same Editor component and catch-all API route as everything else:

- **Worker liveness**: See whether the CMS worker daemon (the process that syncs branches with git, detects merges, and archives merged branches) is running, and its last heartbeat.
- **Task queue**: Inspect queued and failed background tasks, with retry and delete actions.
- **Branch directory health**: See the health of each branch's git workspace, with repair and purge actions for ones that have drifted or gone stale.

### Live Preview

The editor shows a live preview of your actual site pages in an iframe. Changes update immediately via postMessage. Clicking elements in the preview focuses the corresponding form field.

**Security model.** Preview pages only accept messages when they are actually framed, and only from their direct parent window with a matching origin — same-origin by default. A standalone page (including one opened via `window.open` from a hostile site) never accepts draft data. If your editor is deployed on a different origin than the site, pass it explicitly:

```typescript
const { data, fieldProps } = useCanopyPreview<DocContent>({
  initialData,
  editorOrigin: 'https://editor.example.com', // only needed for cross-origin editor deployments
})
```

We also recommend serving your site with `Cross-Origin-Opener-Policy: same-origin` where your hosting allows — it severs `window.opener` handles entirely (the bridge is safe without it, but defense in depth is cheap).

**Reporting draft errors.** If your page compiles the draft body (e.g. MDX) and keeps the last good render on failure, the author sees a stale-but-fine preview while the draft is broken. Use `reportError` to tell the editor, which surfaces an alert next to the preview:

```typescript
const { data, reportError } = useCanopyPreview<DocContent>({ initialData })

useEffect(() => {
  compileMdx(data.body)
    .then(() => reportError(null)) // clears a previously reported error
    .catch((err) => reportError(`MDX failed to compile: ${err.message}`, 'body'))
}, [data.body, reportError])
```

Pair this with the [`validateEntry` hook](#save-time-validation-validateentry) to also reject such saves server-side.

## AI-Ready Content

CanopyCMS can serve your content as clean markdown for AI consumption (LLM tools, Claude Code, documentation chatbots, etc.). Content is converted from your schema-driven JSON/MD/MDX entries into well-structured markdown with a discovery manifest. No authentication is required -- the output is read-only.

All content is included by default (opt-out exclusion model). You can exclude specific collections, entry types, or entries matching a custom predicate.

Fields are converted from your schema to markdown automatically. Arrays of **flat records** (object-list fields whose subfields are all single-line scalars -- string/number/boolean/datetime/select/reference/image) render as a compact markdown **table**; lists whose items contain nested objects, sub-lists, or long-form text keep an expanded heading-per-item form. Table cells use default per-type rendering -- to customize, add a `fieldTransforms` entry for the **list field itself** (below), which replaces the whole field's output.

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

Like the static params build check above, this command fails loudly (unconditionally, not just in a real production build) if any entry is schema-invalid, listing every offending entry. Finish or delete abandoned create-scaffolds and rerun.

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

  // Per-field markdown overrides (keyed by entry type, then field name)
  fieldTransforms: {
    dataset: {
      dataFields: (value) =>
        `## Data Fields\n| Name | Type |\n|---|---|\n${(value as Array<{ name: string; type: string }>).map((f) => `| ${f.name} | ${f.type} |`).join('\n')}`,
    },
  },

  // Per-component MDX transforms (keyed by PascalCase component name)
  // Converts JSX components to clean markdown for AI output.
  // Return undefined to keep the original JSX unchanged.
  componentTransforms: {
    Callout: (props, children) => `> **${props.type ?? 'Note'}:** ${children}`,
    Spacer: () => '',
    ChecklistItem: (props, children) =>
      `- [ ] ${props.label ? `**${props.label}:** ` : ''}${children}`,
    MatrixRow: (props) => `- **${props.label}** (${props.category}): columns ${props.matches}`,
  },

  // Per-entry-type body transforms for general markdown cleanup.
  // Applied after componentTransforms; receives the full body string.
  bodyTransforms: {
    guideline: (body) => body.replace(/\s*\|\|[^\n]+/g, ''),
  },

  // Per-entry-type transforms that append markdown -- e.g. fold a colocated, machine-generated
  // sibling artifact into the generated output. Keyed by entry type; runs once per entry (may be
  // async). Return a string to append after the entry's body/fields, or undefined to append nothing.
  // Unlike bodyTransforms, these fire for every format, including data-only JSON/YAML entries.
  entryTransforms: {
    dataset: async (entry, { contentId, readSibling }) => {
      // readSibling reads a file colocated with the entry; path-safety/IO stay inside Canopy and
      // the entry's absolute filesystem path is never exposed. Returns null when the file is absent.
      const raw = await readSibling(`${contentId}.profile.json`)
      if (!raw) return
      return renderProfileSchema(entry.data, JSON.parse(raw)) // your own merge + renderer
    },
  },
})
```

**Transform processing pipeline:** For MD/MDX entries, transforms are applied in this order:

1. **`stripMdxImports`** -- import statements are removed automatically
2. **`componentTransforms`** -- JSX components are matched by PascalCase name and replaced with the transform output (or kept as-is if the transform returns `undefined`)
3. **`bodyTransforms`** -- the full body string is passed through the entry-type-specific transform for final cleanup

`componentTransforms` are keyed by component name and apply globally across all entry types (since MDX components are project-wide). `bodyTransforms` are keyed by entry type name and are useful for stripping entry-type-specific syntax that does not belong in AI output.

**`entryTransforms`** run once per entry and append their returned markdown after the entry's body/fields -- and that appended content automatically flows into the per-entry file, the collection `all.md`, and any bundle the entry belongs to. Unlike `bodyTransforms`, they fire for **every** format, including data-only JSON/YAML entries. Reach for them when an entry should export its own Canopy content **plus** a colocated, machine-generated neighbor (e.g. `<contentId>.profile.json`). Notes:

- **`contentId`** is the entry's stable Base58 ID -- the same id embedded in the entry's filename, and invariant when an editor renames the slug. Use it to name sibling artifacts so they stay matched to the entry across slug changes.
- **`readSibling(name)`** reads a bare filename colocated in the entry's directory; it rejects slashes, `..`, and absolute paths, and resolves `null` for a missing file. The entry's absolute path is never handed out, so it cannot leak into the published `/ai/` output.
- **The transform sees one entry, not the whole tree.** Cross-entry context (e.g. an index of all entries for resolving links between them) must be built in your own config code.
- **Appended content is published.** It is served at `/ai/...`, so do not append secrets or PII a public reader should not see.
- **Sibling files must exist where the exporter reads.** The static build reads your repo checkout; the runtime route handler reads the branch clone -- so commit the sibling artifacts into your content tree if you rely on the runtime handler.

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

> In production, the editor opens on the base branch (e.g. `main`) by default. This branch is browsable but read-only — click "Create a branch" in the banner, or use the branch selector, to start editing. See [Submitting for Review](#submitting-for-review).

### Working with Branches

**Creating a branch:**

1. Click the branch selector in the header
2. Click "New Branch"
3. Enter a descriptive name (e.g., `update-homepage-hero`)
4. Your branch is created and you can start editing

> Branch names are sanitized for use as git branch names and filesystem paths: any character other than letters, numbers, `.`, `_`, and `-` (e.g. `/`) is replaced with `-`. A name like `feature/hero-update` is created as `feature-hero-update`, and the editor consistently displays and uses that sanitized name everywhere (branch selector, Branches panel, URLs).
>
> A few names are reserved because they collide with a static top-level API route and can't be used for a branch: `admin`, `assets`, `branches`, `groups`, `permissions`, `users`, `whoami`. Creating one of these is rejected with a 400 error explaining the collision. Matching is exact and case-sensitive, so `Admin` or `admin-docs` are unaffected.

**Switching branches:**

1. Click the branch selector
2. Choose from available branches
3. The editor loads content from the selected branch

> The base branch is marked with a "Protected" badge in the branch list. It can't be submitted for review, and in production it can't be edited directly — create a branch instead.

**Branch status badges:**

- The branch selector and Branches panel show status badges -- `syncing`, `sync-failed`, and `conflict` -- so anyone can tell at a glance when a branch's underlying git clone needs attention, alongside the existing `Merged` and `PR closed` badges.

### Editing Content

**Selecting an entry:**

1. Use the sidebar to browse collections
2. Click an entry to open it in the editor
3. Create new entries with the "+" button (disabled for entry types with `maxItems: 1` when one already exists)

**Making changes:**

1. Edit fields using the form on the left
2. See changes reflected in the live preview on the right
3. Click "Save" to persist changes to your branch (changes are NOT committed yet) — this also clears your local unsaved draft for that file

**Discarding changes:**

- Use "Discard" to revert unsaved changes to the last saved state. You'll be asked to confirm before anything is discarded.

### Submitting for Review

When your changes are ready:

1. Click "Submit for Review" in the header
2. This commits your changes and creates a GitHub PR
3. The PR can be reviewed using standard GitHub workflows
4. Once merged, CanopyCMS detects it automatically (within one worker sync cycle) and marks the branch "Merged" in the Branches panel — your changes are also deployed with the next site build
5. If the PR is closed without merging, the branch shows a "PR closed" badge and stays submitted until an admin follows up

**A submitted branch is locked for content editing.** Once you submit, the editor disables Save and other write actions and shows a banner explaining that the branch is submitted for review (the server rejects edit requests too, so this isn't just a UI restriction). To resume editing, click "Withdraw" in the branch selector or Branches panel — this converts the PR back to a draft and returns the branch to `editing` status — or wait for a reviewer to click "Request changes" on the branch, which does the same thing and signals that revisions are needed.

The base branch (the PR target, usually `main`) can never be submitted — a branch can't be reviewed against itself, so the "Submit for Review" button is hidden whenever you're viewing it, in both dev and production. In production the base branch is also read-only in the editor: you can browse it, but making changes requires creating a branch first (the editor shows a banner with a "Create a branch" button when you're viewing it, and the base branch carries a "Protected" badge in the branch list). In dev mode the base branch stays fully editable — since local development typically starts there — but you'll still need to move your work to a branch before it can be submitted.

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

### System Health (Admins)

Admins can check the CMS's operational health from the same Settings menu:

1. Go to Settings (gear icon) → **System Health**
2. **Worker**: See whether the CMS worker daemon is alive and its last heartbeat
3. **Task Queue**: Inspect queued and failed background tasks; retry or delete individual tasks
4. **Branch Directories**: See per-branch workspace health; repair or purge unhealthy ones

## Adopter Touchpoints Summary

CanopyCMS is designed for minimal integration effort. Run `npx canopycms init` to generate all required files, or create them manually. Use `--app-dir` to customize the app directory path (default: `app`).

| Touchpoint       | File                                             | Purpose                                                                                                                                                                      |
| ---------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Config**       | `canopycms.config.ts`                            | Define settings and operating mode                                                                                                                                           |
| **Next.js wrap** | `next.config.ts`                                 | Auto-generated by `init`; wraps config with `withCanopy()` (supports `staticBuild` for dual-build sites)                                                                     |
| **Schemas**      | `{appDir}/schemas.ts`                            | Field schemas and registry (for `.collection.json` approach)                                                                                                                 |
| **Context**      | `{appDir}/lib/canopy.ts`                         | One-time async setup with auth plugin                                                                                                                                        |
| **API Route**    | `{appDir}/api/canopycms/[...canopycms]/route.ts` | Single catch-all handler                                                                                                                                                     |
| **Editor Page**  | `{appDir}/edit/page.tsx`                         | Embed the editor component                                                                                                                                                   |
| **Middleware**   | `middleware.ts`                                  | Auto-generated by `init` for the auth mode chosen at init time; passthrough for dev auth, Clerk middleware for Clerk auth. Does **not** switch at runtime -- see note below. |

**Optional touchpoints:**

- **Server components**: Use `await getCanopy()` to read draft content with automatic auth. For `[...slug]`/`[slug]` pages that render in both build and request phases, prefer the phase-selecting `readByUrlPath`/`read` from `lib/canopy.ts` (see [Phase-Selecting readByUrlPath / read](#phase-selecting-readbyurlpath--read)). `getCanopyForBuild()` remains as an advanced escape hatch for build scripts and whole-collection scans
- **Static export**: Use the bound `contentStaticParams` helper from `lib/canopy.ts` to drive `generateStaticParams` (supports `shape`, `rootPath`, and `basePath` for nested catch-all routes); see [Static Export with generateStaticParams](#static-export-with-generatestaticparams)
- **AI content route**: `{appDir}/ai/[...path]/route.ts` -- serve content as AI-readable markdown; generated by default during `init` (see [AI-Ready Content](#ai-ready-content))

Setting the `CANOPY_AUTH_MODE` environment variable (`dev` or `clerk`) switches auth providers for `canopy.ts` and the edit page at runtime, with no regeneration needed for those two files. `middleware.ts` is the exception: it is generated once, frozen to the auth provider chosen at `init` time, and does not read `CANOPY_AUTH_MODE`. If you switch auth providers after init (or just flip the env var), you must regenerate (`npx canopycms init --force`) or manually swap `middleware.ts` to match -- otherwise the passthrough middleware keeps `/edit` and `/api/canopycms` unprotected at the edge. This is a defense-in-depth gap rather than a full auth bypass (the Clerk auth plugin still rejects unauthenticated API calls, and the core fails closed in prod mode), but it should not be left unaddressed. The generated passthrough `middleware.ts` logs a warning if it detects `CANOPY_AUTH_MODE=clerk` at runtime to help catch this mismatch.

Everything else (branch management, content storage, permissions, comments, bootstrap admin groups, meta file loading) is handled automatically by CanopyCMS.

## Deploying to AWS

```bash
npx canopycms init-deploy aws
```

Scaffolds a complete, deployable CDK app for the recommended AWS architecture (Lambda, no internet access, + an EC2 worker + EFS, with optional CloudFront/Route53) alongside the Dockerfile and CI workflow:

| File                               | Purpose                                                                                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile.cms` / `.dockerignore` | Lambda Web Adapter image; install/build commands match your detected package manager (npm, pnpm, or Yarn — from `packageManager`, else the lockfile)                        |
| `.github/workflows/deploy-cms.yml` | CI/CD workflow; triggers on your repo's default branch (detected from `origin/HEAD`) and deploys the stack **by name**, so it can't touch unrelated stacks in the same repo |
| `cdk.json`                         | CDK app entry point                                                                                                                                                         |
| `infrastructure/bin/app.ts`        | CDK app; reads its configuration from environment variables and refuses to synth if a required one is missing                                                               |
| `infrastructure/lib/cms-stack.ts`  | the stack itself, yours to edit (memory/concurrency, media support, an existing distribution, etc.)                                                                         |

Install the CDK dependencies it needs — the CLI, and the generated workflow, both warn if any are missing:

```bash
npm install --save-dev canopycms-cdk aws-cdk-lib constructs tsx aws-cdk
```

Like `init`, this command never overwrites files you already have; pass `--force` to regenerate them.

Full walkthrough — required secrets/variables, filling in the stack, and troubleshooting — lives in [docs/deploying-to-aws.md](docs/deploying-to-aws.md).

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

`CLERK_SECRET_KEY` is resolved lazily, on the first authenticated request -- not at build/startup. This means a zero-editor static/public build (`deployedAs: 'static'`, no auth plugin exercised) never needs the secret at all. It's still required wherever authentication actually runs: the CMS server build/deployment and the worker daemon's auth-cache refresh.

For GitHub integration (production mode):

```env
GITHUB_BOT_TOKEN=ghp_...    # Bot token for PR creation
```

## Documentation

- [DEVELOPING.md](DEVELOPING.md) - Development guidelines for contributors (note: the CanopyCMS monorepo uses **pnpm** workspaces; see DEVELOPING.md for setup)
- [ARCHITECTURE.md](ARCHITECTURE.md) - Internal architecture (for contributors)
