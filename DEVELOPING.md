# Developing CanopyCMS

This document contains development guidelines and patterns for contributors to CanopyCMS.

## Architecture Patterns

### Framework-Agnostic Core

CanopyCMS follows a strict separation between framework-agnostic business logic and framework adapters:

**Core Packages (`canopycms`)**

- Contain all business logic, auth, content reading, services
- Accept callbacks/functions via dependency injection
- Never import framework-specific code (Next.js, Express, etc.)
- Export factory functions that return configured instances

**Adapter Packages (`canopycms-next`, etc.)**

- Thin wrappers around core functionality (prefer ~10 lines)
- Extract user/request data from framework-specific APIs
- Add framework-specific optimizations (caching, middleware, etc.)
- Provide unified API for adopters

**Example: User Extraction**

Core defines the interface:

```typescript
// packages/canopycms/src/context.ts
export interface CanopyContextOptions {
  config: CanopyConfig
  getUser: () => Promise<CanopyUser> // Injected by adapter
}
```

Adapter provides the implementation:

```typescript
// packages/canopycms-next/src/user-extraction.ts
export function createNextUserExtractor(authPlugin: AuthPlugin) {
  return async (): Promise<CanopyUser> => {
    const headersList = await headers() // Next.js-specific
    const mockRequest = {
      method: 'GET',
      url: headersList.get('referer') || 'http://localhost',
      header: (name: string) => headersList.get(name),
      json: async () => ({}),
    }
    const authResult = await authPlugin.verifyToken(mockRequest)
    return authResult.valid && authResult.user ? authResult.user : ANONYMOUS_USER
  }
}
```

### Context Factory Pattern

The core exports a `createCanopyContext()` factory that manages auth and content reading:

**Core Factory**

```typescript
// packages/canopycms/src/context.ts
export function createCanopyContext(options: CanopyContextOptions) {
  const services = createCanopyServices(options.config)

  const getContext = async (): Promise<CanopyContext> => {
    const user = await options.getUser() // Adapter-provided
    // Apply bootstrap admin groups, create content reader, etc.
    return { read, services, user }
  }

  return {
    getContext, // Call this per-request
    services, // Shared across requests
  }
}
```

**Framework Adapter**

```typescript
// packages/canopycms-next/src/context-wrapper.ts
export function createNextCanopyContext(options: NextCanopyOptions) {
  const coreContext = createCanopyContext({
    config: options.config,
    getUser: createNextUserExtractor(options.authPlugin),
  })

  // Add React cache() for per-request memoization
  const getCanopy = cache((): Promise<CanopyContext> => {
    return coreContext.getContext()
  })

  return {
    getCanopy,
    handler: createCanopyCatchAllHandler(options),
    services: coreContext.services,
  }
}
```

**Usage in Server Components**

```typescript
// app/posts/[slug]/page.tsx
const { getCanopy } = createNextCanopyContext({ config, authPlugin })

export default async function PostPage({ params }: { params: { slug: string } }) {
  const canopy = await getCanopy()
  const { data } = await canopy.read({ entryPath: 'content/posts', slug: params.slug })
  return <PostView data={data} />
}
```

### Build Mode Detection

During static site generation, CanopyCMS needs to bypass auth checks to read content. The `isBuildMode()` function provides framework-agnostic detection:

**Build Mode Function**

```typescript
// packages/canopycms/src/build-mode.ts
export const isBuildMode = (): boolean => {
  // Next.js build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') return true

  // Generic build mode flag (can be set by any framework)
  if (process.env.CANOPY_BUILD_MODE === 'true') return true

  return false
}
```

**Build User Constant**

```typescript
// packages/canopycms/src/build-mode.ts
export const BUILD_USER: AuthenticatedUser = Object.freeze({
  type: 'authenticated',
  userId: '__build__',
  groups: ['Admins'],
  email: 'build@canopycms',
  name: 'Build Process',
})
```

**Usage in Context Creation**

```typescript
// packages/canopycms/src/context.ts
const getUserWithBootstrap = async (): Promise<CanopyUser> => {
  // Build mode: bypass auth, return admin user
  if (isBuildMode()) {
    return BUILD_USER
  }

  // Runtime: get real user from adapter
  const user = await options.getUser()
  // ... apply bootstrap admin groups
}
```

**Testing Build Mode**

To test build mode behavior:

```typescript
it('bypasses permissions during build', () => {
  process.env.CANOPY_BUILD_MODE = 'true'
  try {
    const context = createCanopyContext({ config, extractUser: mockExtractUser })
    const canopy = await context.getContext()
    expect(canopy.user).toEqual(BUILD_USER)
  } finally {
    delete process.env.CANOPY_BUILD_MODE
  }
})
```

### Adding a New Framework Adapter

To add support for a new framework (Express, Fastify, SvelteKit, etc.):

1. **Create user extraction function**

   ```typescript
   // packages/canopycms-express/src/user-extraction.ts
   export function createExpressUserExtractor(authPlugin: AuthPlugin) {
     return async (req: Request): Promise<CanopyUser> => {
       const authResult = await authPlugin.verifyToken(req)
       return authResult.valid && authResult.user ? authResult.user : ANONYMOUS_USER
     }
   }
   ```

2. **Wrap core context factory**

   ```typescript
   // packages/canopycms-express/src/context-wrapper.ts
   export function createExpressCanopyContext(options: ExpressCanopyOptions) {
     const coreContext = createCanopyContext({
       config: options.config,
       getUser: createExpressUserExtractor(options.authPlugin),
     })

     // Add Express-specific middleware/caching if needed
     return {
       middleware: (req, res, next) => {
         /* ... */
       },
       getContext: coreContext.getContext,
       services: coreContext.services,
     }
   }
   ```

