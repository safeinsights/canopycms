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
  getUser: () => Promise<CanopyUser>  // Injected by adapter
}
```

Adapter provides the implementation:
```typescript
// packages/canopycms-next/src/user-extraction.ts
export function createNextUserExtractor(authPlugin: AuthPlugin) {
  return async (): Promise<CanopyUser> => {
    const headersList = await headers()  // Next.js-specific
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
    const user = await options.getUser()  // Adapter-provided
    // Apply bootstrap admin groups, create content reader, etc.
    return { read, services, user }
  }

  return {
    getContext,  // Call this per-request
    services,    // Shared across requests
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
       middleware: (req, res, next) => { /* ... */ },
       getContext: coreContext.getContext,
       services: coreContext.services,
     }
   }
   ```

3. **Keep adapters thin** - 10-20 lines for user extraction is ideal
4. **Export unified API** - hide framework details from adopters
5. **Add framework-specific optimizations** - caching, middleware, etc.

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
  slug: 'about'
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
  collections: z.array(z.string().min(1)).min(1),  // Which collections to reference
  displayField: z.string().min(1).optional(),       // Field to show as label
  options: z.array(referenceOptionSchema).optional(),  // For backward compatibility
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
        collections: ['authors'],  // Can only reference authors collection
        displayField: 'name',       // Show author's name field as label
      },
      {
        type: 'reference',
        name: 'relatedPosts',
        label: 'Related Posts',
        collections: ['posts'],     // Self-reference for related content
        displayField: 'title',      // Show post titles
        list: true,                 // Can reference multiple posts
      },
    ],
  },
  {
    type: 'collection',
    name: 'authors',
    fields: [
      { type: 'string', name: 'name', label: 'Author Name' },
    ],
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
      result[fieldName] = cached || fieldValue  // Use cache or keep ID
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
    setResolutionTrigger(prev => prev + 1)
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
    groups: [],  // User has no groups yet
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
      getUser: async () => mockUser,  // This should NOT be called
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
    groups: [],  // No groups = no access
  }

  const context = createCanopyContext({
    config: configWithRestrictedContent,
    getUser: async () => restrictedUser,
  })

  const canopy = await context.getContext()

  // Should throw permission error
  await expect(
    canopy.read({ entryPath: 'content/restricted' })
  ).rejects.toThrow('Permission denied')
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
import '../src/api/my-module.js'  // Add this line
```

**3. Add namespace mapping (if needed)**

If your namespace doesn't match the filename, add a mapping in `namespaceToModule()`:

```typescript
function namespaceToModule(namespace: string): string {
  const mapping: Record<string, string> = {
    // ... existing mappings
    'myModule': 'my-module',  // Add this
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
  console.log(response.data)  // Type: SettingsResponse
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

  expect(getUserSpy).toHaveBeenCalledTimes(1)  // Cached!
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
