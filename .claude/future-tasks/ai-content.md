# AI-Ready Content for CanopyCMS Adopter Sites — Design Document

## Context

SafeInsights (first CanopyCMS adopter) is building a documentation site for researchers. SafeInsights offers a Claude Code interface so researchers can code against data documentation on the site. That Claude Code interface needs to:

1. **Fetch raw markdown** of docs (not rendered HTML) — more token-efficient, semantically cleaner
2. **Fetch targeted collections** — e.g., a researcher working on OpenStax data needs only OpenStax docs, not Khan Academy docs
3. **Support Prompt Caching** — load a collection-level concatenated file into a cacheable system prompt prefix (via Bedrock)

**Environment:** Claude Code running in a Coder container (browser VSCode), likely via Bedrock with Prompt Caching. Site repo is private; the public site is the delivery mechanism.

## Approach: Two Equally Primary Delivery Mechanisms

Both share the same core generation logic (content reading → markdown conversion → output). The adopter chooses based on their deployment:

### Shared Config (single source of truth)

The adopter defines AI content config once. Both the route handler and CLI/build utility use it.

```ts
// app/ai/config.ts — shared config
import { defineAIContentConfig } from 'canopycms/ai'

export const aiContentConfig = defineAIContentConfig({
  // Full content tree included by default — no need to list collections
  // Optional: exclude specific content
  exclude: {
    collections: ['content/drafts'],
    entryTypes: ['internal-note'],
  },
  // Optional: custom bundles
  bundles: [
    {
      name: 'openstax-researcher',
      description: 'Everything an OpenStax researcher needs',
      filter: { collections: ['content/datasets/openstax'] },
    },
  ],
  // Optional: field-level overrides for JSON→markdown
  fieldTransforms: {
    dataset: {
      dataFields: (value, fieldConfig) =>
        `## Data Fields\n| Name | Type |\n|---|---|\n${value
          .map((f) => `| ${f.name} | ${f.type} |`)
          .join('\n')}`,
    },
  },
})
```

### 1. Route Handler (runtime serving)

CanopyCMS provides a route handler the adopter mounts — same pattern as the editor API catch-all. Works during `npm run dev` and on production servers. **Does not require the editor to be deployed** — only needs ContentStore (reads files from disk).

```ts
// app/ai/[...path]/route.ts
import { createAIContentHandler } from 'canopycms/ai'
import { getCanopy } from '../lib/canopy'
import { aiContentConfig } from './config'

export const GET = createAIContentHandler({ getCanopy, ...aiContentConfig })
```

### 2. Static Build Utility (pre-generated files)

CLI command + programmatic API for deployments without a running server (pure static exports, S3/CloudFront). Both use the same config.

```bash
# CLI — points at the shared config file
npx canopycms generate-ai-content --config app/ai/config.ts --output public/ai

# Or zero-config default (no exclusions, no bundles)
npx canopycms generate-ai-content --output public/ai
```

```ts
// Programmatic — imports the shared config
import { generateAIContent } from 'canopycms/build'
import { aiContentConfig } from './app/ai/config'

await generateAIContent({
  config, // CanopyCMS config
  entrySchemaRegistry, // Schema registry
  outputDir: 'public/ai',
  ...aiContentConfig,
})
```

| Deployment                   | Recommended approach |
| ---------------------------- | -------------------- |
| Next.js server (dev or prod) | Route handler        |
| Pure static export           | Build utility        |
| Both (belt & suspenders)     | Either or both       |

## Responsibility Split

### CanopyCMS provides (in the core package)

- Route handler (`canopycms/ai`) and build utility (`canopycms/build`) — shared core logic
- Automatic collection tree traversal from content root (no enumeration needed)
- Schema-driven JSON→markdown conversion with field-level override hooks
- Clean output stripped of CanopyCMS internals (embedded IDs, `.collection.json` structure)
- Manifest generation

### Adopter controls

- Which delivery mechanism to use (route handler, build utility, or both)
- What to exclude (opt-out, not opt-in)
- Custom bundles for filtered content sets
- Field-level rendering overrides for JSON entry types
- Deployment and caching strategy

## Content Selection: Include Everything by Default

The full content tree is included automatically. CanopyCMS knows the collection hierarchy from `.collection.json` files and the content root from config. **Root-level entries are included** — the default is the entire tree, not just named subcollections.

**Exclusion** (opt-out) for content that shouldn't be AI-accessible:

```ts
exclude: {
  collections: ['content/drafts'],      // skip a subtree
  entryTypes: ['internal-note'],        // skip a type everywhere
  where: (entry) => entry.data.draft,   // skip by predicate
}
```

**Bundles** are additive filtered views — they create additional concatenated files from subsets of the included content:

| Filter        | What it matches                                                                |
| ------------- | ------------------------------------------------------------------------------ |
| `collections` | Entries under specific collection paths (including subcollections)             |
| `entryTypes`  | Entries of specific type names                                                 |
| `paths`       | Entries matching glob patterns on logical path                                 |
| `where`       | Predicate function for schema-specific filtering (tags, levels, custom fields) |

Filters are AND'd when combined. The `where` predicate makes tag-based filtering generic across schemas.

## Schema Prerequisite: Add `description` Metadata

Add optional `description` to three config types. Useful independent of AI features (editor UI: collection browser, field tooltips). Non-breaking additions.