3. **Keep adapters thin** - 10-20 lines for user extraction is ideal
4. **Export unified API** - hide framework details from adopters
5. **Add framework-specific optimizations** - caching, middleware, etc.

## Operating Mode Strategies

CanopyCMS uses the Strategy pattern to encapsulate mode-specific behavior. Understanding this pattern is important for adding new features that behave differently across modes.

### Strategy Pattern Overview

**Two strategy layers:**

1. **ClientSafeStrategy** (`operating-mode/client-safe-strategy.ts`)
   - No Node.js imports (can be bundled for client)
   - Pure configuration values and flags
   - Methods: `supportsBranching()`, `shouldCommit()`, `getPermissionsFileName()`, etc.

2. **ClientUnsafeStrategy** (`operating-mode/client-unsafe-strategy.ts`)
   - Extends ClientSafeStrategy
   - Adds server-side functionality
   - Methods: `getBaseRoot()`, `getPermissionsFilePath()`, `getRemoteUrlConfig()`, etc.

**Key principle**: Strategies return values, not logic.

```typescript
// GOOD: Strategy returns a flag
shouldAutoInitLocal(): boolean {
  return true
}

// BAD: Strategy contains business logic
async resolveRemoteUrl(): Promise<string> {
  // Don't do git operations in strategies!
  const git = simpleGit(...)
  await git.raw([...])
  // ...
}
```

### When to Use Strategies

Add mode-specific behavior to strategies when:

- Different modes need different configuration values (file names, paths, flags)
- UI features should be enabled/disabled based on mode
- Simple boolean decisions drive behavior elsewhere

**Don't put in strategies:**

- Git operations (belongs in GitManager)
- File I/O operations (belongs in services/utilities)
- Complex business logic (belongs in domain code)

### Example: Adding Mode-Specific Behavior

```typescript
// 1. Add method to strategy interface (operating-mode/types.ts)
interface ClientSafeStrategy {
  // ... existing methods
  supportsFeatureX(): boolean
}

// 2. Implement in each strategy class
class ProdClientSafeStrategy implements ClientSafeStrategy {
  supportsFeatureX(): boolean {
    return true
  }
}

class LocalSimpleClientSafeStrategy implements ClientSafeStrategy {
  supportsFeatureX(): boolean {
    return false
  }
}

// 3. Use the flag in your code
const strategy = clientOperatingStrategy(config.mode)
if (strategy.supportsFeatureX()) {
  // Enable feature X
}
```

### Testing Strategies

```typescript
import { operatingStrategy } from './operating-mode'

it('returns correct config for each mode', () => {
  const prodStrategy = operatingStrategy('prod')
  expect(prodStrategy.shouldAutoInitLocal()).toBe(false)

  const localProdSimStrategy = operatingStrategy('local-prod-sim')
  expect(localProdSimStrategy.shouldAutoInitLocal()).toBe(true)
})
```

## Schema Architecture

CanopyCMS uses a unified schema model that treats collections and singletons as first-class citizens. Understanding this architecture is essential for working with content.

### Schema Structure

**New Object Format (Current)**

The schema is now defined as an object with separate arrays for collections and singletons:

```typescript
const config = defineCanopyConfig({
  schema: {
    collections: [
      {
        name: 'posts',
        path: 'posts',
        label: 'Blog Posts',
        entries: {
          format: 'md',
          fields: [
            { name: 'title', type: 'string' },
            { name: 'author', type: 'reference', collections: ['authors'] },
          ],
        },
        // Nested collections and singletons
        collections: [
          {
            name: 'drafts',
            path: 'drafts',
            entries: { format: 'md', fields: [...] },
          },
        ],
        singletons: [
          {
            name: 'featured',
            path: 'featured',
            format: 'json',
            fields: [{ name: 'postId', type: 'reference', collections: ['posts'] }],
          },
        ],
      },
    ],
    singletons: [
      {
        name: 'settings',
        path: 'settings',
        format: 'json',
        fields: [{ name: 'siteName', type: 'string' }],
      },
    ],
  },
})
```

**Legacy Array Format (Deprecated)**

The old format used a flat array with discriminated types:

```typescript
// DO NOT use in production - for backward compatibility only
schema: [
  { type: 'collection', name: 'posts', path: 'posts', format: 'md', fields: [...] },
  { type: 'entry', name: 'settings', path: 'settings', format: 'json', fields: [...] },
]
```

**Migration:** Use `defineCanopyTestConfig()` in tests for automatic migration from legacy format. Production code should always use the new object format.

### Flattening Schema for Runtime

At runtime, the nested schema is flattened into an indexed structure for O(1) path lookups:

```typescript
import { flattenSchema } from './config'

// Flatten the schema into a flat array
const flatItems = flattenSchema(config.schema, config.contentRoot)
// Returns: FlatSchemaItem[]

// Build an index for fast lookups
const schemaIndex = new Map(flatItems.map((item) => [item.fullPath, item]))

// Lookup by path
const item = schemaIndex.get('content/posts')
if (item?.type === 'collection') {
  console.log('Collection:', item.name, item.entries?.format)
} else if (item?.type === 'singleton') {
  console.log('Singleton:', item.name, item.format)
}
```

**FlatSchemaItem Structure**

The flattened schema uses a discriminated union for type safety:

