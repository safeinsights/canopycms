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
