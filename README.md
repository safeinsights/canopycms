# CanopyCMS

A schema-driven, branch-aware content management system for git-backed, statically-generated websites. CanopyCMS puts an editing interface on top of your existing git repository, so non-technical users can edit website content without touching Git. Content lives as MD/MDX/JSON files in your repo, changes happen on isolated branches, and publication flows through your existing GitHub PR workflow.

**Key features:**

- **Schema-driven content**: define entry schemas with `defineEntrySchema`, register them with `createEntrySchemaRegistry`, and reference them from `.collection.json` files beside your content — with runtime validation and type inference
- **Branch-based editing**: every editor works on an isolated branch, preventing conflicts and enabling review workflows
- **Git as source of truth**: content is versioned in git with full history, rollback, and PR-based review
- **Live preview**, with click-to-focus field navigation
- **Minimal integration**: config, one editor component, and one API route
- **Framework-agnostic core**: Next.js today, adaptable to other frameworks

## Requirements

- **Next.js**: `^13.5.7`, `^14.2.25`, `^15.2.3`, or `16.x` excluding `16.2.x` (see [Known-bad version: Next 16.2.x](#known-bad-version-next-162x)). This is `canopycms-next`'s `next` peer dependency range — installing outside it triggers your package manager's peer-dependency warning.
- **React**: `^18.0.0` or `^19.0.0`
- **Node.js**: `>=22.12.0`, both to consume the published packages and to work in this monorepo (`.nvmrc` pins the major). The packages are ESM-only and reach CommonJS consumers through `require(esm)`, which Node unflagged in 22.12.0, so a CommonJS project cannot load them on anything earlier.

### Known-bad version: Next 16.2.x

Next 16.2.x fork-bombs `next dev --turbopack`: the dev server boots, logs `○ Compiling /`, and the Node process tree self-replicates (255 → 511 → 1023 …) until the machine saturates. It bisects to Turbopack's PostCSS plugin resolution triggering on any imported CSS file — including `@mantine/core/styles.css`, which the CanopyCMS editor depends on, so any adopter using the default editor hits it on the first `pnpm dev` after upgrading. On 16.2.x, downgrade to `~16.1.7`.

`canopycms-next`'s `next` peer dependency excludes `16.2.x` specifically: 16.0.x and 16.1.x are unaffected, and 16.3.x+ is allowed because the regression has only been observed and bisected in 16.2.x, so blocking later releases would be a guess rather than a documented constraint. If you hit this outside 16.2.x, please file an issue so the range can be corrected.

## Table of Contents

- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Schema Registry and References](#schema-registry-and-references)
- [Configuration Reference](#configuration-reference)
- [Content Identification and References](#content-identification--references), and [Type Inference](#type-inference)
- [Integration Guide](#integration-guide) — [Load Content by URL Path](#load-content-by-url-path), [Index Entries and URL Resolution](#index-entries-and-url-resolution), [Static Export with generateStaticParams](#static-export-with-generatestaticparams)
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

The CLI asks for:

- **Auth provider** — `dev` (local development, no real auth) or `clerk`. `canopy.ts` and the edit page handle both at runtime via `CANOPY_AUTH_MODE`; `middleware.ts` does not (see [Adopter Touchpoints Summary](#adopter-touchpoints-summary)).
- **Operating mode** — `dev` or `prod`, written into `canopycms.config.ts` as the required `mode` field. CanopyCMS has no default and refuses to start without it.
- **Dual-build** — whether you build a static public site and a separate server CMS build from one repo (default: no). When enabled, CMS-only files use `.server.tsx`/`.server.ts` extensions so a static export build does not pick them up.
- **App directory** — where your Next.js app directory lives (default `app`; use `src/app` for src-layout projects).
- **Include AI content endpoint?** — route files serving your content as AI-readable markdown (default: yes). See [AI-Ready Content](#ai-ready-content).

Flags skip the prompts: `--app-dir <dir>`, `--non-interactive` (CI, uses defaults), `--force` (overwrite existing files), `--no-ai`, and `--auth <clerk|dev>` / `--dual-build` for the two choices above. Those last two apply whether or not `--non-interactive` is set: passing one skips that prompt, omitting it falls back to the prompt, or to the default (dev auth, no dual-build) under `--non-interactive`.

```bash
npx canopycms init --non-interactive --auth clerk --dual-build --force
```

### What it creates

- `canopycms.config.ts` — main configuration (mode, editor settings)
- `{appDir}/lib/canopy.ts` — server-side context; exports `getCanopy`, the phase-selecting `read`/`readByUrlPath`, `contentStaticParams`, `getHandler`, and `getCanopyForBuild`
- `{appDir}/schemas.ts` — entry schema definitions and registry
- `{appDir}/api/canopycms/[...canopycms]/route.ts` — the single catch-all API route
- `{appDir}/edit/page.tsx` — editor page component
- `{appDir}/ai/config.ts` and `{appDir}/ai/[...path]/route.ts` — AI content config and route (unless `--no-ai`)
- `middleware.ts` — route protection for `/edit` and `/api/canopycms`; passthrough by default, with a commented Clerk example inside, and written into the parent of your app directory rather than always the project root (see [Protect editor routes](#5-protect-editor-routes))
- `next.config.ts` — wrapped with `withCanopy()`; skipped, with manual instructions printed instead, if you already have a `next.config.js`/`.mjs` (see [Next.js configuration](#3-nextjs-configuration-auto-generated))

It also creates `.gitignore`, or appends to yours, to exclude `.canopy-dev/` — which is what stops an accidental `git add .` from committing the whole workspace as broken submodule-like entries.

### 2. Install dependencies

```bash
npm install canopycms canopycms-next canopycms-auth-dev canopycms-auth-clerk
```

The generated `canopy.ts` imports both auth packages and selects one at runtime from `CANOPY_AUTH_MODE` (default `dev`), so both must be installed.

**Clerk peer dependencies:** `canopycms-auth-clerk` declares `@clerk/nextjs` and `@clerk/backend` as peers, so you control the Clerk SDK versions — `npm install @clerk/nextjs @clerk/backend` if you use Clerk. With dev auth you can skip that; the peer-dependency warnings are harmless when `CANOPY_AUTH_MODE=dev`.

### 3. Next.js configuration (auto-generated)

`init` creates a `next.config.ts` wrapping your config with `withCanopy()` from `canopycms-next/config`, so there is nothing to set up manually, and asks before overwriting an existing `next.config.ts`. If you already have a `next.config.js` or `.mjs` it leaves that alone and prints the manual wiring instead, because Next.js loads exactly one config file (`.js`, then `.mjs`, then `.ts`, first match wins) — a second `next.config.ts` alongside it would be a file Next silently never loads, taking `withCanopy()` with it.

```typescript
// next.config.ts
import { withCanopy } from 'canopycms-next/config'

export default withCanopy({
  // ...your existing Next.js config
})
```

`withCanopy()` handles:

- **Transpilation** — Canopy packages export raw TypeScript; the wrapper auto-detects which are installed and adds only those to `transpilePackages`, so you never maintain that list.
- **React deduplication** — with `file:` references or linked packages, the bundler can follow symlinks and load a second copy of React, causing "Invalid hook call" crashes, so the wrapper aliases React to your project's copy. The aliases are harmless when unneeded, which is why `withCanopy()` is recommended for every adopter.
- **Dual-build page extensions** — adds `server.ts`/`server.tsx` to `pageExtensions`, enabling the convention below.
- **Standalone image tracing** — for any build except a static export, adds sharp's libvips shared library to Next's file tracing so a Turbopack `output: 'standalone'` server (Next 16's default bundler) can load sharp, which Next can miss for sharp 0.35 ([vercel/next.js#97973](https://github.com/vercel/next.js/issues/97973)). It does not fix a webpack build, where sharp is bundled into a server chunk and image transforms fail. Without `withCanopy()`, see the manual snippet in [Dual Build Support](docs/deploying-to-aws.md#dual-build-support), which also covers the webpack case.
- **Turbopack guard (Next 16+)** — sets `turbopack: {}` when your config has neither `turbopack` nor your own `webpack` and `withCanopy()` can read your Next version, since Next 16 defaults to Turbopack and exits when it sees the React-aliasing `webpack` function with no `turbopack` config. Your own `webpack`/`turbopack` config is left as-is.

**Make `withCanopy()` the outermost wrapper** when combining it with other config plugins: `withCanopy(withBundleAnalyzer({ ... }))`, not the reverse. It decides whether to add `turbopack: {}` from the config it receives, so a plugin wrapped around it adds its `webpack` afterwards and, on Next 16, that `turbopack: {}` silences the error Next would raise about a `webpack` function Turbopack does not run.

#### Dual-Build Sites (Static Export + CMS Server)

To deploy both a **static public site** and a **separate CMS server** from one Next.js app, use the `staticBuild` option and the `.server.ts`/`.server.tsx` extension convention. Skip this section entirely if you build once — the default works for both development and single-build production.

1. **Name CMS-only files** `.server.ts`/`.server.tsx` (`route.server.ts`, `page.server.tsx`): your API route handler and editor page, which the static site does not need.

2. **Toggle the build** with an environment variable:

```typescript
// next.config.ts
import { withCanopy } from 'canopycms-next/config'

// CANOPY_BUILD=static -> static export of the public site (editor/API excluded)
// CANOPY_BUILD=cms    -> standalone Node.js server for the CMS
// unset (next dev, or a plain `next build`) -> regular server build with the editor
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

With `staticBuild: true`, CMS-only `.server.*` files are invisible to the static export; otherwise — including plain `next dev` — those extensions are added to `pageExtensions`, which is why the editor works locally with no env var. Pair it with `deployedAs: process.env.CANOPY_BUILD === 'static' ? 'static' : 'server'` in `canopycms.config.ts` (generated by `init` when you choose dual-build) so the static export also skips auth and git operations at build time. That build never needs `CLERK_SECRET_KEY`, which is not read until the first authenticated request.

3. **Split content routes** shared by both builds — dynamic routes like `app/[slug]/`, and any fixed content page such as the home route. Two constraints force the split. First, `output: 'export'` requires `dynamicParams = false`, but on the CMS/server build that same setting makes an unknown slug throw Next's internal `NoFallbackError` (a 500) before your page's own `notFound()` runs — and Next statically parses route-segment config rather than evaluating it, so one page cannot switch `dynamicParams` on an env var (`process.env.CANOPY_BUILD !== 'static'` fails the build with "Invalid segment configuration export detected"). Second, the CMS/server build must not statically prerender content pages at all: a build-time prerender serves build-time content to every visitor, bypassing runtime path ACLs, and a slug outside `generateStaticParams()` is rendered as on-demand _static_ generation, where the request-scoped read's `headers()` call throws `DYNAMIC_SERVER_USAGE` (also a 500).

Put the implementation in a plain (non-route) file and add two thin route variants, with no plain `page.tsx` for that route:

```tsx
// app/[slug]/slug-page.tsx -- shared implementation: default-exports the page
// component, exports generateStaticParams

// app/[slug]/page.static.tsx -- static export build only: prerender every slug
export { default, generateStaticParams } from './slug-page'
export const dynamicParams = false

// app/[slug]/page.server.tsx -- CMS/server builds (and next dev): every request
// rendered at request time, branch-aware and ACL-enforced. No generateStaticParams
// re-export -- prerendering is what bypasses ACLs and breaks unknown slugs.
export { default } from './slug-page'
export const dynamic = 'force-dynamic'
```

`withCanopy(nextConfig, { staticBuild })` selects the variant per build: a static build adds `static.ts`/`static.tsx` to `pageExtensions` (so only `page.static.tsx` is seen), while CMS/server builds and plain `next dev` add `server.ts`/`server.tsx` instead. Fixed content pages follow the same shape minus `generateStaticParams`/`dynamicParams`.

The shared implementation should resolve content with the null-safe [`readByUrlPath()`](#load-content-by-url-path) (or catch errors from `read()`, see [Error Handling Utilities](#error-handling-utilities)) so an ACL denial on the `page.server.tsx` variant renders as `notFound()` instead of an uncaught 500. See [Public read on server deployments](#public-read-on-server-deployments) if anonymous visitors should read published content on that build.

4. **Build each target** separately in CI:

```bash
CANOPY_BUILD=static next build   # static public site, no CMS code
CANOPY_BUILD=cms next build      # CMS server, editor + API routes
```

> **Note:** because `withCanopy()` adds those extensions to `pageExtensions`, any pre-existing file ending in `.server.ts(x)` or `.static.ts(x)` inside your app directory will be treated as a page or route. Rename such files.

Using Clerk with dual-build? Its provider component cannot go in the root layout — see [Where a Clerk provider goes](docs/deploying-to-aws.md#dual-build-support) for the `.server.tsx`-scoped layout that keeps it out of the static export.

### 4. Customize your schemas

Edit `{appDir}/schemas.ts` with your content types. See [Schema Registry and References](#schema-registry-and-references).

### 5. Protect editor routes

`init` generates a `middleware.ts` matching `/edit` and `/api/canopycms`. It is a passthrough by default (suitable for dev auth); for Clerk, replace the contents with the commented example inside, or the snippet below.

The Clerk middleware is **optional**. CanopyCMS's own API authentication checks every `/api/canopycms` request and rejects unauthenticated calls without it; what the middleware adds is turning signed-out requests away before they reach the app. On a deployed CMS Lambda it costs `CLERK_SECRET_KEY` there (see [Security Model](docs/deploying-to-aws.md#security-model)) and a publishable key baked into each Docker image (see [Dual Build Support](docs/deploying-to-aws.md#dual-build-support)), so deleting `middleware.ts` is a supported choice.

`middleware.ts` is written into the **parent of your app directory**, not always the project root, because Next.js only loads middleware from there: with `--app-dir src/app` it is `src/middleware.ts`. Move it alongside the app directory if you move that later. Unlike `canopy.ts` and the edit page, it does not switch on `CANOPY_AUTH_MODE` at runtime — replace it too if you change auth providers.

```typescript
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

const isProtectedRoute = createRouteMatcher(['/edit(.*)', '/api/canopycms(.*)'])

export default clerkMiddleware(
  async (auth, req) => {
    if (isProtectedRoute(req)) {
      await auth.protect()
    }
  },
  // Local PEM verification. Without it @clerk/nextjs fetches JWKS over the network,
  // and the no-internet CMS Lambda hangs on sign-in.
  { jwtKey: process.env.CLERK_JWT_KEY },
)

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

`init` adds `.canopy-dev/` to your `.gitignore`, creating the file if needed, and branch metadata is excluded automatically via git's `info/exclude` inside branch workspaces. In production mode, permissions and groups live on a separate git branch (`canopycms-settings-{deploymentName}`).

## Schema Registry and References

Schemas live in TypeScript (declared with `defineEntrySchema`) and are registered with `createEntrySchemaRegistry`; your content lives in `.collection.json` files referencing registry schemas by name through their `entry.schema` property. CanopyCMS scans your content directory for those meta files and resolves the references when the editor starts and at build time.

### How It Works

Three pieces: the **registry** (a TypeScript object mapping entry-type names to field schemas), the **meta files** (`.collection.json`, next to the content they describe), and **automatic loading**. So content structure lives beside the content, schemas stay reusable, and a new collection is a new folder plus a meta file rather than a config change.

### Setting Up a Schema Registry

Create a schemas file, e.g. `app/schemas.ts`:

```typescript
import { defineEntrySchema, type EntryTypesFromRegistry } from 'canopycms'
import { createEntrySchemaRegistry } from 'canopycms/server'

// 1. Declare your entry schemas.
export const postSchema = defineEntrySchema([
  { name: 'title', type: 'string', label: 'Title', required: true },
  { name: 'author', type: 'reference', collections: ['authors'], displayField: 'name' },
  { name: 'published', type: 'boolean', label: 'Published' },
  { name: 'body', type: 'markdown', label: 'Body' },
])

export const authorSchema = defineEntrySchema([
  { name: 'name', type: 'string', label: 'Name', required: true },
  { name: 'bio', type: 'string', label: 'Bio' },
])

// 2. Register them, KEYED BY ENTRY-TYPE NAME -- the same string that appears in
// your `.collection.json` files' `entry.schema` property, in filenames
// (`post.<slug>.<id>.mdx`), and in `meta.entryType` from the tree builder.
export const entrySchemaRegistry = createEntrySchemaRegistry({
  post: postSchema,
  author: authorSchema,
})

// 3. Derive a typed entry-type map. Pass `EntryTypes` as the second generic to
// `canopy.buildContentTree<NavFields, EntryTypes>(...)` for narrowed access to
// `meta.indexEntry.data` after switching on `meta.entryType`.
export type EntryTypes = EntryTypesFromRegistry<typeof entrySchemaRegistry>

// 4. Per-schema aliases derive from EntryTypes -- single source of truth.
export type PostContent = EntryTypes['post']
export type AuthorContent = EntryTypes['author']
```

`createEntrySchemaRegistry` runs the field-shape checks at registry creation and throws, naming the field: a `select` must have `options`, a `reference` must have `collections` or `entryTypes`, `object`/`block` fields may not contain inline groups, and field names must not collide after group flattening. `defineCanopyConfig` is separately strict — it rejects unknown top-level keys rather than ignoring them, so a typo throws `Unrecognized key(s) in object`; keep to the keys in the [Configuration Reference](#configuration-reference).

#### Convention: why key the registry by entry-type name?

The string in `.collection.json`'s `entry.schema` is a lookup key into the registry. Keying by the **entry-type name** removes a level of indirection (`entry.name` and `entry.schema` are then the same string), makes errors clearer (`Available schemas: post, author, home`), and lets `EntryTypesFromRegistry` derive the typed entry-type map for you. Keying by schema-variable name instead (`{ postSchema, authorSchema }`) still works, but you then declare that map by hand as an interface of `TypeFromEntrySchema<typeof xSchema>` members and pass it to `buildContentTree<NavFields, MyEntries>`. That is the right choice when several entry types share one schema (`partner-v1` and `partner-v2` both pointing at `partnerSchema`), since name-keying would hold the same schema twice.

To move an existing project onto the entry-type-name convention, see [the migration entry](docs/adopter-migration.md#the-registry-is-keyed-by-entry-type-name-0042). Nothing about content files, frontmatter or `.canopy-meta/` caches changes, and in dev mode editing a `.collection.json` invalidates the schema cache so the next read picks up the new strings.

### Creating .collection.json Meta Files

A `.collection.json` in a content directory defines the collection there. Nesting comes from the directory tree — there is no `path` field — a collection may declare several entry types, and `maxItems: 1` makes one behave as a singleton:

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

A nested collection is the same file one directory down (`content/docs/api/.collection.json`). Root-level entry types — site-wide settings, a home page — go in `content/.collection.json` with no `name`.

### Connecting the Schema Registry

Pass the registry to `createNextCanopyContext` in `app/lib/canopy.ts`. `npx canopycms init` generates this file:

```typescript
import { createNextCanopyContext, type GenerateContentStaticParamsOptions } from 'canopycms-next'
import { entrySchemaRegistry } from '../schemas'
import config from '../../canopycms.config'

const canopyContextPromise = createNextCanopyContext({
  config: config.server,
  authPlugin:
    process.env.CANOPY_AUTH_MODE === 'clerk'
      ? createClerkAuthPlugin({ useOrganizationsAsGroups: true })
      : createDevAuthPlugin(),
  entrySchemaRegistry, // enables .collection.json support
})

// Server component pages: request-scoped, auth-aware.
export const getCanopy = async () => (await canopyContextPromise).getCanopy()

// Phase-selecting reads: working tree at build, branch-aware and ACL-enforced at
// request time. Recommended for resolving a page by URL in a [...slug]/[slug] route.
export const readByUrlPath = async <T = unknown>(urlPath: string) =>
  (await canopyContextPromise).readByUrlPath<T>(urlPath)

// Enumeration-only static params (no admin context reaches your page modules).
export const contentStaticParams = async (options?: GenerateContentStaticParamsOptions) =>
  (await canopyContextPromise).generateContentStaticParams(options)

// Advanced escape hatch: bypasses all ACLs (synthetic admin) and throws if used at
// request time on a production server. Prefer the three above.
export const getCanopyForBuild = async () => (await canopyContextPromise).getCanopyForBuild()

// API routes.
export const getHandler = async () => (await canopyContextPromise).handler
```

For a production deployment needing networkless JWT verification (AWS Lambda with no internet), replace the auth setup with `CachingAuthPlugin` and `createClerkJwtVerifier` — see [ARCHITECTURE.md](ARCHITECTURE.md#deployment-architecture).

**Writing a custom auth plugin?** In `mode: 'prod'`, CanopyCMS accepts only plugins that affirmatively set `readonly verifiesCredentials = true` — an allowlist marker meaning the plugin cryptographically verifies credentials, as `createClerkAuthPlugin` does. Any plugin without it (including `createDevAuthPlugin`, which trusts request headers unverified) is rejected at startup in prod, so a header-trusting plugin can never be deployed to production silently.

### Meta File Format Reference

```typescript
{
  "name": "collectionName",      // Required: collection identifier
  "label": "Display Name",        // Optional: human-readable label
  "entries": [                    // Optional: entry types in this collection
    {
      "name": "entryTypeName",    // Required: entry type identifier
      "label": "Display Name",    // Optional
      "format": "json" | "md" | "mdx",  // Optional: defaults to json
      "schema": "schemaRegistryKey",    // Required: key from the schema registry
      "maxItems": 1               // Optional: limit instances (1 = singleton-like)
    }
  ],
  "order": ["<contentId>", ...]   // Optional: explicit ordering; omitted/empty = alphabetical
}
```

A root `content/.collection.json` omits `name` and carries only root-level `entries`.

### Directory Structure Example

```
content/
├── pages/
│   ├── .collection.json      # Pages collection (home entry type, maxItems: 1)
│   └── page.home.a1b2c3d4e5f6.json  # type.slug.id.ext
└── docs/
    ├── .collection.json
    ├── doc.intro.q3r4s5t6u7v8.mdx
    └── guides/
        └── .collection.json  # nested collection
```

### Schema Validation

Schema references are validated at startup: a missing schema, or an invalid meta file, produces a clear error naming the collection and listing what is available (`Schema reference "post" in collection "posts" not found in registry. Available schemas: author, home, doc`).

## Configuration Reference

### `defineCanopyConfig` Options

- `gitBotAuthorName` / `gitBotAuthorEmail` (`string`, **required**) — identity used for git commits made by CanopyCMS.
- `mode` (`'dev' | 'prod'`, **required**) — see [Operating Modes](#operating-modes). No default: a deploy that omits it fails config validation at startup rather than silently running insecure dev auth semantics in production.
- `contentRoot` (`string`, default `'content'`) — root directory for content files, relative to the project root.
- `basePath` (`string`, optional) — the deployment prefix your Next app is served under (`'/preview-123'`), matching `next.config`'s `basePath`. CanopyCMS cannot read `next.config`, so state it here or the editor's API requests and preview pane target the un-prefixed root. **Not** `contentStaticParams`'s `basePath`, and not necessarily right for `assetUrl`'s `baseUrl` — see [Deploying under a `basePath`](#deploying-under-a-basepath).
- `defaultBaseBranch` (`string`, default `'main'`) — the fork point for CMS content branches. It can never be submitted for review, and in `prod` it is read-only in the editor; see [Submitting for Review](#submitting-for-review).
- `defaultActiveBranch` (`string`, optional) — which workspace the dev server serves content from and which branch the editor opens by default. Auto-detected from the current git branch in dev; falls back to `defaultBaseBranch` in prod.
- `defaultBranchAccess` (`'allow' | 'deny'`, default `'deny'`) — fallback access policy for a branch with no ACL, and what `canopycms init` scaffolds. **Three grants are exempt from it**, which is what makes the fail-closed default workable rather than a lockout: the `admins` and `reviewers` groups; the creator of an un-ACL'd branch (otherwise they could create a branch and rewrite its ACL but not read a file on it); and the protected base branch, which takes no ACL by design and is where every user lands. Because the last two are scoped to branches with **no ACL**, writing an explicit ACL still restricts the branch — including against its own creator, which is how an admin locks down a branch someone else created.
- `defaultPathAccess` (`'allow' | 'deny' | { read?, edit?, review? }`, default `'deny'`) — default policy for content paths when no permission rule matches. The object form scopes the default per level (`{ read: 'allow' }` for public read without opening edit/review); an unspecified level resolves to `'deny'`. See [Public read on server deployments](#public-read-on-server-deployments).
- `deployedAs` (`'server' | 'static'`, default `'server'`) — deployment shape. `'static'` means a pre-built site with no live editor: every CMS API request returns 401 and `authPlugin` is not required.
- `media` (`MediaConfig`, optional) — asset storage; see [Media Configuration](#media-configuration).
- `editor` (`EditorConfig`, optional) — editor UI customization; see [Editor Customization](#editor-customization).
- `dev` (`DevConfig`, optional) — dev-mode-only behavior, ignored when `mode !== 'dev'`. `dev.contentSync: 'off' | 'warn'` (default `'warn'`) controls how the dev server reports working-tree edits diverging from the served branch clone; see [Local Development Sync](#local-development-sync).
- `validateEntry` (`ValidateEntryHook`, optional) — save-time validation, run server-side before the entry file is written; see [Save-Time Validation](#save-time-validation-validateentry).

Schemas are not a config key: declare them with `defineEntrySchema`, register them with `createEntrySchemaRegistry`, and reference them from `.collection.json` files — see [Schema Registry and References](#schema-registry-and-references).

### Save-Time Validation (`validateEntry`)

Schema validation keeps field shapes clean, but cannot know that a markdown body must compile as MDX for your production build to succeed. The optional `validateEntry` hook lets the site refuse, or flag, a save that would break it:

```typescript
// canopycms.config.ts
export default defineCanopyConfig({
  // ...
  validateEntry: async ({ format, body }): Promise<EntryValidationIssue[]> => {
    if ((format === 'mdx' || format === 'md') && body) {
      try {
        await compile(body) // from @mdx-js/mdx
      } catch (err) {
        return [
          {
            level: 'error', // 'error' rejects the save; 'warning' saves but notifies
            fieldPath: 'body',
            message: `MDX failed to compile: ${getErrorMessage(err)}`,
          },
        ]
      }
    }
    return []
  },
})
```

The hook receives `{ entryPath, branch, entryType?, format, data, body }` for every editor content save. `error` issues reject the save and show the message to the editor; `warning` issues let it through as a notification. **It gates content writes only** — renames and deletes do not invoke it. Pair it with the preview error channel (see [Live Preview](#live-preview)) so authors see compile failures while typing.

### Comments in Content Files Survive Editing

Content files can carry YAML comments — including notes that code elsewhere refers to by name — and a CMS save keeps them: writes re-serialise onto the file's own parsed document, so a value the editor did not change keeps its comments, quoting and block style. This covers `.yaml` entries and `md`/`mdx` frontmatter; JSON has no comment syntax. The content itself is still fully determined by the save — a field the editor cleared is cleared in the file — and only comments carry across from what was on disk.

Four limits:

- A comment **before the first item of a list** belongs to the list, not that item, and stays at the head however the items change. Comments before any _later_ item travel with their item.
- A comment on a list item survives that item being **edited or moved**, but not **replaced** — nothing in a save says a new item is the old one edited, so CanopyCMS recognises an exact match wherever it moved to, and a partial match in the position it already occupied. Three cases match neither and start fresh: an item both edited _and_ moved, an item sharing nothing with what it replaced, and a **single-field** item whose field changed. Lists of non-mappings keep the simpler rule that the item in a given position is the same item edited.
- A value that **changes shape entirely** — a mapping or list replaced by a single value — loses the comments written inside it, because the structure they described is gone. A comment above the field's _name_ is unaffected.
- If a file's existing bytes **do not parse as YAML**, the save still succeeds by rewriting the file from scratch, which loses the comments. The alternative is an editor unable to save at all.

### Content Keys Not in the Schema

A field renamed or removed from a schema leaves its old key in every content file that had it, and nothing reads that key any more, so the only symptom is a component quietly receiving `undefined`. CanopyCMS reports these instead: **on save** they come back with the write as a "Saved with warnings" notification, and **during a production build** `collectStaticPaths` and `collectRoutableEntries` print one warning naming the offending entries and their key paths (`hero.kicker`, `blocks[2].headline`) — the entry count always exact, the listing stopping after the first 20 so a schema-wide rename cannot bury the build log.

Neither rejects a save or fails a build, and neither strips anything: an unrecognised key stays in the file, comments and all. For each reported key, either add the field to the schema or delete it from the content. This is separate from the `validateEntry` hook above — that one is yours to define, this one comes from the schema you already wrote.

### Operating Modes

`mode` is required in `defineCanopyConfig` — CanopyCMS throws at config validation time if it is omitted, so a deployment cannot accidentally run production with dev-mode auth semantics.

- **`dev`**: full local development with branching and git operations, using a local bare remote at `.canopy-dev/remote.git` and branch workspaces at `.canopy-dev/content-branches/`. `defaultActiveBranch` is auto-detected from the current git branch and the dev server follows branch switches with no restart.
- **`prod`**: branch workspaces on persistent storage (e.g. AWS Lambda + EFS). `defaultActiveBranch` falls back to `defaultBaseBranch` but can be set explicitly, e.g. to a staging branch. Because editors typically land on the base branch, it is read-only in the editor here (see [Submitting for Review](#submitting-for-review)). Permissions and groups are tracked in git on an orphan settings branch, and your `authPlugin` must declare `verifiesCredentials: true` (see [Connecting the Schema Registry](#connecting-the-schema-registry)) or CanopyCMS refuses to start.

### Local Development Sync

In `dev` mode your content lives in two places: your repo's working tree, and the branch workspaces under `.canopy-dev/content-branches/` that the editor reads. Editing the working tree directly (or pulling from GitHub) while the dev server serves a branch clone lets the two drift — the classic "builds fine, but the dev editor shows stale content" trap. The split runs the other way for `next build`, which reads only the working tree, so an editor's saved changes are not part of a build until `canopycms sync pull` copies them out.

**Automatic divergence detection.** `dev.contentSync` controls reporting (dev mode only, ignored when `mode !== 'dev'`): `'warn'`, the default, logs a warning at startup and on `content/**` changes naming the files that diverge from the branch clone; `'off'` installs no watcher.

> **There is no `'auto'` mode**, because it could clobber unsubmitted editor saves; reconcile with `canopycms sync push`, and see [ARCHITECTURE.md](ARCHITECTURE.md#operating-modes) for why.

```bash
npx canopycms sync push                            # working tree -> branch workspace
npx canopycms sync pull                            # branch workspace -> working tree
npx canopycms sync both                            # 3-way merge, then pull the result back
npx canopycms sync abort                           # cancel a failed merge
npx canopycms sync pull --branch update-homepage   # target one workspace
```

**Push** copies your working-tree content into a branch workspace and commits it, targeting the workspace matching your current git branch by default and creating it if needed. **Pull** copies content back so you can review, commit and push it yourself. Both accept `--branch`, and prompt you to choose when several workspaces exist and none is named. **Both** merges the two sides with a 3-way git merge and pulls the result back; **abort** restores the workspace to its pre-merge state.

> All project-bound CLI commands (`sync`, `migrate`, `generate-ai-content`, `worker run-once`) resolve the project root by walking up from the current directory to the nearest `canopycms.config.ts`, like git does — running them from a subdirectory works.

### Migrating Existing Content

Adopting CanopyCMS on a site with existing content? `canopycms migrate` converts a plain content tree into CanopyCMS conventions: entry files become `{type}.{slug}.{id}.{ext}`, and content-bearing directories get ID suffixes and a `.collection.json`, the root included when entry files live directly in it.

```bash
npx canopycms migrate --entry-type doc --format md --schema docSchema --dry-run
npx canopycms migrate --entry-type doc --format md --schema docSchema
```

- `--dry-run` prints the full rename/create plan without touching anything; omitted flags are prompted for.
- Only files of the chosen format are migrated; assets, other formats, and directories without matching content are left untouched.
- Re-running is a no-op: already-conforming names are skipped.
- Entry order is left unset (alphabetical). Source-specific ordering conventions (e.g. Nextra `_meta.json`) are out of scope — apply those with a follow-up script.

Afterwards, make sure the schema key you chose exists in your entry schema registry.

### Field Types

- `string` — single-line text; `number`, `boolean`, `datetime` — numeric value, toggle, date-and-time picker
- `markdown` / `mdx` — markdown text editor, and MDX with component support
- `image` — image upload/selection; `code` — code editor with syntax highlighting
- `select` — dropdown; takes `options: string[] | {label, value}[]`
- `reference` — a UUID-based link to another entry; takes `collections?`, `entryTypes?`, `displayField?`, `resolvedSchema?`
- `object` — nested object; takes `fields: FieldConfig[]`
- `block` — page blocks / "flexible content"; takes `templates: BlockTemplate[]`, each from `defineBlockTemplate` (see [Page Blocks](#page-blocks-flexible-content))

Common options on any field:

```typescript
{
  name: 'fieldName',      // Required: unique field identifier
  type: 'string',         // Required: field type
  label: 'Field Label',   // Optional: display label (defaults to name)
  required: true,         // Optional: validation requirement
  list: true,             // Optional: allow multiple values
  isTitle: true,          // Optional: use as the display title in the editor sidebar
}
```

On a `string` field, `list: true` renders a tag input: type a value and press Enter to add it, and Backspace on an empty input removes the last.

#### Rendering `markdown` / `mdx` content on your site

CanopyCMS stores and edits markdown and deliberately does **not** ship a renderer: two sites render the same markdown differently on purpose — different component mappings, different sanitization needs — so the presentation layer is yours. One trap is worth knowing, because it fails confusingly:

> **`react-markdown` does not work in a React Server Component.** Rendering its default export from a server component crashes a static prerender with `Element type is invalid … got: undefined`, while the same code resolves fine once it is in the client bundle. The fix is `'use client'` on your own wrapper component.

That fix is not free: the wrapper and its markdown subtree ship to the browser and lose server-only rendering for that part of the page. For static prose, consider a build-time renderer (`remark`/`rehype` to HTML, or MDX compiled at build time). `apps/example1` shows the client-wrapper shape.

### Field Groups

Field groups organize related fields visually in the editor without forcing you to restructure content files. `defineInlineFieldGroup` renders a labeled, bordered section and stores its fields **flat** alongside other top-level fields; `defineNestedFieldGroup` renders the same section but stores them as a **nested object** (`type: 'object'` with ergonomic sugar). Both are reusable across schemas and accept an optional `description` shown as hint text.

```typescript
const seoGroup = defineInlineFieldGroup({
  name: 'seo',
  label: 'SEO',
  description: 'Search engine metadata', // optional
  fields: [
    { name: 'metaTitle', type: 'string', label: 'Meta Title' },
    { name: 'metaDescription', type: 'string', label: 'Meta Description' },
  ],
})

const docSchema = defineEntrySchema([
  { name: 'title', type: 'string', required: true },
  seoGroup, // or defineNestedFieldGroup with the same arguments
  { name: 'body', type: 'markdown' },
])
// inline group -> { title: string; metaTitle: string; metaDescription: string; body: string }
// nested group -> { title: string; seo: { metaTitle: string; metaDescription: string }; body: string }
```

### Reusable Field Fragments

A common field cluster — a call-to-action's label and link, a preview object's title, image and description — otherwise gets retyped inline in every schema that needs it, and the copies drift invisibly until content authored against one fails to validate against another. Sharing one needs no special CMS support, because `defineEntrySchema` and `defineBlockTemplate` infer literal types from a `const` array wherever it came from: **spread the cluster into `fields`**.

```typescript
const ctaFields = defineFieldFragment([
  { name: 'ctaLabel', type: 'string', label: 'Button Label' },
  { name: 'ctaHref', type: 'string', label: 'Button Link' },
])

const heroSchema = defineEntrySchema([{ name: 'headline', type: 'string' }, ...ctaFields])
const bannerSchema = defineEntrySchema([{ name: 'message', type: 'string' }, ...ctaFields])

type Hero = TypeFromEntrySchema<typeof heroSchema>
// { headline: string; ctaLabel: string; ctaHref: string }
```

`defineFieldFragment` is a three-line const-inference identity helper, for discoverability alongside the field-group helpers; a plain `const ctaFields = [...] as const` works the same way. **Per-use overrides** fall out of the same mechanism — the case that otherwise pushes people to copy-paste: keep each field as its own const, then spread it as-is or override the one key that differs (`{ ...ctaHrefField, required: true }`).

Where the cluster should also appear as a bordered section rather than loose fields, **nest a `defineInlineFieldGroup()` const inside the block templates' `fields` arrays** instead of spreading a plain array. Inline groups are transparent all the way down — type derivation flattens them (see [Field Groups](#field-groups)), and so do storage, validation, reference resolution and the editor — so a group works inside a block template exactly as inside a top-level schema, and each template's value shape carries the group's fields flat, with no `cta` key.

### Page Blocks (Flexible Content)

A `block` field holds an ordered, repeatable list of heterogeneous section blocks discriminated by a `template` key — the "flexible content" / page-builder pattern. Each block picks one of the field's templates, so a page entry becomes an array of typed sections that editors can add, remove and reorder. Templates can hold any field type, including `object`, `reference` and inline field groups.

`defineBlockTemplate()` (from `canopycms`) is an identity/type-inference helper like `defineEntrySchema`: it returns the template unchanged but preserves the literal types, so `TypeFromEntrySchema` derives the right discriminated union. Define a section template once and embed it in several schemas rather than duplicating it inline:

```typescript
const heroBlock = defineBlockTemplate({
  name: 'hero',
  label: 'Hero',
  fields: [
    { name: 'heading', type: 'string' },
    { name: 'subheading', type: 'string', required: false },
  ],
})

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

Switch on `block.template` to render each section (see [Typed Block Discriminated Unions](#typed-block-discriminated-unions)).

### Shared / Referenced Blocks

A block template is just a schema, so a block field can hold a `reference` field like any other — which makes a **shared content block** possible with no dedicated CMS feature: define the shared content as its own entry type (a small "snippet" collection), then give a block template a single `reference` field pointing at it. Editing the snippet then updates every page that references it, instead of a find-every-page-and-paste edit across a dozen copies that have already drifted.

```typescript
// 1. The shared content is its own entry type, like any other collection.
const ctaSnippetSchema = defineEntrySchema([
  { name: 'title', type: 'string' },
  { name: 'ctaText', type: 'string', label: 'Button Text' },
])

// 2. A one-field block template references it. entryTypes scopes the picker to that
//    entry type regardless of which collection it lives in.
const sharedCtaBlock = defineBlockTemplate({
  name: 'sharedCta',
  label: 'Shared CTA',
  fields: [
    {
      name: 'snippet',
      type: 'reference',
      entryTypes: ['ctaSnippet'],
      resolvedSchema: ctaSnippetSchema, // typed as the resolved snippet, not a bare id
    },
  ],
})

const pageSchema = defineEntrySchema([
  { name: 'sections', type: 'block', templates: [sharedCtaBlock /* , ...others */] },
])
```

Reading resolves it automatically: `read()` and `readByUrlPath()` recurse into block templates and resolve any `reference` field there, the same as a top-level one, so `section.value.snippet` on a `sharedCta` section is the full resolved entry rather than an id.

> **In a listing, ask for resolution explicitly.** [`listEntries()`](#listing-entries) and `buildContentTree()` read content files raw off disk and resolve nothing **unless you pass `{ resolveReferences: true }`** — so a surface built from a listing without it sees a shared block's reference as `null` or a bare id, and a search index built that way silently contains nothing for those blocks. See [Resolving References in a Listing](#resolving-references-in-a-listing). (The AI-content export is separate: it disables resolution on purpose, so shared-block content is not duplicated into every referencing page's export.)

## Content Identification & References

### UUID-Based IDs

Every entry automatically receives a unique, stable 12-character identifier (Base58-encoded, truncated UUID), embedded in its filename (`my-post.a1b2c3d4e5f6.json`). So an ID survives a slug change, is visible in git diffs and preserved through `git mv`, and is never something you create or manage by hand.

### Reference Fields

Reference fields create typed relationships between entries, storing UUIDs rather than brittle string links or file paths, so they survive renames and directory moves. Scope what a field can point at with `collections`, `entryTypes`, or both — at least one is required:

- **`collections`** — scope by collection path(s), including every subcollection in that tree.
- **`entryTypes`** — scope by entry type name(s), whatever collection the entries live in, which is what lets you reference entries sitting alongside their related content in subcollections without a dedicated collection.
- **Both** — precise scoping, e.g. only `partner` entries within the `data-catalog` tree.

> Every `entryTypes` value is validated against the entry type names your `.collection.json` files actually define. A name matching none of them is a hard error at schema resolution — naming the field, its location, a "did you mean" suggestion for a close match, and the full list of known entry types — rather than a picker that silently returns zero options.

```typescript
const schema = defineEntrySchema([
  {
    name: 'tags',
    type: 'reference',
    collections: ['tags'],
    displayField: 'label', // show this field of the target, not its ID
    list: true, // allow multiple references
  },
  {
    name: 'catalogPartner',
    type: 'reference',
    collections: ['data-catalog'], // this tree and its subcollections
    entryTypes: ['partner'], // but only entries of this type
    displayField: 'name',
    resolvedSchema: partnerSchema, // optional: types the resolved value
  },
])
```

Delete a referenced entry and you get validation errors on the entries pointing at it.

### How References Work in the Editor

The editor loads the available options from the configured scope and validates that a reference always points at a valid entry. Open the dropdown to see every matching entry, search by the display field's value, and select one — CanopyCMS stores the UUID while showing `displayField`.

### Using References in Your Code

`read()` and `readByUrlPath()` **resolve reference fields for you**, at any nesting depth (top-level fields, inside `object` fields and inline groups, and inside block templates), so a reference field arrives as the referenced entry's data rather than an id:

```typescript
const { data } = await canopy.read<Post>({ entryPath: 'content/posts', slug: 'my-post' })
// data.author is the resolved author entry
```

Pass `resolveReferences: false` to get the bare ids instead. Declare `resolvedSchema` on the field to have the inferred type match the resolved shape (see [Typed References with `resolvedSchema`](#typed-references-with-resolvedschema)). A **listing** is the opposite default — it resolves nothing unless asked; see [Resolving References in a Listing](#resolving-references-in-a-listing).

### Type Inference

`TypeFromEntrySchema` derives TypeScript types from a schema:

```typescript
import { defineEntrySchema, TypeFromEntrySchema } from 'canopycms'

const postSchema = defineEntrySchema([
  { name: 'title', type: 'string', required: true },
  { name: 'tags', type: 'string', list: true },
])

// { title: string; tags: string[] }
type Post = TypeFromEntrySchema<typeof postSchema>
```

It covers every field type: `string` and `markdown` become `string`, `object` fields become nested objects, and `list: true` wraps the value in an array.

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

Both option forms work, including one array mixing them. A bare string option contributes itself; a `{ label, value }` option contributes its **`value`**, so comparing against the label is a compile error — usually the bug you wanted caught. With `list: true` you get an array of the union.

Two cases fall back to `string` rather than a union, deliberately, keeping the inferred type usable instead of collapsing it to `never`: **the options are no longer literals** (an options array annotated as the runtime type, `const options: SelectOption[]`, has none left to infer), or **there are no options** — `createEntrySchemaRegistry`, rather than `defineCanopyConfig`, rejects both of those with a clear message, so a schema you never register is only ever checked at the type level.

One caveat when reading existing content: the validator treats an empty string as "not filled in" for any field not explicitly `required: true`, so a select can hold `''` on disk. `''` is **not** in the inferred union — like the rest of `TypeFromEntrySchema`, it describes the shape your schema declares rather than everything the validator tolerates. To branch on a cleared select, add `''` to that field's `options`.

#### Optional Fields

A field with an explicit `required: false` becomes an **optional property** (`subheading?: string`), not a required property typed `string | undefined`:

| Field declaration                                | Inferred property |
| ------------------------------------------------ | ----------------- |
| `{ name: 'a', type: 'string', required: true }`  | `a: string`       |
| `{ name: 'a', type: 'string' }`                  | `a: string`       |
| `{ name: 'a', type: 'string', required: false }` | `a?: string`      |

Reading is unchanged — `hero.subheading` is still `string | undefined`. What changes is construction: a literal can omit the field, and adding a new optional field to a schema does not break existing hand-written literals. The rule applies at every level: top-level fields, fields inside `object` fields, and fields inside block templates.

Only an **explicit** `required: false` does this. A field omitting `required` stays a required property — the type-level default, chosen so a schema author opts in to optionality rather than getting it silently. That is stricter than the runtime validator, whose default is the opposite (`validateEntryData` enforces only `required: true` fields), so a field with no `required` is typed as present but validated as absent-tolerant; pass `required: false` explicitly if you want the two to agree.

Under `exactOptionalPropertyTypes: true`, explicitly assigning `undefined` to an optional key is an error — assign nothing, or widen the field's type yourself. That flag also **requires `skipLibCheck: true`** (the Next.js default) to compile against this package at all today: with `skipLibCheck: false` a `reference` field's `resolvedSchema` inference hits a library-internal type error, which you meet before writing a line against the schema, and there is no workaround.

#### Typed Block Discriminated Unions

Block fields produce a proper **discriminated union** from their templates, so a `switch` on `block.template` narrows `block.value` to that template's shape (see the `Page['sections']` union under [Page Blocks](#page-blocks-flexible-content)):

```typescript
for (const block of page.blocks) {
  switch (block.template) {
    case 'hero':
      // block.value is narrowed to { headline: string; body: string }
      return <HeroSection headline={block.value.headline} body={block.value.body} />
    case 'cta':
      return <CtaSection title={block.value.title} ctaText={block.value.ctaText} />
  }
}
```

#### Block Component Registries

That `switch` works, but it is easy to leave it with a `default: return null` clause "for forward compatibility" — which quietly turns a schema typo or a renamed template into a block that renders nothing, with a green build and green tests. A **mapped type keyed off the block union** makes the mapping exhaustive _by construction_, failing the build rather than the render: `BlockValueOf<Blocks, N>` pulls one template's value shape out of the union, and `BlockComponentRegistry<Blocks, ExtraProps>` builds the exhaustive map — one `ComponentType<{ data: ... } & ExtraProps>` per template.

```typescript
import type { BlockComponentRegistry } from 'canopycms'

type Blocks = Page['blocks'][number]

const blockRegistry: BlockComponentRegistry<Blocks> = {
  hero: ({ data }) => <HeroSection headline={data.headline} body={data.body} />,
  cta: ({ data }) => <CtaSection title={data.title} ctaText={data.ctaText} />,
  // Missing a key, or adding one that isn't a template name, is a compile error.
}
```

(The missing-key direction is airtight in every form; the stray-key direction relies on TypeScript's excess-property check, which is literal-only — an extra key on a pre-typed object assigned through a variable is not caught. Constructing the registry as an object literal, as above, is the normal way to write one, so the check applies.)

CanopyCMS ships no `renderBlocks()` helper: it would have to pick a key strategy, an unknown-template policy, and how extra props reach each component, and any one of those choices is wrong for someone. The registry is the whole primitive, and reading it is a `blocks.map()` you own — `blockRegistry[block.template]`, asserted to `ComponentType<{ data: typeof block.value } & ExtraProps> | undefined`, rendered with `data={block.value}`. That assertion is the one place trust is spent, since `block.template` and `block.value` come from the same object and always agree at runtime while TypeScript cannot correlate a dynamic key lookup with a union's narrowing. **Keep the `undefined` check**: the compile-time exhaustiveness covers the schema, not data at rest, and a content file can still carry a `template` name since renamed or removed. The build-time schema-validity guard catches that for a production static export, but request-time rendering (a dev server, or an on-demand render of content saved after the last build) reads content with no such guard, so a stale name arrives as `undefined` and React throws "Element type is invalid", taking the page down.

#### Typed References with `resolvedSchema`

By default a reference field infers as `string | null` (the UUID). Pass `resolvedSchema` pointing at the target schema to have the inferred type reflect the resolved entry's shape instead:

```typescript
const postSchema = defineEntrySchema([
  { name: 'title', type: 'string' },
  {
    name: 'author',
    type: 'reference',
    collections: ['authors'],
    displayField: 'name',
    resolvedSchema: authorSchema, // infer the resolved type from this schema
  },
])

type Post = TypeFromEntrySchema<typeof postSchema>
// Without resolvedSchema: Post['author'] is string | null
// With resolvedSchema:    Post['author'] is { name: string; bio: string } | null
```

`resolvedSchema` is used only for type inference — it does not affect how content is read, written or validated at runtime, and is stripped from API responses. It accepts any schema created with `defineEntrySchema`, so the same schema objects can be shared between entry type definitions and reference fields.

## Integration Guide

### Reading Content in Server Components

`getCanopy()` gives a Next.js server component automatic authentication and branch handling:

```typescript
// app/posts/[slug]/page.tsx
export default async function PostPage({ params, searchParams }) {
  const canopy = await getCanopy()
  const { data } = await canopy.read({
    entryPath: 'content/posts',
    slug: params.slug,
    branch: searchParams?.branch, // optional: defaults to the active branch
  })
  return <PostView post={data} />
}
```

> **Request-time errors:** `read()` throws if the entry is missing or the current user cannot read it (an anonymous visitor on a `server` deployment with [public read](#public-read-on-server-deployments) enabled, say) — and an uncaught throw becomes a 500 page, not a 404. Catch it explicitly (see [Error Handling Utilities](#error-handling-utilities)) or prefer [`readByUrlPath()`](#load-content-by-url-path), which returns `null`.

The context extracts the current user from request headers via the auth plugin, applies bootstrap admin groups, and is cached for the request lifecycle with React's `cache()`. During `next build` permissions are bypassed and content is read from the working tree, never a branch workspace, so a build renders exactly what is on disk. Besides `read()` it exposes `readByUrlPath()` (below), `buildContentTree()` (see [Content Tree Builder](#content-tree-builder)), `listEntries()` (see [Listing Entries](#listing-entries)), `user`, and `services`.

### Load Content by URL Path

`readByUrlPath()` maps a URL path straight to a content entry, handling the collection/slug split and index-entry resolution — the simplest way to load content when your routes mirror your content structure:

```typescript
// app/[...slug]/page.tsx
export default async function Page({ params }) {
  const urlPath = '/' + (params.slug?.join('/') ?? '')
  const result = await readByUrlPath<{ title: string; body: string }>(urlPath)
  if (!result) return notFound()
  return <Article title={result.data.title} body={result.data.body} />
}
```

**Resolution order:**

1. `/docs/getting-started` — tries `content/docs` + slug `"getting-started"` (direct entry match)
2. If that fails, tries `content/docs/getting-started` + slug `"index"` (index entry fallback)
3. `/docs/guides` — resolves to the index entry of the `guides` collection, if one exists
4. `/` — resolves to the root index entry at the content root, if one exists
5. `/docs/guides/index` — returns `null`. When the last segment is literally `index`, step 1 is skipped, because an index entry's advertised URL is its collection's path (step 3). Step 2 still runs, which is what resolves a collection actually _named_ `index`.

It returns `null` when nothing matches the path, and also when the current user is not permitted to read what does — a `FORBIDDEN` denial renders as a 404 through your existing `if (!result) return notFound()` rather than throwing. The strict `read()` API still throws on permission errors.

### Index Entries and URL Resolution

An index entry (slug `"index"`) is the default content for a collection URL, and all three content APIs treat it consistently: `readByUrlPath('/guides')` resolves the index entry in `guides`, `readByUrlPath('/')` the one at the content root, and `readByUrlPath('/guides/index')` returns `null` in any case variant (`/guides/Index`, `/guides/INDEX`) because `.../index` is not a second URL for the entry. `listEntries()` reports `urlPath: '/guides'` (or `'/'`), and `buildContentTree()` generates `path: '/guides'`, by default.

So `entry.urlPath` from `listEntries()` is round-trip safe: `readByUrlPath(entry.urlPath)` always resolves back to the same entry. Neither `/docs/index` nor `/docs/<entryTypeName>` reaches an index entry, the latter because that candidate's `entryPath` lands on an entry-type schema item rather than the collection its segments name, and `readByUrlPath` accepts only a candidate whose `entryPath` is an actual collection. (For an ordinary entry the final slug segment stays case-insensitive, so `/docs/OVERVIEW` still resolves `/docs/overview`; collection path segments do not.)

**Model your home page as a root index entry.** A singleton stored as an ordinary root entry (`content/home.home.<id>.json`) has `urlPath: '/home'`, so a route serving it at `/` leaves the entry's own URL disagreeing with the served one — which every URL-derived surface then has to be told about separately, starting with the sitemap. Stored as a root index entry (`content/home.index.<id>.json`) its `urlPath` is `/`, the route reads `readByUrlPath('/')`, and nothing needs special-casing. Note that a read addressing it by entry-type path does not follow: `read({ entryPath: 'content/home' })` with no `slug` defaults the slug to the entry-type _name_, so it looks for slug `home` rather than `index`. Passing `slug: 'index'` explicitly works, but prefer `readByUrlPath('/')`.

### One URL, one entry

Each entry gets exactly one `urlPath`, but nothing stops two _different_ entries computing the same one — and then only one can be served while the other silently has no route at all. A **production build** therefore fails, listing the contested URLs and their claimants. (`next dev` and the admin UI are unaffected: mid-edit trees may be temporarily broken.)

The usual causes: an entry whose slug matches a sibling collection **that also has an `index` entry**, since the index collapses onto the collection's path, which is the entry's path too (a sibling collection with no index entry is fine — a landing page plus a folder of children is a normal shape); two slugs differing only by case, since URL paths are lowercased; and two entries with the same slug in one collection, which the write boundary refuses but which still arrives by merge, by PR, and by retrofit onto an existing repo.

`findDuplicateUrlPaths` (from `canopycms/server`) is the same scan the build runs. Give it `listEntries()` rather than `collectRoutableEntries()`, which drops the `entryPath` that names the offenders:

```typescript
const duplicates = findDuplicateUrlPaths(await (await getCanopyForBuild()).listEntries())
// [{ urlPath: '/docs/guides', entryPaths: ['content/docs/guides', 'content/docs/guides/index'] }]
```

### Every slug must round-trip through a URL

Content file names follow `{type}.{slug}.{id}.{ext}`, and the `slug` segment may contain dots, since the type and ID anchor the parse: `post.getting.started.guide.<id>.md` parses fine and lists with `slug: 'getting.started.guide'`. But `readByUrlPath()` accepts only slugs of lowercase letters, numbers and hyphens, starting with a letter or number, because that is the rule it runs every URL-resolution candidate through before attempting a read. A slug outside that shape builds, gets a `generateStaticParams` entry and a sitemap `<loc>`, and then 404s on every visit, silently breaking the round-trip guarantee above — so a **production build** fails loudly instead, listing every offending entry by path.

The write API refuses to create one: a `PUT` that would mint an entry with a non-conforming slug is rejected with `400`, as is a rename to one, so this applies to any client and not just the editor UI. That enforcement is **create-only by design** — an entry already carrying a non-conforming slug (hand-authored, script-imported, merged in over git) stays readable, saveable and renameable, because renaming it is the only way to clear the build failure.

### Static Export with generateStaticParams

A static-export site needs a `generateStaticParams` enumerating every content URL from your CanopyCMS content, rather than a hand-rolled path-segment mapping. It is a **bound helper** on the `createNextCanopyContext` result, which the scaffolded `lib/canopy.ts` exports as `contentStaticParams`: wire it once there and call it from each page. Because it is bound to the build context internally, page modules never import the admin `getCanopyForBuild`.

```typescript
// app/[...slug]/page.tsx -- catch-all: emits { slug: segments[] } per entry
export const generateStaticParams = () => contentStaticParams()

// app/posts/[slug]/page.tsx -- one collection, single segment
export const generateStaticParams = () =>
  contentStaticParams({ rootPath: 'content/posts', shape: 'single' })

// app/docs/[[...slug]]/page.tsx -- catch-all nested under a URL prefix
export const generateStaticParams = () =>
  contentStaticParams({ rootPath: 'content/docs', basePath: '/docs' })
```

**Options:**

- `shape` (`'catch-all' | 'single'`, default `'catch-all'`) — emit the URL `segments` array, or the entry `slug`
- `paramName` (`string`, default `'slug'`) — route param name, matching your `[...name]` / `[name]` folder
- `rootPath` (`string`, default the content root) — scope to a subtree, e.g. `'content/posts'`
- `basePath` (`string`) — a nested catch-all's route base; see the warning below
- `filter` (`(entry) => boolean`) — exclude entries, e.g. `(e) => e.segments.length > 0`

`basePath` scopes entries to that URL prefix and makes `segments` relative to it, so a nested catch-all does not generate doubled paths like `/docs/docs/...`.

> **This `basePath` is a route prefix inside your app, not Next's deployment `basePath`.** It _filters_ entries to those whose URL starts with it, so passing a deployment prefix here matches no content and emits zero static params — a green build that ships an empty site. If you deploy under a Next `basePath`, set it in `next.config` and in your Canopy config and leave this alone. See [Deploying under a `basePath`](#deploying-under-a-basepath).
>
> A root index (`/`) produces empty `segments` — keep it only for an optional catch-all `[[...slug]]`, otherwise exclude it with `filter`.
>
> **Advanced (framework-agnostic):** to call the enumeration with a build context you already hold, the free helper `collectStaticParams(buildCtx, options)` from `canopycms-next` takes it directly.
>
> **Two content problems fail a production `next build`, both because silently dropping a page out of the build is worse than a red build.** A **schema-invalid entry**: `contentStaticParams` checks every entry against its schema and throws, listing each offending path — usually an abandoned create-scaffold, the empty draft the editor's "+" button writes before you fill it in, so finish or delete it and rebuild. And a **file CanopyCMS cannot parse into an entry**: a `.md`/`.mdx`/`.json`/`.yaml` file inside a collection directory not matching `{type}.{slug}.{id}.{ext}`, most often a schema rename that left a stale file behind, or an entry type declared in one collection but not another. Both are skipped outside a production build, since in-progress scaffolds and renames legitimately exist under `next dev`; and both guards also run during sitemap generation, so an app with no `generateStaticParams` at all still gets them.

### Sitemap and SEO Metadata

These ship together because of the `noindex` flag: it has to suppress a page in **both** surfaces — `robots: { index: false }` on the page and absence from the sitemap. Both read it through the same core predicate, so they cannot disagree about which pages are advertised.

#### The recommended SEO field group

`defineSeoFieldGroup()` adds the seven fields the metadata helpers read by default — `metaTitle`, `metaDescription`, `ogImage`, `ogType`, `canonical`, `noindex`, `twitterCard` — all optional, and stored **flat** in the content file:

```typescript
// app/schemas.ts
export const postSchema = defineEntrySchema([
  { name: 'title', type: 'string' },
  defineSeoFieldGroup(),
])
// TypeFromEntrySchema: { title: string; metaTitle?: string; metaDescription?: string; ... }
```

For the nested convention, pass `defineSeoFieldGroup({ group: 'seo' })` — and **set it once, not per call**, by passing `seo: { group: 'seo' }` to `createNextCanopyContext`. `generateContentSitemap`'s `noindex` exclusion and `entryToMetadata`'s field extraction must agree on where the SEO fields live, or a page can end up `noindex` while the sitemap still advertises its URL (or the reverse) because one call site forgot the override the other one has. Both bound helpers pick the shared value up, and a per-call `seo`/`group`/`fields` still overrides it for that call.

#### `sitemap.ts`

`generateContentSitemap` is a bound helper on the `createNextCanopyContext` result, like `contentStaticParams`; export it from `lib/canopy.ts` as `contentSitemap`.

```typescript
// app/sitemap.ts
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

**Every routable entry type is included by default.** There is no list of sitemap-able entry types to keep in sync — omitting a URL takes an explicit `exclude` predicate or a `noindex` flag on the entry. A sitemap built from a remembered list silently omits whichever type nobody added, ships green, and takes those pages out of search results with no warning.

**The mirror failure: a type with no route.** "Every entry type by default" holds only if every entry type actually has a page serving its `urlPath` shape. An entry type that exists for embedding elsewhere — content addressed by a `reference` field inside a block, never visited directly — is schema-routable but has no route, so leaving it unexcluded advertises a URL that 404s. Ask whether some route actually serves that `urlPath` shape, not whether the schema allows it, and exclude any entry type without one.

**Options:**

- `siteUrl` (`string`, required) — site origin; **throws** if not an absolute URL
- `trailingSlash` (`boolean`, default `false`) — emit `/contact/` rather than `/contact`
- `rootPath` (`string`, default the content root) — scope to a subtree, e.g. `'content/posts'`
- `exclude` (`(entry) => boolean`) — drop entries, on top of the non-optional `noindex` exclusion
- `lastModified` (`(entry) => Date | string | undefined`, default `updatedAt`) — `<lastmod>` per entry; `undefined` omits it
- `priority` (`(entry) => number | undefined`) — `<priority>` per entry
- `pathFor` (`(entry) => string | null`) — advertise an entry at a different URL
- `extraUrls` (`SitemapExtraUrl[]`) — URLs with no entry behind them (hand-written routes, feeds)
- `seo` (`{ fields?, group? }`, default flat) — where the SEO fields live, when not the defaults

A sitemap must carry absolute URLs, which is why `siteUrl` is enforced. **Set `trailingSlash` to match your `next.config`** — CanopyCMS cannot read that file.

> **`lastModified` is filesystem mtime by default.** `updatedAt` is the entry file's mtime, not an editorial timestamp — a fresh CI clone resets it to checkout time, so on a clean build agent the default dates every URL to when the tree was cloned. Supply a real content date via the callback, or return `undefined` to omit `<lastmod>` rather than assert a date you cannot stand behind.
>
> `changeFrequency` is not emitted for entries: a blanket value asserted for every URL carries no information, and search engines say they ignore it. Set it per-URL via `extraUrls` if you want it. **`robots.txt` is out of scope** too — write `app/robots.ts` yourself and point its `sitemap` field at this route.
>
> **Colliding URLs are deduped, not silently doubled.** Two entries resolving to the same `<loc>` is not fatal to a crawler but almost always means two are unintentionally sharing one URL, so `generateContentSitemap` keeps the first, drops the rest, and warns. In a **production build** the entry-vs-entry case no longer gets this far, since enumeration fails the build first (see [One URL, one entry](#one-url-one-entry)), so the dedupe covers what that guard cannot see: an `extraUrls` collision, one created by `pathFor` (which rewrites URLs after the guard ran), and any call outside a production build.

**When the URL you serve is not the entry's `urlPath`**, three answers in the order to try them:

1. **Re-model the entry, which needs no option at all.** An entry whose slug is `index` collapses onto its collection's path, and at the content root that path is `/`, so a home page stored as `content/home.index.<id>.json` has `urlPath: '/'` already — nothing to reconcile, and nothing to keep in sync later.
2. **`pathFor`, when re-modelling is not available** — a URL fixed by published history, or a route prefix that deliberately differs from your content layout: `pathFor: (entry) => entry.entryType === 'article' ? entry.urlPath.replace(/^\/articles\//, '/blog/') : null`. Returning `null`/`undefined` means **"keep this entry's own URL", not "drop it"**, so that reroutes articles and leaves everything else alone; dropping an entry is `exclude`'s job. Because the entry never leaves the walk it keeps the `noindex` gate, the `updatedAt` `lastModified` default and its `priority`. And it changes what is **advertised**, not what is **built** — `generateContentStaticParams` still enumerates the entry at its structural path, so the URL you return must be one your app actually routes.
3. **`extraUrls`, only for URLs with no entry behind them** — a feed, a hand-written route. An extra URL inherits neither the `noindex` gate nor the `lastModified` default, because there is no entry to read either from; using it to re-advertise a real entry means re-deriving both by hand and keeping them in sync forever.

#### `generateMetadata`

```typescript
// app/posts/[slug]/page.tsx
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

It returns `title`, `description`, `openGraph`, `twitter`, `alternates.canonical` and `robots`. Notes: **empty CMS fields count as unset**, since CanopyCMS writes optional fields present-but-empty (an untouched SEO group is `metaTitle: ''` on disk), so it falls back to `fallbackTitle` rather than emitting a blank title; **an absolute `canonical` passes through verbatim**, which is how an entry points at a copy of itself hosted elsewhere, while only site-relative canonicals get the origin and trailing-slash treatment; **`noindex: true`** emits `robots: { index: false, follow: false }` _and_ drops the entry from the sitemap, but does **not** stop the page being built, so the URL still resolves for anyone holding the link; and `titleTemplate` from your root layout gives the `%s | Site` pattern.

> **Advanced (framework-agnostic):** the free `generateContentSitemap(buildCtx, options)` and `entryToMetadata(data, options)` are exported from `canopycms-next` directly, and the neutral core — `collectRoutableEntries`, `extractSeoFields`, `isNoindexEntry` — from `canopycms/server`, for non-Next frameworks.

### Reading Content at Build Time

Ordinary page work needs no build-specific context. The recommended page surface is the phase-selecting `readByUrlPath`/`read` helpers for content, and the bound `contentStaticParams` for paths (see [Static Export with generateStaticParams](#static-export-with-generatestaticparams)). Both are exported from your scaffolded `lib/canopy.ts`, so page modules never import an admin context.

```typescript
// app/posts/[slug]/page.tsx
import { contentStaticParams, read } from '../../lib/canopy'

export const generateStaticParams = () =>
  contentStaticParams({ rootPath: 'content/posts', shape: 'single' })

export default async function PostPage({ params }) {
  // Working tree at build, ACL-enforced runtime at request time
  const { data } = await read({ entryPath: 'content/posts', slug: params.slug })
  return <PostView post={data} />
}
```

> At request time (a slug outside `generateStaticParams`, or any non-static render) the phase-selecting `read()` still throws on missing or forbidden content, with the same consequence as the plain `read()` above.

#### Advanced: `getCanopyForBuild()`

`getCanopyForBuild()` is an **advanced escape hatch** returning a context not tied to request headers. Reach for it only when the phase-selecting helpers are not enough — a standalone build script, or scanning the whole content set with `listEntries`/`buildContentTree` outside a page. It also exposes a build-safe `readByUrlPath()` returning `null` for non-entry paths (`/favicon.ico`, `/robots.txt`) instead of throwing, so one `[...slug]` page can resolve real entries and cleanly `notFound()` everything else.

- `read()` / `readByUrlPath()` from `lib/canopy.ts` — phase-selecting (admin at build, current user at request), no request scope needed; for page modules rendering in both phases
- `contentStaticParams()` — build-only enumeration; for `generateStaticParams`
- `getCanopy()` — current user, request scope required; for server components and route handlers
- `getCanopyForBuild()` — full admin, bypassing all auth and permissions; for build scripts and whole-collection scans

> **Security note:** `getCanopyForBuild()` runs as a synthetic admin with unrestricted read access, bypassing all branch and path ACLs. Use it only in build-time code paths not exposed to end users at request time. On a **production `server` deployment** (`mode: 'prod'` **and** `deployedAs: 'server'`), its operations **throw if invoked at request time** — a guard rail so the ACL-bypassing reader cannot accidentally serve live requests. The guard intentionally does **not** fire in dev: Next legitimately invokes `generateStaticParams`/`generateMetadata` through the build context during `next dev`, with the same not-build-phase signature as misuse, so a dev guard would false-positive on idiomatic code. Use `getCanopy()`, or the phase-selecting helpers, for request-time reads.

### Phase-Selecting `readByUrlPath` / `read`

The phase-selecting `readByUrlPath` and `read` are the top-level helpers `createNextCanopyContext` returns: the admin build context during static generation (reading the working tree) and the branch-aware, ACL-enforced runtime context at request time (a branch-clone preview in dev). Export them from `lib/canopy.ts` (see [Connecting the Schema Registry](#connecting-the-schema-registry)) and call them as in [Load Content by URL Path](#load-content-by-url-path).

### Advanced: Using createContentReader Directly

For more control — reading as a specific user, or in a non-request context — use the lower-level `createContentReader` from `canopycms/server`, which takes the user explicitly:

```typescript
const reader = createContentReader({ config: config.server })

const { data } = await reader.read({
  entryPath: 'content/posts',
  slug: 'my-post',
  branch: 'main',
  user: ANONYMOUS_USER, // explicit user required
})
```

### Sanitizing URLs from CMS Content

A URL from CMS-managed content is untrusted and may carry a dangerous scheme like `javascript:` or `data:`. `sanitizeHref` parses an untrusted URL — absolute (`https://example.com`) or relative (`/about`, `#section`) — allows only `http:` and `https:`, and returns a safe fallback (`#` by default, or a second argument) for anything else. **Use it anywhere you render an `href` from CMS content**: call-to-action links, navigation URLs, author website fields. It constructs a fresh string from the parsed URL rather than passing the input through, which also satisfies static analysis tools such as CodeQL taint tracking.

```tsx
import { sanitizeHref } from 'canopycms'
;<a href={sanitizeHref(entry.data.link)}>{entry.data.linkText}</a>
```

| Input                                        | Output                             |
| -------------------------------------------- | ---------------------------------- |
| `"https://example.com/page"`                 | unchanged                          |
| `"/about"`                                   | `"/about"` (root-relative)         |
| `"docs/guide"`                               | `"/docs/guide"` (relative)         |
| `"#section"`                                 | `"#section"` (same-page)           |
| `"//evil.com/x"` or `"\\evil.com/x"`         | `"#"` (protocol-relative, blocked) |
| `"not a url"`                                | `"/not%20a%20url"` (relative)      |
| `"javascript:..."` or `"data:text/html,..."` | `"#"` (blocked scheme)             |
| `"http://"` or `""`                          | `"#"` (invalid URL)                |

Any input **without a scheme** is treated as a site-relative path, so a string that is not a URL at all comes back as an escaped relative link rather than the fallback. That is the safe direction, since it can only ever point at your own origin, but it means `sanitizeHref` is not a validity check: validate the value yourself to reject junk.

### Error Handling Utilities

The typed error helpers CanopyCMS uses internally are available from `canopycms/utils/error`: `getErrorMessage(err)` extracts a string message from an `unknown` caught value without an `any`, `isNodeError(err)` narrows to `NodeJS.ErrnoException` (giving you `.code`, `.path`), and `isNotFoundError`/`isPermissionError`/`isFileExistsError` classify common **filesystem** failures (`ENOENT`, `EACCES`/`EPERM`, `EEXIST`) — useful when your own code does filesystem work, e.g. reading colocated files via `meta.physicalPath`.

CMS reads do **not** throw Node filesystem errors, so those helpers will not match them. `read()` throws a `ContentStoreError` whose `code` is one of `'NOT_FOUND' | 'NO_SCHEMA_ITEM' | 'FORBIDDEN' | 'VALIDATION'`:

```typescript
import { notFound } from 'next/navigation'

try {
  const { data } = await canopy.read({ entryPath: 'content/posts', slug })
  return <PostView post={data} />
} catch (err) {
  const code = err instanceof Error && 'code' in err ? err.code : undefined
  if (code === 'NOT_FOUND' || code === 'NO_SCHEMA_ITEM') return notFound()
  if (code === 'FORBIDDEN') return notFound() // notFound() avoids leaking that the entry exists
  throw err
}
```

For URL-driven pages, [`readByUrlPath()`](#load-content-by-url-path) is usually simpler: it already resolves `NOT_FOUND`/`FORBIDDEN` to `null`, so `if (!result) return notFound()` needs no try/catch.

### Media Configuration

CanopyCMS stores uploaded images and PDFs in a content-addressed asset store and serves images through an on-demand transform layer — see [ARCHITECTURE.md](ARCHITECTURE.md#asset--media-system) for how those work. Configure it with `media`:

```typescript
media: {
  adapter: 's3',
  bucket: 'my-site-assets',
  region: 'us-east-1',
  publicBaseUrl: 'https://assets.example.com',   // optional
  uploadUrl: process.env.CANOPY_UPLOAD_URL,      // optional
  maxUploadBytes: 52_428_800,                    // optional, default 50 MiB
}
```

`publicBaseUrl` is the base URL of the origin serving `/assets` **for the editor's own image previews** — set it when the editor cannot reach assets at its own root (a dedicated asset host, or an editor on a different origin than the site). An absolute URL or a site-relative path; omit for same-origin. It is editor display only and is never stored in content; "Where `/assets` is mounted" below is the public site's side of the same question. `uploadUrl` is where the browser POSTs a presigned upload, defaulting to the S3 REST endpoint — see "Routing uploads through your own CDN" below.

For local development, omit `media` entirely (uploads go to `.canopy-dev/assets/` via the built-in local adapter), point it at `{ adapter: 'local', directory: '.canopy-dev/assets' }`, or use your real bucket to test the S3 path.

Editors add images through the Media Library (a right-hand drawer from the editor's Settings menu), an `image` field, or the MDX "Insert Image" dialog. Uploads go **straight from the browser to S3** via a presigned POST — the bytes never pass through your API route — and on completion the server sniffs the real file type, **strips EXIF metadata including GPS, sanitizes SVGs**, hashes the bytes and records the asset. Images are served from `/assets/t/{directives}/…` URLs that transform on first request and cache immutably at the CDN; SVGs and PDFs are served statically. Build responsive markup with the exported helpers:

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

**`image` fields** hold a structured value — `{ src, alt, width, height, crop? }` — so alt text is enforced, intrinsic dimensions prevent layout shift, and crops are stored as a directive rather than a derived file. Declare an `aspect` on the field (`'16:9'`, `'1:1'`) to enable the interactive crop step, and `altOptional: true` for decorative images.

**Permissions** — any authenticated editor can upload and list assets. Deleting one from the library requires being an admin **or** the uploader, and removes only the library record; existing content references keep resolving.

> **The asset store is site-wide, not branch-scoped.** Because assets are content-addressed and shared (which is what lets a branch merge avoid moving files), branch and path ACLs do **not** apply to them: any authenticated editor can list and fetch every asset in the site, including images uploaded on branches they cannot otherwise access. Asset URLs are unguessable, but the library listing is open to every signed-in user, so treat "uploaded to CanopyCMS" as visible to your whole editorial team — confidential material does not belong in the asset store.

**Infrastructure** — `canopycms-cdk` ships an `AssetSupport` construct that provisions the bucket (or attaches to an existing one) and the transform Lambda. Pass it to `CanopyCmsDistribution`'s `assetSupport` prop and it attaches both CloudFront read behaviors (`/assets/*` and `/assets/t/*`) in the only safe order, since CloudFront matches path patterns in the order given and a more specific pattern listed after a more general one is never reached. For a distribution built outside `CanopyCmsDistribution`, `assetBehaviors()` and `attachTo(distribution)` remain available, and a hand-wired `additionalBehaviors` that gets the order wrong fails `cdk synth` with an actionable error instead of deploying broken. `uploadBehavior()` is the opt-in write path and belongs on its own distribution, below. See [docs/deploying-to-aws.md](docs/deploying-to-aws.md).

**Routing uploads through your own CDN**

By default the browser POSTs a presigned upload straight at the S3 REST endpoint, which is cross-origin from your editor and so needs a **CORS rule on the bucket** — and a CORS rule must name an exact origin and applies bucket-wide, since S3 CORS has no prefix scoping, which is awkward for a bucket shared across environments.

`media.uploadUrl` replaces the POST target, so the upload can go through a CloudFront distribution you control; same-origin with the editor (`uploadUrl: '/asset-upload/'`) needs no bucket CORS rule at all. The signature is unaffected — a presigned POST's string-to-sign is the base64 policy alone, so the host never enters it. Accepted values are an absolute `http(s)` URL or a site-relative path, the latter same-origin by construction, and the value is used **verbatim**, with nothing joined onto it and the trailing slash not normalized, because only you know whether your CDN behaviour is `/asset-upload/*` or a literal path. It is per-deployment: a site-relative value works only where that path actually routes to the bucket, so under `next dev` with `adapter: 's3'` it 404s — drive it from an environment variable.

**If you deploy with `canopycms-cdk`, it builds the behaviour for you.** Give the route its own distribution — one route, nothing else on it — from either `AssetSupport`'s `uploadBehavior` prop, or `assetUploadBehavior(this, { bucket: assetBucket })` when you have a bucket and no other use for an `AssetSupport` in that stack:

```typescript
const assets = new AssetSupport(this, 'Assets', { uploadBehavior: {} })

const uploads = new cloudfront.Distribution(this, 'AssetUploads', {
  defaultBehavior: assets.uploadBehavior(),
})
// media.uploadUrl = `https://${uploads.distributionDomainName}/`
```

Both entry points build the route through one shared internal function, so they cannot drift; the difference is what else gets built, since `AssetSupport`'s constructor always creates the transform Lambda, its log group, Function URL and execution role. Either way, no custom domain or certificate is needed and no bucket CORS rule is written: the edge supplies `Access-Control-Allow-Origin` for this route alone and answers the CORS preflight itself. `allowedOrigins` narrows the wildcard default, matching origins exactly, so a `*.subdomain` pattern is refused at synth rather than passing the policy and failing the preflight. `editorOrigins` — which exists only to write that bucket rule — becomes optional, though standalone mode refuses to synth with neither.

Wiring the route by hand instead, five things are easy to get wrong:

- **Answer the CORS preflight yourself** — the one most likely to be missed, and it stops the upload dead. The editor's POST registers an `xhr.upload` progress listener, which disqualifies it from being a CORS simple request, so the browser sends `OPTIONS` first; neither CloudFront nor a CORS-less S3 bucket answers that, and a non-2xx preflight fails the check whatever headers are on it. Answer `OPTIONS` at the edge with a viewer-request function returning 204 plus the CORS headers, or keep a bucket CORS rule. A `curl` POST appears to work throughout, since only a browser preflights.
- **Rewrite the URI to `/`** on viewer request. S3's POST Object is valid only at the bucket root, so without it you get `405 MethodNotAllowed` — and it is also what keeps "allow all methods" safe, since no request can then address a key.
- **Allow all methods, and point at an origin with OAC signing OFF.** CloudFront signs origin requests but never hashes the body, so an OAC-signed origin rejects every multipart POST with `400 InvalidArgument` naming `x-amz-content-sha256`. OAC is a property of the origin rather than the behaviour, so the bucket needs its own origin entry.
- **Forward no cookies.** A same-origin upload path receives your site's cookies, the editor session cookie included, which would otherwise reach S3 and its access logs. Behind HTTP basic auth, strip `Authorization` too — forwarded to S3 it produces `400 InvalidArgument — Unsupported Authorization Type`.
- **Watch `CustomErrorResponses`.** They are distribution-wide, so a site mapping 403 to its own 404 page applies that to S3's upload errors too and the editor reports the substituted status. A distribution dedicated to the upload route avoids this along with the cookie and `Authorization` hazards — on a different host they are never sent.

Despite being widely assumed, a bucket CORS rule is _not_ what permits the upload: measured, S3 **accepts** a cross-origin presigned POST with no CORS configuration and simply declines to advertise it. Acceptance and advertisement are independent, which is what lets the edge supply the header instead — and it means the failure mode here is a file that _is_ in staging while the browser reports a network error. Note too that CanopyCMS cannot verify the host you configure actually fronts your bucket: a wrong `uploadUrl` sends a valid presigned credential and the user's file to an unintended endpoint, quietly. The blast radius is bounded — the POST policy pins the bucket, key, content type, a size range and a 15-minute expiry — but treat it as deployment configuration rather than something derived at runtime.

**Where `/assets` is mounted**

Stored asset URLs are always root-relative (`/assets/…`), deliberately: the stored value is what moves between branches and environments, so it names the asset's position in the `/assets` URL space and nothing else. When your renderer sees that space somewhere other than the root, supply the mount point at render time with `baseUrl` — `assetUrl(image, { width: 960, baseUrl: ASSET_BASE })`, `assetSrcSet(image, [480, 960], { baseUrl: ASSET_BASE })`:

- Site served at the root, the usual case — omit `baseUrl`
- Site under a Next.js `basePath`, with Next serving `/assets` — your `basePath`, e.g. `'/preview-123'`
- Assets on CloudFront via `canopycms-cdk`'s `AssetSupport` — omit it; a `basePath` does not move them
- Assets on a separate host or CDN origin — that origin, e.g. `'https://assets.example.com'`

`baseUrl` is the **one** prefix concept for asset URLs, and the two non-empty shapes are alternatives rather than things you compose: a cross-origin asset host serves at its own root and does not also live under your site's `basePath`. It is a per-render option rather than a config key precisely because the editor and the public site can legitimately have different answers — which is what `media.publicBaseUrl` is, the editor's answer. The prefix is applied at render time only and is **never** written into content.

### Deploying under a `basePath`

Next.js auto-prefixes only its own `Image`, `Link`, `Script` and router navigations. Any raw string URL — including an `<img src>` built from `assetUrl()` — is left alone and resolves at the origin root, so it 404s. Deploying CanopyCMS under a `basePath` (commonly, preview builds namespaced per branch) needs three things:

1. **Tell CanopyCMS.** It cannot read your `next.config`, so state the same value in your Canopy config as `basePath` (`basePath: process.env.NEXT_PUBLIC_BASE_PATH` in both files); the editor uses it for its API route and the preview pane.
2. **Decide whether your asset space moved.** Use the table above: it moves when Next serves `/assets` (the local adapter, `next dev`, or S3 with no distribution), because the rewrite Next auto-prefixes is `withCanopy`'s own. It does **not** move on a CloudFront deployment, where the asset behaviors are anchored at the distribution root. Do not derive `baseUrl` from `next.config`'s `basePath` unconditionally — on the AWS topology that breaks working URLs.
3. **Do not pass your `basePath` to `contentStaticParams`.** That helper's own `basePath` is an unrelated thing — the route prefix of a _nested catch-all_ — and it **filters** entries by that prefix, so passing a deployment `basePath` matches no content, emits zero static params, and still builds green: an empty site with no error.

> Serving `/assets` un-prefixed under a `basePath` by adding a `basePath: false` rewrite does not work — Next rejects a `basePath: false` rewrite whose destination is not an absolute `http(s)://` URL, and `withCanopy`'s asset rewrite points at an internal route. Prefix the URLs instead.

Markdown and MDX body content is a separate case: images inserted into a body are stored as raw srcs and rendered by your own markdown renderer, which never calls `assetUrl()`. Under a `basePath`, give your renderer an `img` override so body images get the same treatment as `image` fields — for `react-markdown`, `components={{ img: ({ src, ...rest }) => <img src={assetUrl({ src: String(src ?? '') }, { baseUrl: ASSET_BASE })} {...rest} /> }}`. `assetUrl()` hands back anything a mount point cannot apply to — an off-site src (`https://…`, `//…`) or a `data:` URI — byte-identical, so the override is safe on every image in a body. Two things it does change, both deliberate: a value a browser would read as pointing off-origin despite looking site-relative (`/\evil.com/x`) is neutralized rather than emitted, and a **page-relative** src (`images/x.png`) is rooted onto `ASSET_BASE` like any other path, so make page-relative body srcs root-relative before adopting this.

### Editor Customization

```typescript
editor: {
  title: 'My CMS',
  subtitle: 'Content Editor',
  theme: {
    colors: { brand: '#4f46e5', accent: '#0ea5e9', neutral: '#0f172a' },
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
        value={typeof value === 'number' ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  ),
}

export default NextCanopyEditorPage(config.client(), customRenderers)
```

Each renderer receives `CustomFieldRenderProps`:

- `field` — the full `FieldConfig`, so one renderer can vary on `label`, `required`, `options`
- `value` — current value, typed `unknown`; narrow it yourself
- `onChange` — call with the new value to update the draft
- `path` — canonical path to this field, e.g. `['blocks', 0, 'title']`
- `id` — the id the default control would have used; attach it to your input

Renderers apply **by field type, everywhere** — top-level fields, fields inside `object` and `block` templates, and each item of a `list: true` field. There is no per-field override; scope with `field.name` inside the renderer if you need one. `customRenderers` is also accepted directly by `<CanopyEditor>` and `<Editor>` if you compose the editor yourself instead of using the page factory.

**The value you pass to `onChange` must still satisfy the field's declared type.** CanopyCMS validates entries at the server write boundary with the same rules regardless of what rendered the input, so a renderer storing a string into a `type: 'number'` field produces a `422` on save rather than a bad file. Custom rendering changes the control, not the schema contract.

## Content Tree Builder

`buildContentTree()` walks your schema and filesystem to produce a typed tree of all your content, for navigation sidebars, sitemaps, search indexes and breadcrumbs.

### Basic Usage

```typescript
// app/layout.tsx (or any server component)
const tree = await (await getCanopy()).buildContentTree()
// tree is ContentTreeNode[] -- a hierarchy of collections and entries
```

Each node carries `path` (URL path, lowercased by default), `logicalPath` (the CMS logical path), `kind` (`"collection"` or `"entry"`), `collection` or `entry` metadata for that kind, `fields` from your `extract` callback, and `children` (entries plus subcollections, in collection order).

### Extracting Custom Fields

`extract` pulls typed fields off each node's raw data — frontmatter for md/mdx, parsed JSON for json entries:

```typescript
interface NavItem {
  title: string
  draft: boolean
  order: number
}

const tree = await canopy.buildContentTree<NavItem>({
  extract: (data) => ({
    title: (data.title as string) ?? '',
    draft: data.draft === true,
    order: (data.order as number) ?? 0,
  }),
})
// tree nodes now have typed `fields: NavItem`
```

Its second `meta` argument gives structural context: `meta.kind`, `meta.logicalPath`, `meta.entryType` and `meta.format` (on entries), and `meta.indexEntry` — present when `kind === "collection"` and the directory holds an entry with `slug === "index"`, carrying that entry's `entryType`, `format` and raw `data`. That is the collection's identity under the **directory-as-page pattern** (a partner's metadata for `/data-catalog/<partner>/`, a section landing for `/docs/<section>/`). Narrow on `meta.indexEntry.entryType` before reading type-specific fields:

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

`meta.indexEntry` is undefined for collections at the `maxDepth` cap, where entries are not loaded.

#### Typed `meta.indexEntry.data` via Entry-Type Registry

`buildContentTree<T, TEntryTypes>` accepts an optional second generic — a map from entry-type names to their data shapes. With it, narrowing on `meta.indexEntry.entryType` types `meta.indexEntry.data` as the matching shape (a discriminated union), so `as` casts and `unknown` checks go away; without it the default is a loose `Record<string, unknown>`-style shape, so existing callers are unaffected. Derive the map from the schemas you already have — `EntryTypesFromRegistry<typeof entrySchemaRegistry>` when the registry is keyed by entry-type name (see [Schema Registry and References](#schema-registry-and-references)), or a hand-written interface of `TypeFromEntrySchema<typeof xSchema>` members otherwise. The exported `EntryTypeMap` alias documents the expected shape (`Record<string, object>`); any matching interface works.

```typescript
const tree = await canopy.buildContentTree<NavFields, EntryTypes>({
  extract: (data, meta) => {
    if (meta.kind === 'collection' && meta.indexEntry?.entryType === 'partner') {
      // meta.indexEntry.data is typed as the partner shape -- no casting
      return { isFictional: Boolean(meta.indexEntry.data.isFictional) }
    }
    return { isFictional: false }
  },
})
```

### Filtering Nodes

`filter` runs after `extract`, so it can use extracted fields. Returning `false` excludes a node **and all its descendants**:

```typescript
const tree = await canopy.buildContentTree<NavItem>({
  extract: (data) => ({ title: (data.title as string) ?? '', draft: data.draft === true }),
  filter: (node) => node.fields?.draft !== true,
  sort: (a, b) => (a.fields?.order ?? 0) - (b.fields?.order ?? 0),
})
```

### Custom Sorting

By default children at each level are sorted by the collection's `order` array first, then alphabetically. `sort`, as above, replaces that entirely with your comparator; it runs after `extract` and `filter`, so `fields` is available on every node.

### Options Reference

- `rootPath` (`string`, default the content root) — starting collection path, e.g. `"content/docs"`
- `extract` (`(data, meta: ContentTreeExtractMeta) => T`) — extract typed custom fields from raw data
- `filter` (`(node: ContentTreeNode<T>) => boolean`) — return false to exclude a node and its descendants
- `buildPath` (`(logicalPath, kind) => string`) — custom URL path builder; the default strips the content root, lowercases, and collapses index entries
- `sort` (`(a, b) => number`, default order array then alphabetical) — custom sort for children at each level
- `maxDepth` (`number`, default unlimited) — maximum depth to traverse

### Imports

`ContentTreeNode` and `BuildContentTreeOptions` come from `canopycms`, for typing your own components. Call the builder through the context (`(await getCanopy()).buildContentTree(options)`); the raw `buildContentTree` from `canopycms/server` is advanced and needs `branchRoot`, `flatSchema` and `contentRootName` supplied by hand.

## Listing Entries

`listEntries()` returns a flat array of every content entry in your site, for search indexing, sitemaps, and anything else iterating over all content without the tree hierarchy. (For `generateStaticParams`, prefer the bound `contentStaticParams`, which hands your page module no admin context.)

> **`listEntries()` does not resolve `reference` fields unless you ask it to.** By default it reads content files raw off disk for speed across a whole-site scan, so a `reference` field — top-level or inside a block template (see [Shared / Referenced Blocks](#shared--referenced-blocks)) — comes back as a bare id string, or `null`. Pass `{ resolveReferences: true }` and it resolves them exactly as `read()`/`readByUrlPath()` do, at any nesting depth. Build a search index over content that leans on referenced or shared blocks with the option **on**, or that content is silently missing from your index; leave it **off** for sitemaps and `generateStaticParams`, which need only paths and timestamps. See [Resolving References in a Listing](#resolving-references-in-a-listing).
>
> **An unparseable content file fails a production build**, rather than being silently dropped from the result — see [Static Export with generateStaticParams](#static-export-with-generatestaticparams). Outside a production build it is skipped, logged only with `CANOPYCMS_DEBUG=true`.

### Basic Usage

`listEntries()` is on both the request-scoped context (`getCanopy()`) and the advanced build context (`getCanopyForBuild()`); use the latter for build scripts and whole-collection scans outside a request.

```typescript
const entries = await (await getCanopyForBuild()).listEntries()

// urlPath has index collapsing applied -- preferred for URL generation
const slugs = entries.map((entry) => entry.urlPath.split('/').filter(Boolean))
```

Each entry's `urlPath` is URL-ready with index entries collapsed to their parent path (`'/guides'`, not `'/guides/index'`; `'/'` for a root index entry), and is round-trip safe with `readByUrlPath()`. The raw `pathSegments` array is also available for consumers needing the unmodified filesystem structure.

### Each Entry Includes

- `pathSegments` (`string[]`) — URL path segments, e.g. `['guides', 'ref']`
- `urlPath` (`string`) — URL-ready path, index entries collapsed
- `slug` (`string`) — entry slug within its collection
- `entryPath` (`string`) — full CMS logical path
- `entryId` (`string`) — 12-char Base58 content ID from the filename
- `collectionId` (`string?`) / `collectionPath` (`string`) — the parent collection's content ID and logical path
- `entryType` (`string`) and `format` (`json`, `md`, or `mdx`)
- `data` (`T`) — entry data; frontmatter plus body for md/mdx
- `updatedAt` (`string?`) — ISO 8601 timestamp, on every result

`updatedAt` is the file's filesystem mtime, not an editorial "last changed" date — treat it as "changed since the last build". For md/mdx entries, `data.body` holds the raw markdown.

### Extracting, Filtering, Sorting and Scoping

`extract` controls what ends up in `data`, which is useful for dropping large fields like the body when you only need metadata; `filter` and `sort` take the extracted items; and `rootPath` loads only entries under one collection path, skipping everything else:

```typescript
const entries = await canopy.listEntries<PostMeta>({
  rootPath: 'content/posts',
  extract: (raw) => ({
    title: (raw.title as string) ?? '',
    publishDate: (raw.publishDate as string) ?? '',
  }),
  filter: (entry) => entry.entryType === 'post',
  sort: (a, b) => b.data.publishDate.localeCompare(a.data.publishDate),
})
// entries[0].data.title is typed as string
```

### Resolving References in a Listing

By default a listing leaves a `reference` field as the bare id string (or `null`) — it reads content files straight off disk and never looks the target up. Pass `resolveReferences` and each becomes the referenced entry's data, exactly as `read()`/`readByUrlPath()` return it, at any nesting depth: top-level fields, inside `object` fields and inline `group`s, and inside block templates — which is what makes [shared/referenced blocks](#shared--referenced-blocks) usable from a listing at all.

```typescript
// A search index that must see the text inside shared blocks:
const entries = await canopy.listEntries({ resolveReferences: true })

// entries[0].data.snippet
//   off: 'a1b2c3d4e5f6'
//   on:  { id: 'a1b2c3d4e5f6', slug: 'signup', collection: 'content/snippets',
//          urlPath: '/snippets/signup', title: '...' }
```

`buildContentTree()` takes the same option (it also applies to the `indexEntry` handed to a collection's `extract`), and so does `collectRoutableEntries()`. `collectStaticPaths()` does not, because it discards entry data.

**Why it is off by default, when `read()` resolves automatically.** A resolved reference is a different shape, and a listing's `data` is your own type parameter — so nothing in the type system would flag the change if the default flipped. An `/authors/${data.author}` template would keep compiling and start emitting `/authors/[object Object]`. Deciding per call site keeps that where the code reading the field is.

**What it costs.** Resolution needs the content ID index, so an opted-in call adds one index scan plus one read per _distinct_ referenced entry, not per referencing entry: all resolution in one call shares a cache, so a block referenced from 40 pages is read once. With the option off, none of that machinery is built. The cache saves the read, not the copy — each referencing entry still gets its own copy of the resolved value.

**Every resolved reference carries a `urlPath`** — the referenced entry's URL, by the same rule `listEntries` uses for `item.urlPath` (an `index` entry collapses to its parent path). Both come from one shared function, so a link built from a resolved reference reaches the entry the listing enumerates, with no second pass to build an id → URL table. Alongside it, **`id`, `slug` and `collection` are reserved**: if the target models one of those as a real content field, the resolution value wins and the content field is not visible here.

**A target's body is opt-in, per field.** By default a resolved **md/mdx** target gives you its frontmatter, not its prose. Set `includeBody: true` on the reference field and the body arrives too, under that target entry type's own body field name — a no-op for json/yaml targets, whose whole document is already their data. The distinction is embed-vs-link, and it belongs on the field because it is a property of your content model rather than of any one call: a reference that **embeds** its target (a shared CTA rendered inline) wants the prose, while one that **links** to it (related posts, an author byline) wants `urlPath` and a title, not the target's whole body inlined into every page read. Turning it on makes the body part of every referencing entry's resolved value, so a long document embedded by many pages is copied once per page.

**Two caveats.** Path permissions are not applied to the resolved _targets_, matching `read()`, so a reference can resolve to an entry the current user could not open directly. (The entries being listed are still permission-filtered, and an entry filtered out is never resolved.) And within one call a given id is looked up once and every occurrence shares that answer, so a listing is internally consistent rather than deciding per entry.

### Options Reference

- `extract` (`(raw, meta) => T`) — transform raw data; controls what `data` contains
- `filter` (`(entry: ListEntriesItem<T>) => boolean`) — return false to exclude an entry
- `rootPath` (`string`, default the content root) — scope to a subtree, e.g. `"content/docs"`
- `sort` (`(a: ListEntriesItem<T>, b: ListEntriesItem<T>) => number`) — custom sort comparator
- `resolveReferences` (`boolean`, default `false`) — resolve `reference` fields to the referenced entry's data

### Imports

`ListEntriesItem` and `ListEntriesOptions` come from `canopycms`. Call the listing through the context (`(await getCanopy()).listEntries(options)`); the raw `listEntries` from `canopycms/server` is advanced and needs `branchRoot`, `flatSchema` and `contentRootName` supplied by hand.

## Features

### Branch-Based Editing Workflow

1. **Create or select a branch** — each editor works in isolation
2. **Make changes** — edits are saved to the branch workspace
3. **Submit for review** — creates a GitHub PR with all changes
4. **Review and merge** — the standard PR workflow on GitHub
5. **Auto-archive** — the CMS worker detects the merge on its next git-sync cycle (default every 5 minutes), archives the branch, and fast-forwards the base branch's content view, with no manual cleanup. A PR closed without merging leaves the branch "submitted" with a "PR closed" badge for an admin to follow up.
6. **Deploy** — your CI/CD rebuilds the site after the merge

The base branch itself (the PR target, usually `main`) is protected: it can never be submitted for review, and in production it is read-only in the editor until someone creates a branch off it. See [Submitting for Review](#submitting-for-review).

### Comments System

Comments enable asynchronous review at three levels: **field** comments on a specific form field, **entry** comments on a whole entry, and **branch** comments about the changeset. They are stored in `.canopy-meta/comments.json` per branch workspace and are **not** committed to git — they are review artifacts, excluded via git's `info/exclude`.

### Permission Model

Access control has three layers, and every content read and write must pass **both** layer 1 and layer 2:

1. **Branch access** — per-branch ACLs control who can reach each branch
2. **Path permissions** — glob patterns restrict who can edit specific content paths
3. **Reserved groups** — `admins` (full access) and `reviewers` (review branches, approve PRs)

Set the fallbacks with `defaultBranchAccess` and `defaultPathAccess`; the [Configuration Reference](#configuration-reference) states what each covers and which grants are exempt. Branch access precedence, highest first: the `admins` and `reviewers` groups; an explicit `managerOrAdminAllowed` lockdown; an explicit user/group ACL; then, only for a branch with no ACL at all, its creator, `defaultBranchAccess`, and the protected base branch. See [ARCHITECTURE.md](ARCHITECTURE.md#the-permission-model) for why the layers are separate.

> **Assets are outside this model.** Uploaded images and PDFs live in a content-addressed store that is site-wide rather than branch-scoped, so neither layer applies: any authenticated editor can list and fetch every asset in the site, including images uploaded on branches they cannot otherwise access. See [Media Configuration](#media-configuration) for the full statement.

**Bootstrap admin groups**: users whose IDs match `bootstrapAdminIds` automatically receive `admins` membership under `getCanopy()`, even before groups exist in the repository, which is what makes initial setup possible.

**Build mode bypass**: during `next build` all permission checks are bypassed so every page can be statically generated whatever the auth configuration. In page modules, drive `generateStaticParams` with the bound `contentStaticParams` and resolve content with the phase-selecting `read`/`readByUrlPath` to avoid request-scope errors without importing an admin context.

#### Public read on server deployments

`defaultPathAccess` defaults to `'deny'`, so an anonymous request on a `server` deployment gets no content at all. To let unauthenticated visitors read published content while edit and review stay locked down, scope the path default per level. You do **not** need to open branch access to do it: anonymous public pages resolve against the protected base branch, which always passes the branch layer.

```typescript
// canopycms.config.ts
export default defineCanopyConfig({
  // ...
  defaultBranchAccess: 'deny', // work branches stay private; the base branch is exempt
  defaultPathAccess: { read: 'allow' }, // edit/review still resolve to 'deny'
})
```

Weigh one thing before enabling it: **`{ read: 'allow' }` inverts deny-by-default for reads.** Any content path with **no matching rule** becomes publicly readable, and a rule targeting only `edit` does not restrict reading, since an unmatched `read` still falls through to the allow default. To keep a subtree private, add an explicit rule whose `read` target denies it — do not rely on the absence of a rule.

**Keep `defaultBranchAccess` at `'deny'` here.** It is not read-scoped: it is the fallback for _any_ branch with no ACL, so `'allow'` would also expose un-ACL'd **work** branches to every signed-in user. The base branch serving your public pages is exempt from it regardless, so `'allow'` buys you nothing on this path.

Pages rendering content at request time should use the null-safe `readByUrlPath` rather than the strict `read()`: a `FORBIDDEN` denial comes back as `null`, so your existing `if (!result) return notFound()` produces an ordinary 404 without revealing that the content exists but is restricted (the reason still goes to the debug log under `CANOPYCMS_DEBUG=true`). Reserve `read()`, which throws on both missing and forbidden content, for contexts where the content is known to exist and be readable.

### System Health

Admins get a "System health" panel for observing the CMS's operational state, riding the same Editor component and catch-all API route as everything else, so it needs no extra integration. See [System Health (Admins)](#system-health-admins) for what it shows.

### Live Preview

The editor shows a live preview of your actual site pages in an iframe. Changes update immediately via postMessage, and clicking an element in the preview focuses the corresponding form field.

**Security model.** Preview pages accept messages only when they are actually framed, and only from their direct parent window with a matching origin — same-origin by default, so a standalone page, including one opened via `window.open` from a hostile site, never accepts draft data. For a cross-origin editor deployment, pass `editorOrigin: 'https://editor.example.com'` to `useCanopyPreview`. We also recommend serving your site with `Cross-Origin-Opener-Policy: same-origin` where your hosting allows, since it severs `window.opener` handles entirely; the bridge is safe without it, but defense in depth is cheap.

**Reporting draft errors.** If your page compiles the draft body (MDX, say) and keeps the last good render on failure, the author sees a stale-but-fine preview while the draft is broken. Use `reportError` to tell the editor, which surfaces an alert next to the preview:

```typescript
const { data, reportError } = useCanopyPreview<DocContent>({ initialData })

useEffect(() => {
  compileMdx(data.body)
    .then(() => reportError(null)) // clears a previously reported error
    .catch((err) => reportError(`MDX failed to compile: ${err.message}`, 'body'))
}, [data.body, reportError])
```

Pair it with the [`validateEntry` hook](#save-time-validation-validateentry) to reject such saves server-side too.

## AI-Ready Content

CanopyCMS can serve your content as clean markdown for AI consumption (LLM tools, documentation chatbots): schema-driven JSON/MD/MDX entries converted into well-structured markdown with a discovery manifest, needing no authentication, since the output is read-only.

All content is included by default (an opt-out exclusion model); you can exclude collections, entry types, or entries matching a predicate. Fields convert from your schema automatically, and arrays of **flat records** — object-list fields whose subfields are all single-line scalars — render as a compact markdown **table**, while lists whose items contain nested objects, sub-lists or long-form text keep an expanded heading-per-item form. Table cells use default per-type rendering; to customize, add a `fieldTransforms` entry for the **list field itself**, which replaces the whole field's output.

### Option 1: Route Handler (Runtime)

Serve AI content dynamically from a Next.js catch-all route, generated on first request and cached (regenerated every request in dev mode). **`npx canopycms init` sets this up** unless you pass `--no-ai`, generating `{appDir}/ai/config.ts` and `{appDir}/ai/[...path]/route.ts`. To do it manually:

```typescript
// app/ai/[...path]/route.ts
import { createAIContentHandler } from 'canopycms/ai'
import config from '../../../canopycms.config'
import { entrySchemaRegistry } from '../../schemas'

export const GET = createAIContentHandler({ config: config.server, entrySchemaRegistry })
```

That serves `GET /ai/manifest.json` (the discovery manifest), `/ai/posts/my-post.md` (one entry), `/ai/posts/all.md` (a collection concatenated), and `/ai/bundles/my-bundle.md` (a filtered bundle).

### Option 2: Static Build (CLI)

```bash
npx canopycms generate-ai-content --output public/ai
```

Options: `--output <dir>` (default `public/ai`), `--config <path>` (an AI content config file), `--app-dir <path>` (where `schemas.ts` lives; default `app`). Like the static-params build check, this fails loudly — unconditionally, not just in a real production build — if any entry is schema-invalid, listing every offending entry.

### Option 3: Programmatic API

```typescript
import { generateAIContentFiles } from 'canopycms/build'

await generateAIContentFiles({
  config: config.server,
  entrySchemaRegistry,
  outputDir: 'public/ai',
})
```

### AI Content Configuration

`defineAIContentConfig` customizes what is generated and how fields convert. Pass the result as `aiConfig` to either `createAIContentHandler` or `generateAIContentFiles`.

```typescript
import { defineAIContentConfig } from 'canopycms/ai'

const aiConfig = defineAIContentConfig({
  // Opt-out exclusions
  exclude: {
    collections: ['drafts'],
    entryTypes: ['internal-note'],
    where: (entry) => entry.data.hidden === true,
  },

  // Custom bundles: filtered subsets as single files
  bundles: [{ name: 'research-guides', filter: { collections: ['docs'], entryTypes: ['guide'] } }],

  // Per-field markdown overrides, keyed by entry type then field name
  fieldTransforms: { dataset: { dataFields: (value) => renderTable(value) } },

  // Per-component MDX transforms, keyed by PascalCase component name. Return
  // undefined to keep the original JSX unchanged.
  componentTransforms: {
    Callout: (props, children) => `> **${props.type ?? 'Note'}:** ${children}`,
  },

  // Per-entry-type body transforms, for general markdown cleanup
  bodyTransforms: { guideline: (body) => body.replace(/\s*\|\|[^\n]+/g, '') },

  // Per-entry-type transforms appending markdown after the entry's body/fields.
  // Runs once per entry, may be async; return undefined to append nothing.
  entryTransforms: {
    dataset: async (entry, { contentId, readSibling }) => {
      const raw = await readSibling(`${contentId}.profile.json`)
      if (!raw) return
      return renderProfileSchema(entry.data, JSON.parse(raw)) // your own renderer
    },
  },
})
```

**Transform pipeline** for MD/MDX entries, in order: `stripMdxImports` removes import statements automatically; `componentTransforms` match JSX components by PascalCase name and replace them with the transform's output (keeping the JSX as-is when it returns `undefined`); then `bodyTransforms` passes the full body string through the entry-type-specific transform for final cleanup. `componentTransforms` are keyed by component name and apply across all entry types, since MDX components are project-wide; `bodyTransforms` are keyed by entry type, for stripping entry-type-specific syntax that does not belong in AI output.

**`entryTransforms`** append their markdown after the entry's body and fields, and that content flows automatically into the per-entry file, the collection `all.md`, and any bundle the entry belongs to. Unlike `bodyTransforms` they fire for **every** format, including data-only JSON/YAML entries. Reach for them when an entry should export its own Canopy content **plus** a colocated, machine-generated neighbour. Four things to know:

- **`contentId`** is the entry's stable Base58 ID, the same one embedded in its filename, and invariant when an editor renames the slug. Name sibling artifacts with it so they stay matched across slug changes.
- **`readSibling(name)`** reads a bare filename colocated in the entry's directory. It rejects slashes, `..` and absolute paths, and resolves `null` for a missing file; the entry's absolute path is never handed out, so it cannot leak into the published output.
- **The transform sees one entry, not the whole tree.** Cross-entry context must be built in your own config code.
- **Appended content is published** at `/ai/...`, so do not append secrets or PII a public reader should not see. And sibling files must exist where the exporter reads: the static build reads your repo checkout, the runtime route handler reads the branch clone, so commit sibling artifacts into your content tree if you rely on the handler.

### Manifest Format

`manifest.json` describes all generated content for tool discovery. Its first two fields are optional and controlled by the build environment: `buildId` from `CANOPY_BUILD_ID`, `generated` from `SOURCE_DATE_EPOCH`.

| Environment               | `generated`                     | `buildId`      |
| ------------------------- | ------------------------------- | -------------- |
| neither set (the default) | the time of the build           | absent         |
| `CANOPY_BUILD_ID`         | **absent**                      | the id you set |
| `SOURCE_DATE_EPOCH`       | pinned from that value          | absent         |
| both                      | pinned from `SOURCE_DATE_EPOCH` | the id you set |

Declaring a build id omits `generated` on purpose: if you build an artifact once and promote that same artifact later, its build clock describes the machine that produced it rather than the content, so anything reading it as "how fresh is this content?" is misled. Set `SOURCE_DATE_EPOCH` as well for a timestamp describing the _source_.

```json
{
  "buildId": "fd91b36c",
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
  "bundles": [{ "name": "research-guides", "file": "bundles/research-guides.md", "entryCount": 3 }]
}
```

## Using the Editor

How the CanopyCMS editor works from a content editor's perspective.

### Getting Started

Navigate to your editor URL (e.g. `/edit`), sign in, and select or create a branch to work on.

> In production the editor opens on the base branch by default. That branch is browsable but read-only — click "Create a branch" in the banner, or use the branch selector, to start editing. See [Submitting for Review](#submitting-for-review).

### Working with Branches

**Creating a branch:** click the branch selector in the header, then "New Branch", and enter a descriptive name (`update-homepage-hero`).

> Branch names are sanitized for use as git branch names and filesystem paths: any character other than letters, numbers, `.`, `_` and `-` is replaced with `-`, so `feature/hero-update` is created as `feature-hero-update`, and the editor displays and uses that sanitized name everywhere.
>
> Seven names are reserved because they collide with a static top-level API route: `admin`, `assets`, `branches`, `groups`, `permissions`, `users`, `whoami`. Creating one is rejected with a 400 explaining the collision. Matching is exact and case-sensitive, so `Admin` and `admin-docs` are unaffected.

**Switching branches:** click the branch selector and choose from the available branches. The base branch is marked with a "Protected" badge — it cannot be submitted for review, and in production it cannot be edited directly. The selector and Branches panel also show `syncing`, `sync-failed` and `conflict` badges alongside `Merged` and `PR closed`, so anyone can tell at a glance when a branch's git clone needs attention.

### Editing Content

Browse collections in the sidebar and click an entry to open it; create new entries with the "+" button (disabled for an entry type with `maxItems: 1` when one already exists). Edit fields in the form on the left and watch the live preview on the right. "Save" persists changes to your branch — **not** committed yet — and clears your local unsaved draft for that file. "Discard" reverts unsaved changes to the last saved state, confirming first.

### Submitting for Review

When your changes are ready, click "Submit for Review" in the header: that commits them and creates a GitHub PR, reviewable with standard GitHub workflows. Once it is merged, CanopyCMS detects it automatically within one worker sync cycle and marks the branch "Merged" in the Branches panel, and your changes deploy with the next site build. A PR closed without merging leaves the branch showing a "PR closed" badge, still submitted, until an admin follows up.

**A submitted branch is locked for content editing.** The editor disables Save and other write actions and shows a banner explaining why — and the server rejects edit requests too, so this is not merely a UI restriction. To resume editing, click "Withdraw" in the branch selector or Branches panel, which converts the PR back to a draft and returns the branch to `editing` status. Someone with review access clicking "Request changes" does the same thing, and signals that revisions are needed.

The base branch (the PR target, usually `main`) can never be submitted — a branch cannot be reviewed against itself — so the "Submit for Review" button is hidden whenever you are viewing it, in both dev and production. In production it is also read-only in the editor: you can browse it, but changes require creating a branch first (the editor shows a banner with a "Create a branch" button). In dev mode it stays fully editable, since local development typically starts there, but you still need to move your work to a branch before it can be submitted.

### Using Comments

Hover a field label and click the comment icon to add a field comment. Comments appear as badges on fields; click a badge to see the thread and add replies, and mark a comment resolved once it is addressed.

### Managing Permissions (Admins)

Admins configure access control from Settings (the gear icon): **Groups** to create groups and add users, and **Permissions** to set path-based access rules.

### System Health (Admins)

From the same Settings menu, **System Health** shows the **worker** (whether the CMS worker daemon is alive, and its last heartbeat), the **task queue** (queued and failed background tasks, which you can retry or delete), and **branch directories** (per-branch workspace health, which you can repair or purge).

## Adopter Touchpoints Summary

CanopyCMS is designed for minimal integration effort. Run `npx canopycms init` to generate every required file, or create them by hand; `--app-dir` customizes the app directory path (default `app`).

- **Config** — `canopycms.config.ts`: settings and operating mode
- **Next.js wrap** — `next.config.ts`: auto-generated, wrapping your config with `withCanopy()`
- **Schemas** — `{appDir}/schemas.ts`: field schemas and the registry
- **Context** — `{appDir}/lib/canopy.ts`: one-time async setup with the auth plugin
- **API route** — `{appDir}/api/canopycms/[...canopycms]/route.ts`: the single catch-all handler
- **Editor page** — `{appDir}/edit/page.tsx`: embeds the editor component
- **Middleware** — `middleware.ts`: auto-generated for the auth mode chosen at `init`; passthrough for dev auth, Clerk middleware for Clerk. It does **not** switch at runtime, and is written into the parent of your app directory, the only place Next.js loads middleware from

**Optional touchpoints:**

- **Server components** — `await getCanopy()` to read draft content with automatic auth. For pages rendering in both build and request phases, prefer the phase-selecting `readByUrlPath`/`read` from `lib/canopy.ts` (see [Phase-Selecting readByUrlPath / read](#phase-selecting-readbyurlpath--read)); `getCanopyForBuild()` remains an advanced escape hatch
- **Static export** — the bound `contentStaticParams` helper drives `generateStaticParams`; see [Static Export with generateStaticParams](#static-export-with-generatestaticparams)
- **AI content route** — `{appDir}/ai/[...path]/route.ts` serves content as AI-readable markdown, generated by default during `init` (see [AI-Ready Content](#ai-ready-content))

`CANOPY_AUTH_MODE` (`dev` or `clerk`) switches auth providers for `canopy.ts` and the edit page at runtime, with no regeneration. **`middleware.ts` is the exception:** it is generated once, frozen to the provider chosen at `init` time, and does not read `CANOPY_AUTH_MODE`, so if you switch providers afterwards regenerate it (`npx canopycms init --force`) or swap it by hand. Under Clerk auth a passthrough `middleware.ts` behaves like having no middleware — CanopyCMS's own API authentication still rejects unauthenticated calls, but signed-out requests reach the app instead of being turned away first. That is a supported shape (see [Protect editor routes](#5-protect-editor-routes)) and deleting the file is the deliberate version of it, so the real choice is between the Clerk middleware and none; the generated passthrough logs a warning when it detects `CANOPY_AUTH_MODE=clerk` at runtime, so ending up without one is a choice rather than an oversight.

Everything else — branch management, content storage, permissions, comments, bootstrap admin groups, meta file loading — CanopyCMS handles automatically.

## Deploying to AWS

```bash
npx canopycms init-deploy aws
```

This scaffolds a complete, deployable CDK app for the recommended AWS architecture (Lambda with no internet access, plus an EC2 worker and EFS, with optional CloudFront/Route53) alongside the Dockerfile and CI workflow:

- `Dockerfile.cms` / `.dockerignore` — Lambda Web Adapter image; install and build commands match your detected package manager (npm, pnpm or Yarn, from `packageManager`, else the lockfile). On pnpm it also copies `pnpm-workspace.yaml` when present, since pnpm 11 keeps its `allowBuilds` decisions there and fails the install without them.
- `.github/workflows/deploy-cms.yml` — CI/CD workflow; triggers on your repo's default branch (detected from `origin/HEAD`), type-checks the CDK app, and deploys the stack **by name**, so it cannot touch unrelated stacks in the same repo.
- `cdk.json` — CDK app entry point.
- `infrastructure/bin/app.ts` — the CDK app; reads its configuration from environment variables and refuses to synth when a required one is missing.
- `infrastructure/lib/cms-stack.ts` — the stack itself, yours to edit (memory/concurrency, media support, an existing distribution).
- `infrastructure/tsconfig.json` — compiler settings for the workflow's `tsc --noEmit -p infrastructure`, extending your own. `cdk.json` runs the CDK app through tsx, which does not check types, and the `tsconfig.json` edit below excludes `infrastructure/` from `next build`, so without this step a misspelled construct prop is dropped silently.
- `tsconfig.json` — adds `infrastructure` to `exclude` so `next build` does not type-check the CDK app. It warns and leaves the file alone if it has comments or inherits `exclude` through `extends` with no list of its own.

Install the CDK dependencies it needs — the CLI warns if any are missing, and the generated workflow fails before deploying:

```bash
npm install --save-dev canopycms canopycms-cdk aws-cdk-lib constructs tsx aws-cdk
```

Like `init`, this never overwrites an existing file without asking (`--non-interactive` skips them, `--force` regenerates them). The full walkthrough — secrets and variables, filling in the stack, troubleshooting — is in [docs/deploying-to-aws.md](docs/deploying-to-aws.md).

## Environment Variables

For CanopyCMS:

```env
CANOPY_AUTH_MODE=dev                           # Auth provider: "dev" (default) or "clerk"
CANOPY_BOOTSTRAP_ADMIN_IDS=user_123,user_456   # Comma-separated user IDs that get auto-admin access
CANOPY_AUTH_CACHE_PATH=/mnt/efs/workspace/.cache  # Override auth cache location (prod mode only)
CANOPY_BUILD_ID=fd91b36c                       # Identifies the build artifact (see below)
```

`CANOPY_BUILD_ID` makes a static export reproducible and is read in two places: `withCanopy(..., { staticBuild: true })` uses it as Next.js's build id (Next's default is random, so without it two builds of one source tree land in different `out/_next/static/<id>/` directories), and `canopycms generate-ai-content` records it as the AI manifest's `buildId`. Next's build id is deliberately left alone on non-static builds, so a dual-build site's two artifacts keep distinct ids.

The value must match `[A-Za-z0-9._-]+`, because Next splices it into `out/_next/static/<id>/` as a single path segment with no validation of its own — `git describe --all` returns `heads/main`, which would nest that directory one level deeper than every emitted URL expects. A content hash of your source tree is the usual choice; a commit SHA is not equivalent, since a rebase gives an identical tree a different commit. A blank or unusable value is ignored with a warning rather than silently producing a random id.

**Export it in the environment rather than in a dotenv file.** Next loads those before it asks for a build id, but `canopycms generate-ai-content` does not, so a value living only in `.env.production` would pin Next's build id and leave the manifest's `buildId` absent.

`SOURCE_DATE_EPOCH` (decimal seconds since the Unix epoch) pins the AI manifest's `generated` timestamp, under the standard [Reproducible Builds](https://reproducible-builds.org/docs/source-date-epoch/) name so a build harness already exporting it gets this for free. Like `CANOPY_BUILD_ID`, a value that is set but blank or malformed is ignored with a warning rather than failing the build — worth heeding, because when a build id is also set, an unpinned timestamp means `generated` is omitted entirely.

For Clerk authentication:

```env
CLERK_SECRET_KEY=sk_...
CLERK_PUBLISHABLE_KEY=pk_...
CLERK_JWT_KEY=...           # Public JWKS PEM. Optional locally; load-bearing on a no-internet Lambda
CLERK_AUTHORIZED_PARTIES=... # Optional: comma-separated domains
```

`CLERK_SECRET_KEY` is resolved lazily, the first time the plugin calls Clerk's backend API — not at build or startup — so a zero-editor static build (`deployedAs: 'static'`, no auth plugin exercised) never needs it. It is needed only where that API is called: the worker daemon's auth-cache refresh, and in dev mode the dev server's lazy refresh. A deployed CMS server verifies tokens with `CLERK_JWT_KEY` alone, unless it also runs `clerkMiddleware`, which needs the secret wherever it runs (see [Security Model](docs/deploying-to-aws.md#security-model)).

For GitHub integration in production mode, the worker authenticates with either a personal access token (the default) or a GitHub App:

```env
GITHUB_BOT_TOKEN=ghp_...    # Bot token for PR creation
```

GitHub App auth is optional, and a PAT stays the documented default because registering an App under an organisation takes an owner of it (or a GitHub App manager), which many adopters are not. To use one, register a per-site App via GitHub's App-manifest flow, which shows you the exact permissions before you click Create:

```bash
npx canopycms init-github-app create -- <a command that reads the key from stdin>
```

**You must say where the key goes, and `create` refuses to start without it:** everything after `--` is run with the private key on its standard input, so it never touches disk, or `--key-out <path>` writes a `0600` file instead. `init-github-app verify` re-checks an existing installation and changes nothing. Both print `GITHUB_APP_ID` and `GITHUB_APP_INSTALLATION_ID`. **Register one App per site, never one shared across repositories.** Full walkthrough in [docs/deploying-to-aws.md](docs/deploying-to-aws.md#authenticating-as-a-github-app).

## Documentation

- [DEVELOPING.md](DEVELOPING.md) — contributor guidelines (the monorepo uses **pnpm** workspaces)
- [ARCHITECTURE.md](ARCHITECTURE.md) — internal architecture
- [docs/adopter-migration.md](docs/adopter-migration.md) — what changed between versions
- [docs/deploying-to-aws.md](docs/deploying-to-aws.md) — deploying to AWS