```typescript
type FlatSchemaItem =
  | {
      type: 'collection'
      fullPath: string // e.g., "content/posts"
      name: string // e.g., "posts"
      label?: string
      parentPath?: string // Path of parent collection
      entries?: CollectionEntriesConfig
      collections?: CollectionConfig[]
      singletons?: SingletonConfig[]
    }
  | {
      type: 'singleton'
      fullPath: string // e.g., "content/settings"
      name: string // e.g., "settings"
      label?: string
      parentPath?: string
      format: ContentFormat // 'md' | 'mdx' | 'json'
      fields: FieldConfig[]
    }
```

**Key Properties:**

- `fullPath`: Absolute path from content root (e.g., `content/posts`, `content/posts/drafts`)
- `type`: Discriminator field for type narrowing (`'collection'` or `'singleton'`)
- `parentPath`: For nested items, the parent collection's full path
- Collections have `entries` config; singletons have `format` and `fields` directly

### Working with ContentStore

The `ContentStore` class uses the flattened schema for all content operations:

**Path Resolution**

```typescript
// Resolve URL paths to schema items
const { schemaItem, slug, itemType } = store.resolvePath(['content', 'posts', 'hello'])
// Returns:
// - schemaItem: FlatSchemaItem (collection or singleton)
// - slug: 'hello' for entries, '' for singletons
// - itemType: 'entry' | 'singleton'

// Try singleton first, then collection+slug
const singleton = store.resolvePath(['content', 'settings'])
// { schemaItem: { type: 'singleton', ... }, slug: '', itemType: 'singleton' }

const entry = store.resolvePath(['content', 'posts', 'my-post'])
// { schemaItem: { type: 'collection', ... }, slug: 'my-post', itemType: 'entry' }
```

**Reading Content**

```typescript
// For collection entries: pass collection path and slug
const doc = await store.read('content/posts', 'hello-world')

// For singletons: pass singleton path, no slug (or empty string)
const settings = await store.read('content/settings')
// Equivalent: await store.read('content/settings', '')
```

**Writing Content**

```typescript
// Collection entry
await store.write('content/posts', 'hello-world', {
  format: 'md',
  data: { title: 'Hello World' },
  body: 'Content goes here',
})

// Singleton
await store.write('content/settings', '', {
  format: 'json',
  data: { siteName: 'My Site' },
})
```

**Pattern:** Collections require both path and slug; singletons use path only (empty slug).

### API Response Format

The API distinguishes between entries and singletons using the `itemType` field:

**Collection Items Response**

```typescript
type CollectionItem = {
  slug: string
  itemType: 'entry' | 'singleton'
  collection: string
  // ... other fields
}

// In collections summary
{
  collections: [
    {
      name: 'posts',
      type: 'collection',
      label: 'Blog Posts',
      path: 'content/posts',
      children: [
        // Nested collections and singletons
        { name: 'featured', type: 'entry', path: 'content/posts/featured' },
      ],
    },
    {
      name: 'settings',
      type: 'entry',  // Singletons show as type 'entry'
      path: 'content/settings',
    },
  ],
  entries: [
    // Only collection entries appear here
    { slug: 'hello-world', itemType: 'entry', collection: 'content/posts' },
  ],
}
```

**Key Distinctions:**

- `itemType: 'entry'`: Regular collection entry with a slug
- `itemType: 'singleton'`: Single-instance content with a fixed path
- Singletons appear in the `collections` array with `type: 'entry'`, NOT in the `entries` list
- Check `itemType` field to distinguish when processing items

### Testing with Schema

**Using defineCanopyTestConfig()**

The test helper handles both old and new formats:

```typescript
import { defineCanopyTestConfig } from './config-test'

// New format (preferred)
const config = defineCanopyTestConfig({
  schema: {
    collections: [
      {
        name: 'posts',
        path: 'posts',
        entries: {
          format: 'md',
          fields: [{ name: 'title', type: 'string' }],
        },
      },
    ],
    singletons: [
      {
        name: 'settings',
        path: 'settings',
        format: 'json',
        fields: [{ name: 'siteName', type: 'string' }],
      },
    ],
  },
})

// Legacy format (auto-migrated)
const legacyConfig = defineCanopyTestConfig({
  schema: [
    { type: 'collection', name: 'posts', path: 'posts', format: 'md', fields: [...] },
    { type: 'entry', name: 'settings', path: 'settings', format: 'json', fields: [...] },
  ],
})
```

**Testing Schema Resolution**

```typescript
it('resolves paths to schema items', () => {
  const config = defineCanopyTestConfig({
    schema: {
      collections: [{ name: 'posts', path: 'posts', entries: { fields: [...] } }],
      singletons: [{ name: 'settings', path: 'settings', format: 'json', fields: [...] }],
    },
  })

  const store = new ContentStore(root, config)

  // Test singleton resolution
  const { schemaItem, slug, itemType } = store.resolvePath(['content', 'settings'])
  expect(schemaItem.type).toBe('singleton')
  expect(slug).toBe('')
  expect(itemType).toBe('singleton')

  // Test collection entry resolution
  const entry = store.resolvePath(['content', 'posts', 'hello'])
  expect(entry.schemaItem.type).toBe('collection')
  expect(entry.slug).toBe('hello')
  expect(entry.itemType).toBe('entry')
})
```

**Common Test Patterns**