```ts
// CollectionConfig — enables meaningful manifests
{ name: 'openstax', label: 'OpenStax', description: 'Student performance data from OpenStax platform' }

// EntryTypeConfig — contextualizes entry types
{ name: 'dataset', label: 'Dataset', description: 'Dataset documentation with access requirements and field definitions' }

// BaseFieldConfig — editor tooltips + richer AI output
{ name: 'irbStatus', type: 'select', label: 'IRB Status', description: 'Whether this dataset requires IRB approval' }
```

## Output Design

### URL / File Structure

```
/ai/manifest.json                      # What's available
/ai/all.md                             # Root-level entries (if any)
/ai/docs/all.md                        # All docs entries concatenated
/ai/docs/getting-started.md            # Individual entry
/ai/docs/authentication.md
/ai/datasets/all.md                    # All dataset entries concatenated
/ai/datasets/openstax/all.md           # Subcollection concatenated
/ai/datasets/openstax/data-dictionary.md
/ai/bundles/openstax-researcher.md     # Custom bundle
```

For the route handler, these are URL paths. For the build utility, these are file paths under `outputDir`.

### Per-Entry Format

YAML frontmatter metadata + content. Used in both concatenated and individual files.

```markdown
---
title: Authentication
slug: authentication
collection: docs/api
---

# Authentication

Content here...
```

For JSON entries, schema-driven conversion:

- Field `label` (or `name` fallback) → markdown heading
- Field `description` → contextual note under heading (when present)
- Field `type` → formatting (richtext → markdown, select → value, array → list, reference → resolved)
- Field ordering from schema → section order
- Adopter overrides individual fields via `fieldTransforms` — no need to rewrite the whole entry

### Manifest

```json
{
  "generated": "2026-03-20T...",
  "entries": [{ "slug": "home", "title": "Home", "file": "home.md" }],
  "collections": [
    {
      "name": "datasets",
      "label": "Datasets",
      "description": "Documentation for available research datasets",
      "path": "datasets",
      "allFile": "datasets/all.md",
      "entryCount": 15,
      "entries": [{ "slug": "overview", "title": "Overview", "file": "datasets/overview.md" }],
      "subcollections": [
        {
          "name": "openstax",
          "label": "OpenStax",
          "description": "OpenStax student performance and engagement data",
          "path": "datasets/openstax",
          "allFile": "datasets/openstax/all.md",
          "entryCount": 5,
          "entries": [
            {
              "slug": "data-dictionary",
              "title": "Data Dictionary",
              "file": "datasets/openstax/data-dictionary.md"
            }
          ]
        }
      ]
    }
  ],
  "bundles": [
    {
      "name": "openstax-researcher",
      "description": "Everything an OpenStax researcher needs",
      "file": "bundles/openstax-researcher.md",
      "entryCount": 8
    }
  ]
}
```

## Alternatives Considered & Rejected

| Approach                          | Why rejected                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Co-located ai.tsx templates**   | Primary need is collection-level bundles, not per-page alternatives. More adopter boilerplate. Good for a different use case (per-page markdown twins). |
| **Separate content API service**  | Over-engineering. Content is already accessible to the site.                                                                                            |
| **Point Claude Code at git repo** | Repo is private. Raw files use CanopyCMS naming (embedded IDs).                                                                                         |
| **Explicit collection listing**   | Fragile — misses root-level entries, requires config updates for new collections. Default-all + opt-out exclusion is better.                            |
| **Whole-entry transforms**        | Forces rewrite of all fields to customize one. Field-level overrides are composable.                                                                    |

## Implementation Scope (when we build it)

### Files to create

1. `packages/canopycms/src/ai/generate.ts` — Core generation logic (shared by route handler + build utility)
2. `packages/canopycms/src/ai/json-to-markdown.ts` — Schema-driven JSON→markdown converter
3. `packages/canopycms/src/ai/handler.ts` — Route handler (`createAIContentHandler`)
4. `packages/canopycms/src/ai/types.ts` — Config/option types
5. `packages/canopycms/src/ai/index.ts` — Public exports
6. `packages/canopycms/src/build/generate-ai-content.ts` — Build utility (writes to disk)
7. `packages/canopycms/src/build/index.ts` — Public exports
8. `packages/canopycms/src/cli/generate-ai-content.ts` — CLI command
9. Example: `apps/example1/app/ai/[...path]/route.ts`
10. Tests

### Files to modify

1. `packages/canopycms/src/config/types.ts` — Add `description` to CollectionConfig, EntryTypeConfig, BaseFieldConfig
2. `packages/canopycms/package.json` — Add `canopycms/ai` and `canopycms/build` exports
3. CLI entry point — Register `generate-ai-content` command

### Key existing code to reuse

- `ContentStore` ([content-store.ts](packages/canopycms/src/content-store.ts)) — content reading, entry listing, collection traversal
- `ContentReader` ([content-reader.ts](packages/canopycms/src/content-reader.ts)) — server-side content access wrapper
- `BUILD_USER` / `isBuildMode()` ([build-mode.ts](packages/canopycms/src/build-mode.ts)) — admin-level access during build
- `gray-matter` — already used for frontmatter parsing
- Collection `.collection.json` resolution — walking the collection tree

## Future Considerations (not for v1)

- `llms.txt` / `llms-full.txt` generation (emerging standard, easy to add)
- HTTP caching headers on route handler (ETag, Cache-Control based on content hash)
- Selective rebuild in build utility (only regenerate changed entries)
- MCP server for direct Claude Code tool integration
- Per-page markdown twins (the ai.tsx approach) as a complementary feature