```typescript
// Verify both collections and singletons are indexed
it('indexes all schema items', () => {
  const flat = flattenSchema(config.schema, 'content')

  const collections = flat.filter((item) => item.type === 'collection')
  const singletons = flat.filter((item) => item.type === 'singleton')

  expect(collections).toHaveLength(1)
  expect(singletons).toHaveLength(1)
  expect(flat.find((item) => item.name === 'posts')?.fullPath).toBe('content/posts')
})

// Verify API response format
it('returns correct itemType in API responses', async () => {
  const response = await client.entries.list({ branch: 'main' })

  const entries = response.data.entries
  const collections = response.data.collections

  // Entries should only include collection entries
  expect(entries.every((e) => e.itemType === 'entry')).toBe(true)

  // Singletons appear in collections with type 'entry'
  const singletons = collections.filter((c) => c.type === 'entry')
  expect(singletons.some((s) => s.name === 'settings')).toBe(true)
})
```

## Working with Content IDs

### Using the ID Index

Content entries are identified by stable, content-addressed IDs (22-character short UUIDs). These IDs are managed by the `ContentIdIndex` through symlinks stored in the `_ids_/` directory.

When working with content IDs, use the async `idIndex()` getter to access the index:

```typescript
// Get the ID index - it loads lazily on first access
const idIndex = await store.idIndex()

// Find a location by ID
const location = idIndex.findById('abc123def456ghi789jkl')
if (location) {
  console.log(`Entry is at: ${location.relativePath}`)
}

// Find an ID by file path
const id = idIndex.findByPath('content/posts/hello-world.md')

// Add a new entry to the index (returns generated ID)
const newId = await idIndex.add({
  type: 'entry',
  relativePath: 'content/pages/about.json',
  collection: 'pages',
  slug: 'about',
})

// Remove an entry from the index
await idIndex.remove(newId)
```

**Why use the getter:** The `idIndex()` getter automatically handles lazy loading on first access. Calling it multiple times is safe - the index is loaded only once and subsequent calls return the already-loaded index. Never access `_idIndex` directly - always use the public getter.

**Pattern:**

```typescript
// Always await the getter
const idIndex = await store.idIndex()

// Not this:
// const idIndex = store._idIndex  // Wrong!
```

## Reference Field Configuration

Reference fields link entries together. Configure them with collection constraints and optional custom display fields:

**Field Schema:**

```typescript
const referenceFieldSchema = z.object({
  type: z.literal('reference'),
  name: z.string().min(1),
  label: z.string().optional(),
  required: z.boolean().optional(),
  list: z.boolean().optional(),
  collections: z.array(z.string().min(1)).min(1), // Which collections to reference
  displayField: z.string().min(1).optional(), // Field to show as label
  options: z.array(referenceOptionSchema).optional(), // For backward compatibility
})
```

**Example: Dynamic References with Collections**

```typescript
// Schema defining which collections can be referenced
const schema = [
  {
    type: 'collection',
    name: 'posts',
    fields: [
      {
        type: 'reference',
        name: 'author',
        label: 'Post Author',
        collections: ['authors'], // Can only reference authors collection
        displayField: 'name', // Show author's name field as label
      },
      {
        type: 'reference',
        name: 'relatedPosts',
        label: 'Related Posts',
        collections: ['posts'], // Self-reference for related content
        displayField: 'title', // Show post titles
        list: true, // Can reference multiple posts
      },
    ],
  },
  {
    type: 'collection',
    name: 'authors',
    fields: [{ type: 'string', name: 'name', label: 'Author Name' }],
  },
]
```

**Using Optional Properties:**

- `displayField`: Field name from the referenced entry to show as a label (e.g., `title`, `name`, `headline`)
- `options`: Static list of options for backward compatibility - if provided alongside `collections`, the UI can use it as a fallback

**Validation:** The `ReferenceValidator` ensures:

1. Referenced IDs are valid format
2. Referenced entries actually exist
3. Referenced entries are in allowed collections
4. Referenced entries are not collections themselves

### Implementing Live Reference Resolution in Editor

The editor's live preview needs to display full referenced content (not just IDs). This is implemented through a synchronous resolution system with background caching in `FormRenderer.tsx`.

**Core Implementation Pattern:**

```typescript
// 1. Cache for resolved references (persists across renders)
const resolvedCache = useRef<Map<string, any>>(new Map())
const [resolutionTrigger, setResolutionTrigger] = useState(0)

// 2. Synchronous resolution using useMemo (runs during render)
const resolvedValue = useMemo(() => {
  const result = { ...value }

  // For each reference field, apply cached data if available
  for (const fieldName of referenceFieldNames) {
    const fieldValue = value[fieldName]
    if (fieldValue && typeof fieldValue === 'string') {
      const cached = resolvedCache.current.get(`${branch}:${fieldValue}`)
      result[fieldName] = cached || fieldValue // Use cache or keep ID
    }
  }

  return result
}, [value, fields, branch, resolutionTrigger])

// 3. Background async resolution (updates cache)
useEffect(() => {
  // Find IDs not in cache
  const uncachedIds = findUncachedIds(value, referenceFieldNames, resolvedCache.current, branch)

  if (uncachedIds.length === 0) return

  // Debounce API calls
  const timeout = setTimeout(async () => {
    const resolved = await apiClient.content.resolveReferences({ branch }, { ids: uncachedIds })

    // Update cache
    for (const [id, data] of Object.entries(resolved.data.resolved)) {
      resolvedCache.current.set(`${branch}:${id}`, data)
    }

    // Trigger useMemo re-run
    setResolutionTrigger((prev) => prev + 1)
  }, 300)

  return () => clearTimeout(timeout)
}, [value, fields, branch])
```

**Key Implementation Details:**

1. **Cache Structure:** `Map<string, any>` with keys like `"main:5NVkkrB1MJUvnLqEDqDkRN"` (branch:id)
   - Scoped by branch to prevent stale cross-branch data
   - Cleared when branch changes
   - Persists across form edits for instant re-renders

2. **Synchronous Transform:** `useMemo` computes resolved value during render
   - Always returns complete, valid data (never empty objects)
   - Uses cache when available, otherwise keeps ID
   - No async gaps means no race conditions

3. **Background Resolution:** `useEffect` fills cache asynchronously
   - 300ms debounce prevents excessive API calls while typing
   - Only fetches IDs not already in cache (incremental)
   - Triggers useMemo re-run via `resolutionTrigger` state

4. **Parent Notification:** Pass resolved value to parent with infinite loop prevention
   ```typescript
   useEffect(() => {
     const serialized = JSON.stringify(resolvedValue)
     if (serialized !== lastNotifiedValueRef.current) {
       lastNotifiedValueRef.current = serialized
       onResolvedValueChange?.(resolvedValue)
     }
   }, [resolvedValue, onResolvedValueChange])
   ```

**Critical Gotcha: Never Pass Empty Objects**

The parent component must guard against rendering when data is undefined:

```typescript
// BAD: Will cause errors during transitions
<FormRenderer value={effectiveValue ?? {}} />

// GOOD: Only render when data exists
{effectiveValue && <FormRenderer value={effectiveValue} />}
```

**API Endpoint:**

The resolution endpoint (`POST /:branch/resolve-references`) accepts an array of IDs and returns full entry objects:

```typescript
// Request
{ ids: ["5NVkkrB1MJUvnLqEDqDkRN", "abc123"] }

// Response
{
  ok: true,
  data: {
    resolved: {
      "5NVkkrB1MJUvnLqEDqDkRN": { id: "...", name: "Alice", bio: "..." },
      "abc123": { id: "...", name: "Bob", bio: "..." }
    }
  }
}
```

**Testing:**

Test the resolution flow by:

1. Selecting a reference in the editor
2. Verifying preview shows loading state initially (ID rendered)
3. After 300ms, verify preview shows full data (name, bio, etc.)
4. Change selection and verify cache is used (instant update for previously-selected references)
5. Click "Discard All Drafts" and verify no errors (data remains complete)

See `FormRenderer.test.tsx` for examples.

## Testing Content IDs and Symlinks

When testing code that uses content IDs, set up a temporary directory with symlinks:

```typescript
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ContentIdIndex } from './content-id-index'

describe('Content with IDs', () => {
  let tempDir: string
  let index: ContentIdIndex

  beforeEach(async () => {
    // Create isolated temp directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-test-'))
    await fs.mkdir(path.join(tempDir, 'content'), { recursive: true })
    index = new ContentIdIndex(tempDir)
  })

  afterEach(async () => {
    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('indexes entries with IDs', async () => {
    // Create a test file
    const filePath = path.join(tempDir, 'content/test.json')
    await fs.writeFile(filePath, '{"title": "Test"}')

    // Create symlink in _ids_/ directory
    await fs.mkdir(path.join(tempDir, 'content/_ids_'), { recursive: true })
    const testId = 'test123ABC456def789ghi'
    await fs.symlink('../test.json', path.join(tempDir, 'content/_ids_', testId), 'file')

    // Build index from symlinks
    await index.buildFromSymlinks('content')

    // Verify
    const location = index.findById(testId)
    expect(location?.relativePath).toBe('content/test.json')
  })
})
```

**Key pattern:** Symlinks point from `_ids_/ID` to the actual content file (e.g., `_ids_/abc123 -> ../test.json`). The `buildFromSymlinks()` method reads these symlinks to populate the in-memory index.

## Development Workflow

### Settings Management (Permissions and Groups)

CanopyCMS manages permissions and groups through JSON files in the `.canopycms/` directory. The behavior differs significantly between development and production modes.

#### Local Development: `.local.json` Files

In `local-simple` mode (the default for development), CanopyCMS uses **gitignored** `.local.json` files for permissions and groups:

- **Files:**
  - `.canopycms/permissions.local.json` - path-level permissions
  - `.canopycms/groups.local.json` - user groups and memberships

- **Purpose:** These files allow you to test different permission scenarios and user roles without polluting the git history or conflicting with other developers.

- **Behavior:**
  - Changes persist across CMS restarts
  - Files are **automatically gitignored** (via `.canopycms` in `.gitignore`)
  - If `.local.json` doesn't exist, falls back to reading `.json` (committed version)
  - Writes always go to `.local.json` in local-simple mode

**Example workflow:**

```bash
# Start the CMS in local-simple mode (default)
npm run dev

# 1. Login as different test users (e.g., auth-dev, Clerk dev accounts)
# 2. Add them to groups via the CMS UI
# 3. Test permission restrictions
# 4. Changes are saved to .canopycms/permissions.local.json and .canopycms/groups.local.json
# 5. Files persist but won't show up in git status

# Verify files are gitignored
git status  # .canopycms/ should not appear
```

**Testing different permission scenarios:**

```typescript
// In your local .canopycms/permissions.local.json
{
  "version": 1,
  "updatedAt": "2026-01-12T10:00:00Z",
  "updatedBy": "test-user",
  "pathPermissions": [
    {
      "path": "content/posts",
      "groups": {
        "Editors": ["read", "write"],
        "Viewers": ["read"]
      }
    }
  ]
}

// In your local .canopycms/groups.local.json
{
  "version": 1,
  "updatedAt": "2026-01-12T10:00:00Z",
  "updatedBy": "test-user",
  "groups": [
    {
      "name": "Editors",
      "userIds": ["auth-dev-user-1", "clerk-test-user"]
    },
    {
      "name": "Viewers",
      "userIds": ["auth-dev-user-2"]
    }
  ]
}
```

#### Understanding the Three Modes

| Mode               | Settings Files                                 | Git Operations                              | Use Case                               |
| ------------------ | ---------------------------------------------- | ------------------------------------------- | -------------------------------------- |
| **local-simple**   | `.canopycms/*.local.json` (gitignored)         | None                                        | Local development, testing permissions |
| **local-prod-sim** | `.canopycms/branches/main/*.json` (gitignored) | Standard commits to branch clones           | Testing branch workflows locally       |
| **prod**           | `.canopycms/*.json` (committed)                | Long-running `settings` branch with auto-PR | Production deployment                  |

**local-simple (Default for Development):**

- No git operations
- Settings in `.local.json` files (gitignored)
- Instant feedback, no branch management overhead
- Perfect for testing different users and permissions

**local-prod-sim (Testing Branch Workflows):**

- Full branch simulation with clones in `.canopycms/branches/`
- Settings in `.json` files within branch clones
- All of `.canopycms/` is gitignored
- Tests branch creation, merging, permission inheritance

**prod (Production):**

- Settings tracked in git via long-running `settings` branch
- Changes auto-create/update a PR to merge into `main`
- Settings are active immediately but persisted when PR merges
- Requires GitHub token and `defaultRemoteUrl`

#### Production Settings Workflow

In production (`mode: 'prod'`), permission and group changes follow a special workflow:

1. **Settings Branch:** Changes are committed to a long-running `canopycms-settings` branch (configurable via `settingsBranch`, defaults to `"canopycms-settings"`)

2. **Auto-PR Creation:** When `autoCreateSettingsPR` is enabled (default: `true`), CanopyCMS automatically creates or updates a PR from `canopycms-settings` → `main`

3. **Immediate Effect:** Changes are active in the CMS immediately (read from the `canopycms-settings` branch)

4. **Persistence:** When the PR is merged, changes become part of the main branch history

5. **Optimistic Locking:** Settings files include a `contentVersion` field that prevents concurrent admin updates from overwriting each other. If a version conflict is detected, the API returns a 409 status code.

**Configuration:**

```typescript
// canopycms.config.ts
export default defineCanopyConfig({
  mode: 'prod',
  settingsBranch: 'canopycms-settings', // Optional, defaults to 'canopycms-settings'
  autoCreateSettingsPR: true, // Optional, defaults to true
  defaultRemoteUrl: 'https://github.com/your-org/your-repo.git',
  // ... other config
})
```

**How it works:**

```typescript
// Internal flow when updating permissions in prod mode
// 1. Check current contentVersion for optimistic locking
const currentFile = await loadPermissionsFile(branchRoot, mode)
if (
  expectedContentVersion !== undefined &&
  currentFile?.contentVersion !== expectedContentVersion
) {
  return { status: 409, error: 'Permissions were modified by another user' }
}

// 2. commitToSettingsBranch() creates/checks out settings branch
await git.checkoutBranch('canopycms-settings')

// 3. Pulls latest (if remote exists)
await git.pullBase()

// 4. Commits changes with incremented version
const newContentVersion = (currentFile?.contentVersion ?? 0) + 1
await savePermissions(branchRoot, permissions, userId, mode, newContentVersion)
await git.add('.canopycms/permissions.json')
await git.commit('Update permissions')

// 5. Pushes to remote settings branch
await git.push('canopycms-settings')

// 6. Creates/updates PR if autoCreateSettingsPR is true
await githubService.createOrUpdatePR({
  head: 'canopycms-settings',
  base: 'main',
  title: 'Update permissions and groups',
  body: 'Automated PR for permission and group changes...',
})
```

#### Verifying Local Changes Aren't Committed

To ensure your local `.local.json` files don't accidentally get committed:

```bash
# Check that .canopycms is in .gitignore
cat apps/example1/.gitignore
# Should contain: .canopycms

# Verify nothing shows in git status
git status
# .canopycms/permissions.local.json should NOT appear

# List what would be committed
git add -n .
# Should not include .canopycms/*.local.json

# If you accidentally committed settings files
git reset HEAD .canopycms/permissions.local.json
git reset HEAD .canopycms/groups.local.json
```

**Common mistake:** Adding `.canopycms/permissions.json` (without `.local`) to git in local-simple mode. This can happen if you:

1. Switch from `local-prod-sim` or `prod` mode back to `local-simple`
2. Have an old `.json` file from before the `.local.json` pattern

**Fix:** In local-simple mode, always check that your gitignore includes `.canopycms` and manually delete any `.canopycms/*.json` files that aren't `.local.json`.

#### Migration Guide: Adding .local.json Pattern

If you're upgrading an existing project to use the `.local.json` pattern:

```bash
# 1. Ensure .canopycms is gitignored
echo ".canopycms" >> apps/your-app/.gitignore

# 2. Copy existing settings to .local.json (if in local-simple mode)
cp .canopycms/permissions.json .canopycms/permissions.local.json
cp .canopycms/groups.json .canopycms/groups.local.json

# 3. Remove tracked files from git (but keep local copies)
git rm --cached .canopycms/permissions.json
git rm --cached .canopycms/groups.json
git commit -m "chore: move to .local.json pattern for local dev"

# 4. Verify
git status  # Should not show .canopycms/ files
```

## Testing

### Running Tests

```bash
# Run all tests
npm test --workspaces

# Run tests for a specific package
cd packages/canopycms && npm test

# Run a specific test file
cd packages/canopycms && npx vitest run src/github-service.test.ts
```

### Mocking Git Operations

After a major refactoring, CanopyCMS tests now mock high-level git service methods instead of low-level git operations. This makes tests more maintainable and focused on API behavior.

**New Pattern: Use `createMockGitServices()`**

Import the test utility:

```typescript
import { createMockGitServices } from '../test-utils/mock-git-services'
```

Create mock services in your test setup:

```typescript
const mockGitServices = createMockGitServices()

const mockContext: ApiContext = {
  services: {
    config: testConfig,
    flatSchema: [],
    // ... other services
    commitFiles: mockGitServices.commitFiles,
    submitBranch: mockGitServices.submitBranch,
  },
  getBranchContext: vi.fn().mockResolvedValue({
    baseRoot: '/test/repo',
    branchRoot: '/test/repo',
    branch: {
      name: 'main',
      status: 'editing',
      // ... branch metadata
    },
  }),
}
```

**Verify Git Operations in Tests**

After calling an API handler, verify that `commitFiles` or `submitBranch` was called with the correct arguments:

```typescript
it('commits files when updating permissions', async () => {
  const req: ApiRequest = {
    method: 'POST',
    url: '/main/permissions',
    json: async () => ({
      path: 'content/posts',
      groups: { Editors: ['read', 'write'] },
    }),
  }

  const result = await updatePermissionsHandler(
    mockContext,
    { user: adminUser },
    { branch: 'main' },
  )

  expect(result.ok).toBe(true)

  // Verify commitFiles was called with correct arguments
  expect(mockContext.services.commitFiles).toHaveBeenCalledWith({
    context: {
      baseRoot: '/test/repo',
      branchRoot: '/test/repo',
      branch: {
        name: 'main',
        status: 'editing',
        access: { allowedUsers: [], allowedGroups: [] },
        createdBy: 'admin-1',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    },
    files: '.canopycms/permissions.json',
    message: 'Update permissions',
  })
})
```

**What Changed**

**Old Pattern (Deprecated):**

```typescript
// DON'T DO THIS - old pattern
const mockGitManager = {
  ensureAuthor: vi.fn(),
  add: vi.fn(),
  commit: vi.fn(),
}

// Verify individual git operations
expect(mockGitManager.ensureAuthor).toHaveBeenCalled()
expect(mockGitManager.add).toHaveBeenCalledWith('.canopycms/permissions.json')
expect(mockGitManager.commit).toHaveBeenCalledWith('Update permissions')
```

**New Pattern (Current):**

```typescript
// DO THIS - new pattern
import { createMockGitServices } from '../test-utils/mock-git-services'

const mockGitServices = createMockGitServices()

// Include in ApiContext
services: {
  commitFiles: mockGitServices.commitFiles,
  submitBranch: mockGitServices.submitBranch,
}

// Verify high-level service calls
expect(mockContext.services.commitFiles).toHaveBeenCalledWith({
  context: branchContext,
  files: '.canopycms/permissions.json',
  message: 'Update permissions',
})
```

**When to Use Each Method**

- `commitFiles`: For operations that modify content or metadata files (permissions, groups, content updates)
- `submitBranch`: For workflow operations that transition a branch to merge (submit for review, approve merge)

**Benefits of the New Pattern**

1. **Higher-level abstractions** - Test the service interface, not git internals
2. **Cleaner test setup** - `createMockGitServices()` creates both mocks at once
3. **Easier maintenance** - Changes to git implementation don't break tests
4. **More focused tests** - Verify what the API does, not how git works

See `/packages/canopycms/src/api/permissions.test.ts` (lines 169-185) and `/packages/canopycms/src/api/groups.test.ts` (lines 195-210) for complete examples.

### Expecting Console Messages

When testing code that intentionally logs to `console.error`, `console.warn`, or `console.log`, use the `mockConsole()` utility to:

1. Capture the messages for assertion
2. Prevent them from cluttering test output
3. Verify the expected message was logged

**Import the utility:**

```typescript
import { mockConsole } from './test-utils/console-spy.js'
```

**Basic usage:**

```typescript
it('logs error when something fails', () => {
  const consoleSpy = mockConsole()

  // Call code that logs to console
  doSomethingThatLogs()

  // Assert on specific messages
  expect(consoleSpy).toHaveErrored('Failed to do something')
  expect(consoleSpy).toHaveWarned('Deprecation warning')
  expect(consoleSpy).toHaveLogged('Debug info')

  // Always restore at the end
  consoleSpy.restore()
})
```

**Available matchers:**

- `toHaveErrored(pattern)` - matches `console.error` calls
- `toHaveWarned(pattern)` - matches `console.warn` calls
- `toHaveLogged(pattern)` - matches `console.log` calls

Patterns can be strings (substring match) or RegExp.

**Debugging captured messages:**

```typescript
const consoleSpy = mockConsole()
doSomething()
console.log('Captured:', consoleSpy.all()) // Shows all captured messages by method
consoleSpy.restore()
```

**Example from the codebase:**

```typescript
// From github-service.test.ts
it('should return null when token is missing', () => {
  const consoleSpy = mockConsole()
  const service = createGitHubService(mockConfig, 'https://github.com/owner/repo.git')
  expect(service).toBeNull()
  expect(consoleSpy).toHaveWarned('GitHub token not found')
  consoleSpy.restore()
})
```

This approach ensures:

- Expected console output doesn't pollute test runs
- Unexpected console output still surfaces (helping catch real issues)
- Console behavior is properly tested as part of the functionality

### Testing Context and Auth

When testing code that uses the context factory pattern:

**Testing Bootstrap Admin Groups**

```typescript
it('applies bootstrap admin groups to authenticated users', async () => {
  const config: CanopyConfig = {
    // ... config with bootstrapAdminIds: ['admin-123']
  }

  const mockUser: AuthenticatedUser = {
    type: 'authenticated',
    userId: 'admin-123',
    groups: [], // User has no groups yet
  }

  const context = createCanopyContext({
    config,
    getUser: async () => mockUser,
  })

  const canopy = await context.getContext()

  // Bootstrap admin should now have Admins group
  expect(canopy.user.groups).toContain('Admins')
})
```

**Testing Build Mode Bypass**

```typescript
it('returns BUILD_USER during static generation', async () => {
  process.env.NEXT_PHASE = 'phase-production-build'

  try {
    const mockUser: CanopyUser = { type: 'anonymous' }
    const context = createCanopyContext({
      config,
      getUser: async () => mockUser, // This should NOT be called
    })

    const canopy = await context.getContext()

    // Should bypass getUser and return BUILD_USER
    expect(canopy.user.userId).toBe('__build__')
    expect(canopy.user.groups).toContain('Admins')
  } finally {
    delete process.env.NEXT_PHASE
  }
})
```

**Testing Content Reader with Auth**

```typescript
it('enforces permissions when reading content', async () => {
  const restrictedUser: CanopyUser = {
    type: 'authenticated',
    userId: 'user-123',
    groups: [], // No groups = no access
  }

  const context = createCanopyContext({
    config: configWithRestrictedContent,
    getUser: async () => restrictedUser,
  })

  const canopy = await context.getContext()

  // Should throw permission error
  await expect(canopy.read({ entryPath: 'content/restricted' })).rejects.toThrow(
    'Permission denied',
  )
})
```

**Testing Anonymous vs Authenticated**

```typescript
it('handles anonymous users correctly', async () => {
  const context = createCanopyContext({
    config,
    getUser: async () => ANONYMOUS_USER,
  })

  const canopy = await context.getContext()

  expect(canopy.user.type).toBe('anonymous')
  expect(canopy.user.groups).toEqual([])
})
```

### API Client Generation

The TypeScript API client is auto-generated from the route registry. When you add new API endpoints:

**1. Define the endpoint with `defineEndpoint()`**

In your API module (e.g., `packages/canopycms/src/api/my-module.ts`):

```typescript
import { defineEndpoint } from './route-builder'

defineEndpoint({
  namespace: 'myModule',
  name: 'getSettings',
  method: 'GET',
  path: '/settings/:id',
  paramsSchema: z.object({ id: z.string() }),
  responseTypeName: 'SettingsResponse',
  defaultMockData: { ok: true, status: 200, data: { id: '123', name: 'Default' } },
})
```

**2. Add the module import to the generator script**

In `packages/canopycms/scripts/generate-client.ts`, add the module import:

```typescript
// Import all API modules to populate ROUTE_REGISTRY
import '../src/api/my-module.js' // Add this line
```

**3. Add namespace mapping (if needed)**

If your namespace doesn't match the filename, add a mapping in `namespaceToModule()`:

```typescript
function namespaceToModule(namespace: string): string {
  const mapping: Record<string, string> = {
    // ... existing mappings
    myModule: 'my-module', // Add this
  }
  return mapping[namespace] || namespace
}
```

**4. Generate the client**

```bash
npm run generate:client
```

This creates typed methods in `src/api/client.ts` and mock helpers in `src/api/__test__/mock-client.ts`.

**Usage in client code:**

```typescript
// Auto-generated and type-safe
const response = await client.myModule.getSettings({ id: '123' })
if (response.ok) {
  console.log(response.data) // Type: SettingsResponse
}
```

**Why this pattern:** The route registry eliminates regex parsing and keeps endpoint definitions close to implementations. All metadata (params, response types, mock data) flows through the registry into the generated client.

### Integration Testing with Framework Adapters

When testing framework-specific adapters:

**Next.js Adapter Testing**

```typescript
// Mock Next.js headers
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => ({
    get: (name: string) => {
      if (name === 'authorization') return 'Bearer valid-token'
      return null
    },
  })),
}))

it('extracts user from Next.js headers', async () => {
  const { getCanopy } = createNextCanopyContext({ config, authPlugin })
  const canopy = await getCanopy()

  expect(canopy.user.type).toBe('authenticated')
  expect(canopy.user.userId).toBe('expected-user-id')
})
```

**Testing Per-Request Caching**

```typescript
it('caches context per request with React cache()', async () => {
  const getUserSpy = vi.fn(async () => mockUser)

  const coreContext = createCanopyContext({
    config,
    getUser: getUserSpy,
  })

  const getCanopy = cache(() => coreContext.getContext())

  // Multiple calls in same request should use cache
  await getCanopy()
  await getCanopy()

  expect(getUserSpy).toHaveBeenCalledTimes(1) // Cached!
})
```

## Quality Checks

Before handoff, run typecheck and tests:

```bash
npm run typecheck --workspaces
npm test --workspaces
```

### Storybook

Update stories when UI changes. Run Storybook to verify:

```bash
npm run storybook --workspace=packages/canopycms
```

### Test Coverage

Add tests alongside new logic. Integration tests cover end-to-end behavior.

### Claude Subagents

For automated quality checks, see:

- `.claude/agents/test.md` - Test runner
- `.claude/agents/typecheck.md` - Type checker
- `.claude/agents/review.md` - Code review
