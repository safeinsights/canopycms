# CanopyCMS Development Guide

This guide covers the development workflow, testing architecture, and common patterns for contributing to CanopyCMS.

## Table of Contents

- [Development Setup](#development-setup)
- [Testing Architecture](#testing-architecture)
  - [Layer 1: API Unit Tests](#layer-1-api-unit-tests)
  - [Layer 2: API Integration Tests](#layer-2-api-integration-tests)
  - [Layer 3: Hook Tests](#layer-3-hook-tests)
- [Testing Utilities](#testing-utilities)
- [Common Patterns](#common-patterns)

## Development Setup

### Prerequisites

- Node.js 18+ and npm
- Git

### Installation

```bash
npm install
```

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run specific test file
npx vitest src/api/comments.test.ts

# Run integration tests only
npx vitest src/__integration__
```

### Type Checking

```bash
npm run typecheck
```

### Building

```bash
npm run build
```

## Testing Architecture

CanopyCMS uses a three-layer testing strategy where each layer tests different concerns. This architecture ensures comprehensive coverage without duplication while maintaining fast test execution.

### Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│         LAYER 3: HOOK TESTS                         │
│         (useBranchActions.test.tsx, etc.)           │
│  Tests: State management, API calls, modals        │
│  Mocks: ApiClient, @mantine, window.location       │
│  Speed: Very fast (<100ms each)                    │
└─────────────────────────────────────────────────────┘
                        ↓
                    ApiClient (domain layer)
                        ↓
┌─────────────────────────────────────────────────────┐
│    LAYER 2: API INTEGRATION TESTS                   │
│    (__integration__/workflows/*.test.ts)            │
│  Tests: Full cycles, multi-user, HTTP workflows    │
│  Mocks: AuthPlugin only (real file system & git)   │
│  Speed: Slow (~500ms+ each, file I/O)              │
└─────────────────────────────────────────────────────┘
                        ↓
                  HTTP Handler Layer
                        ↓
┌─────────────────────────────────────────────────────┐
│    LAYER 1: API UNIT TESTS                          │
│    (api/comments.test.ts, api/groups.test.ts, etc.) │
│  Tests: Validation, permissions, business logic     │
│  Mocks: All stores, managers, services             │
│  Speed: Fast (~100ms each)                         │
└─────────────────────────────────────────────────────┘
```

### When to Use Each Layer

| What You're Testing           | API Unit | Integration | Hook |
| ----------------------------- | -------- | ----------- | ---- |
| Input validation (each field) | ✓        | Partial     | ✗    |
| Permission logic details      | ✓        | ✓ E2E       | ✗    |
| Business rules                | ✓        | ✓ E2E       | ✗    |
| HTTP workflows                | ✗        | ✓           | ✗    |
| Multi-user scenarios          | ✗        | ✓           | ✗    |
| Real file system              | ✗        | ✓           | ✗    |
| Hook state                    | ✗        | ✗           | ✓    |
| API client calls              | ✗        | ✗           | ✓    |
| UI interactions               | ✗        | ✗           | ✓    |

### Layer 1: API Unit Tests

**Location:** `src/api/*.test.ts` (12 files, 2,878 LOC)

**Purpose:** Test validation, permissions, and business logic in isolation.

**What They Test:**

- Input validation (400 errors: missing fields, invalid types)
- Permission enforcement logic (403 errors: ACL checks)
- Business rules (who can resolve comments, delete branches, etc.)
- Error responses (404, 400, 403, 500)

**What They Mock:**

- `CommentStore`, `ContentStore`, `BranchWorkspaceManager`
- `BranchMetadataFileManager`, `GitManager`
- `checkBranchAccess`, `checkContentAccess`
- `permissionsLoader`, `groupsLoader`

**Example:** Testing comment API validation

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { addComment } from './comments'

describe('addComment', () => {
  let mockStore: any
  let mockCheckAccess: any

  beforeEach(() => {
    mockStore = {
      addComment: vi.fn(),
      getThread: vi.fn(),
    }
    mockCheckAccess = vi.fn().mockResolvedValue(true)
  })

  it('rejects missing text field', async () => {
    const result = await addComment({
      store: mockStore,
      checkBranchAccess: mockCheckAccess,
      branch: 'main',
      body: { type: 'branch' }, // missing text
      userId: 'user1',
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
    expect(result.error).toContain('text')
  })

  it('enforces write permission', async () => {
    mockCheckAccess.mockResolvedValue(false)

    const result = await addComment({
      store: mockStore,
      checkBranchAccess: mockCheckAccess,
      branch: 'main',
      body: { text: 'Great!', type: 'branch' },
      userId: 'user1',
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
  })
})
```

**Speed:** ~100ms per test (no I/O)

### Layer 2: API Integration Tests

**Location:** `src/__integration__/workflows/*.test.ts`, `src/__integration__/errors/*.test.ts` (8+ files)

**Purpose:** Test complete workflows through HTTP handler with real file system and git.

**What They Test:**

- Complete workflows: Create → Edit → Submit → Approve
- Multi-user concurrent operations
- Permission enforcement at HTTP boundary (403 responses)
- Real git operations and file persistence
- HTTP contract compliance (status codes, response shapes)

**What They Mock:**

- `AuthPlugin` only (to control user identity/groups)
- Everything else is real: file system, git, stores, business logic

**Example:** Testing full editing workflow

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestWorkspace } from '../test-utils/workspace'
import { createApiClient, createMockAuthPlugin } from '../test-utils/api-client'

describe('Editing Workflow', () => {
  let workspace: Awaited<ReturnType<typeof createTestWorkspace>>
  let authPlugin: ReturnType<typeof createMockAuthPlugin>
  let client: ReturnType<typeof createApiClient>

  beforeEach(async () => {
    workspace = await createTestWorkspace()
    authPlugin = createMockAuthPlugin({ userId: 'editor1', groups: ['editors'] })
    client = createApiClient(workspace.handler, authPlugin)
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('completes create → edit → submit → approve cycle', async () => {
    // Create branch
    const branch = await client.branches.create({
      branch: 'feature/new-post',
      title: 'New Blog Post',
    })
    expect(branch.ok).toBe(true)

    // Write content
    const content = await client.content.write('feature/new-post', 'posts', 'hello-world', {
      collection: 'posts',
      slug: 'hello-world',
      format: 'mdx',
      data: { title: 'Hello World' },
      body: '# Hello\n\nThis is my first post.',
    })
    expect(content.ok).toBe(true)

    // Submit for review
    const submit = await client.workflow.submit('feature/new-post', {
      message: 'Ready for review',
    })
    expect(submit.ok).toBe(true)

    // Switch to reviewer
    authPlugin.setUser({ userId: 'reviewer1', groups: ['reviewers'] })

    // Approve
    const approve = await client.workflow.approve('feature/new-post', {
      message: 'Looks good!',
    })
    expect(approve.ok).toBe(true)

    // Verify branch metadata updated
    const branches = await client.branches.list()
    const featureBranch = branches.data?.branches.find((b) => b.name === 'feature/new-post')
    expect(featureBranch?.workflow?.status).toBe('approved')
  })
})
```

**Speed:** ~500ms+ per test (real file I/O, git operations)

### Layer 3: Hook Tests

**Location:** `src/editor/hooks/*.test.tsx` (8+ files)

**Purpose:** Test React hook state management and UI interactions.

**What They Test:**

- Hook state management (drafts in localStorage)
- ApiClient method calls (which methods called, with what arguments)
- UI error handling (notifications, modals)
- User interactions (branch switching, confirmations)
- URL synchronization with browser history

**What They Mock:**

- `ApiClient` via `createMockApiClient()` (domain layer)
- `@mantine/notifications`, `@mantine/modals`
- `window.location`, `window.history`

**Why Mock ApiClient, Not Fetch:**

- Hooks use `ApiClient` abstraction, not `fetch` directly
- Tests should verify behavior (method calls) not implementation (URLs)
- More resilient to URL changes
- Faster (no transport layer simulation)
- Clearer test intent

**Example:** Testing branch actions hook

```typescript
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useBranchActions, resetApiClient } from './useBranchActions'
import type { MockApiClient } from '../../api/__test__/mock-client'
import { setupMockApiClient } from './__test__/test-utils'

// Mock the API client module
vi.mock('../../api', async () => {
  const actual = await vi.importActual('../../api')
  return {
    ...actual,
    createApiClient: vi.fn(),
  }
})

// Mock Mantine modals
vi.mock('@mantine/modals', () => ({
  modals: {
    openConfirmModal: vi.fn(),
  },
}))

describe('useBranchActions', () => {
  let mockClient: MockApiClient

  beforeEach(async () => {
    mockClient = await setupMockApiClient()
    resetApiClient()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('switches branches when user confirms', async () => {
    const setBranchName = vi.fn()
    const isSelectedDirty = vi.fn().mockReturnValue(true)
    const onReloadBranches = vi.fn()

    // Mock user confirming the modal
    const { modals } = await import('@mantine/modals')
    vi.mocked(modals.openConfirmModal).mockImplementation((config: any) => {
      config.onConfirm()
    })

    const { result } = renderHook(() =>
      useBranchActions({
        branchName: 'main',
        setBranchName,
        isSelectedDirty,
        onReloadBranches,
      }),
    )

    await result.current.handleBranchChange('feature/test')

    expect(setBranchName).toHaveBeenCalledWith('feature/test')
    expect(modals.openConfirmModal).toHaveBeenCalled()
  })

  it('creates branch and switches to it', async () => {
    mockClient.branches.create.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        branch: {
          name: 'feature/new',
          status: 'editing',
          access: { allowedUsers: [], allowedGroups: [] },
          createdBy: 'user1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    })

    const setBranchName = vi.fn()
    const isSelectedDirty = vi.fn().mockReturnValue(false)
    const onReloadBranches = vi.fn()

    const { result } = renderHook(() =>
      useBranchActions({
        branchName: 'main',
        setBranchName,
        isSelectedDirty,
        onReloadBranches,
      }),
    )

    await act(async () => {
      await result.current.handleCreateBranch({
        name: 'feature/new',
        title: 'New Feature',
      })
    })

    // Assert on domain behavior, not URL details
    expect(mockClient.branches.create).toHaveBeenCalledWith({
      branch: 'feature/new',
      title: 'New Feature',
    })
    expect(onReloadBranches).toHaveBeenCalled()
    expect(setBranchName).toHaveBeenCalledWith('feature/new')
  })
})
```

**Speed:** <100ms per test (no I/O, mocked ApiClient)

### Why All Three Layers Are Necessary

Each layer tests different concerns with different trade-offs:

**API Unit Tests:**

- Exhaustively test each validation rule independently (e.g., 15+ tests for different missing fields)
- Test permission logic details (e.g., who can resolve comments)
- Fast feedback loop for business logic changes
- No need to set up file system or HTTP handler

**API Integration Tests:**

- Catch issues that only appear when components interact
- Verify HTTP contracts (status codes, response shapes)
- Test real git operations and file persistence
- Multi-user scenarios (e.g., concurrent edits, permission changes)
- More confidence that the system works end-to-end

**Hook Tests:**

- Test React-specific concerns (state, effects, refs)
- Verify correct ApiClient methods are called with correct arguments
- Test UI interactions (confirmations, notifications)
- Fast tests for UI logic without needing backend

**No significant duplication** - each layer focuses on different failure modes.

## Testing Utilities

### `mockConsole`

Captures console output during tests for assertion.

**Location:** `src/__integration__/test-utils/console.ts`

**Usage:**

```typescript
import { mockConsole } from '../test-utils/console'

it('logs warning on invalid input', async () => {
  const restore = mockConsole()

  await someFunction()

  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('invalid'))
  restore()
})
```

### `createTestWorkspace`

Creates a temporary git workspace for integration tests.

**Location:** `src/__integration__/test-utils/workspace.ts`

**Features:**

- Initializes git repository with main branch
- Creates test content and config
- Provides cleanup function
- Includes HTTP handler configured for workspace

**Usage:**

```typescript
import { createTestWorkspace } from '../test-utils/workspace'

let workspace: Awaited<ReturnType<typeof createTestWorkspace>>

beforeEach(async () => {
  workspace = await createTestWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

it('creates content in workspace', async () => {
  // workspace.path - temporary directory path
  // workspace.handler - HTTP handler for this workspace
  // workspace.cleanup() - removes temporary directory
})
```

### `createApiClient`

Creates a typed API client for integration tests.

**Location:** `src/__integration__/test-utils/api-client.ts`

**Features:**

- Routes requests through HTTP handler (no network calls)
- Full TypeScript type safety
- Works with mock AuthPlugin for multi-user testing

**Usage:**

```typescript
import { createApiClient, createMockAuthPlugin } from '../test-utils/api-client'

const authPlugin = createMockAuthPlugin({ userId: 'editor1', groups: ['editors'] })
const client = createApiClient(workspace.handler, authPlugin)

// Typed API calls
const branches = await client.branches.list()
const content = await client.content.read('main', 'posts', 'hello')

// Switch user mid-test
authPlugin.setUser({ userId: 'reviewer1', groups: ['reviewers'] })
const approve = await client.workflow.approve('feature/test', { message: 'LGTM' })
```

### `createMockAuthPlugin`

Creates a mock AuthPlugin for testing with different users.

**Location:** `src/__integration__/test-utils/api-client.ts`

**Features:**

- Set user ID and groups
- Switch users mid-test
- Control permissions for multi-user scenarios

**Usage:**

```typescript
import { createMockAuthPlugin } from '../test-utils/api-client'

const authPlugin = createMockAuthPlugin({
  userId: 'editor1',
  groups: ['editors'],
})

// Later, switch to different user
authPlugin.setUser({
  userId: 'reviewer1',
  groups: ['reviewers'],
})
```

### `createMockApiClient`

Creates a typed mock of the CanopyApiClient for hook tests.

**Location:** `src/api/__test__/mock-client.ts`

**Features:**

- All methods return successful responses by default
- Override specific methods as needed in tests
- Fully typed to match CanopyApiClient interface
- Mock methods with `mockResolvedValue()` / `mockResolvedValueOnce()`

**Usage:**

```typescript
import { createMockApiClient } from '../../api/__test__/mock-client'
import type { CanopyApiClient } from '../../api/client'
import { vi } from 'vitest'

// Mock the API module
vi.mock('../../api', async () => {
  const actual = await vi.importActual('../../api')
  return {
    ...actual,
    createApiClient: vi.fn(),
  }
})

let mockClient: ReturnType<typeof createMockApiClient>

beforeEach(async () => {
  const { createApiClient } = await import('../../api')
  mockClient = createMockApiClient()
  vi.mocked(createApiClient).mockReturnValue(mockClient as unknown as CanopyApiClient)
  resetApiClient() // Reset singleton
})

// Override specific method responses
mockClient.branches.list.mockResolvedValueOnce({
  ok: true,
  status: 200,
  data: { branches: [...] },
})

// Assert on method calls
expect(mockClient.branches.create).toHaveBeenCalledWith({
  branch: 'feature/test',
  title: 'Test Feature',
})
```

### Hook Test Utilities

The following utilities eliminate common test setup duplication in hook tests.

**Location:** `src/editor/hooks/__test__/test-utils.ts`

#### `setupMockApiClient()`

Creates and injects a mock API client into the module system.

**Features:**

- Automatically creates mock client with `createMockApiClient()`
- Injects it into the `createApiClient` factory
- Returns typed mock client for test assertions
- Should be paired with `resetApiClient()` in tests

**Usage:**

```typescript
import { setupMockApiClient } from './__test__/test-utils'
import { resetApiClient } from './useMyHook'
import type { MockApiClient } from '../../api/__test__/mock-client'

let mockClient: MockApiClient

beforeEach(async () => {
  mockClient = await setupMockApiClient()
  resetApiClient()
})

it('calls API methods', async () => {
  mockClient.branches.list.mockResolvedValueOnce({
    ok: true,
    status: 200,
    data: { branches: [] },
  })

  // Test code that uses the API client
})
```

#### `setupMockConsole(methods?)`

Mocks console methods with automatic cleanup.

**Parameters:**

- `methods` - Array of console methods to mock (default: `['error']`)
  - Options: `'error' | 'warn' | 'log' | 'info' | 'debug'`

**Returns:**

- Object with mocked console methods + `restore()` function
- Each method is a Vitest spy that can be asserted on

**Features:**

- Silences console output during tests
- Allows assertions on console calls
- Auto-restore with `restore()` function
- Prevents test pollution from console spies

**Usage:**

```typescript
import { setupMockConsole } from './__test__/test-utils'

it('logs error on failure', async () => {
  const { error, restore } = setupMockConsole(['error'])

  await functionThatLogsError()

  expect(error).toHaveBeenCalledWith(expect.stringContaining('failed'))
  restore()
})

it('captures multiple console methods', () => {
  const { error, warn, log, restore } = setupMockConsole(['error', 'warn', 'log'])

  // Test code that uses console
  console.error('error message')
  console.warn('warning message')

  expect(error).toHaveBeenCalled()
  expect(warn).toHaveBeenCalled()
  restore()
})
```

#### `setupMockLocation(options?)`

Mocks `window.location` for tests that read or modify the URL.

**Parameters:**

- `options.href` - Full URL (default: `'http://localhost/'`)
- `options.search` - Query string (default: `''`)

**Returns:**

- Restore function to reset original location

**Features:**

- Replaces `window.location` with mock object
- Allows tests to read/write location properties
- Returns cleanup function for teardown

**Usage:**

```typescript
import { setupMockLocation } from './__test__/test-utils'

beforeEach(() => {
  setupMockLocation({ search: '?entry=entry1&branch=main' })
})

it('reads entry from URL', () => {
  const { result } = renderHook(() => useMyHook())

  expect(result.current.selectedId).toBe('entry1')
})
```

#### `setupMockHistory()`

Mocks `window.history.replaceState` for testing URL synchronization.

**Returns:**

- Mock function for `window.history.replaceState`

**Features:**

- Allows tests to verify URL updates
- Returns spy for assertions
- Commonly used with `setupMockLocation`

**Usage:**

```typescript
import { setupMockLocation, setupMockHistory } from './__test__/test-utils'

beforeEach(() => {
  setupMockLocation()
  setupMockHistory()
})

it('updates URL when selection changes', () => {
  const { result } = renderHook(() => useMyHook())

  act(() => {
    result.current.setSelectedId('entry2')
  })

  expect(window.history.replaceState).toHaveBeenCalled()
  const calls = (window.history.replaceState as any).mock.calls
  const urlCall = calls.find((call: any) => call[2].includes('entry=entry2'))
  expect(urlCall).toBeTruthy()
})
```

#### Complete Hook Test Setup Example

```typescript
import { renderHook, act } from '@testing-library/react'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { useMyHook, resetApiClient } from './useMyHook'
import type { MockApiClient } from '../../api/__test__/mock-client'
import { setupMockApiClient, setupMockLocation, setupMockHistory } from './__test__/test-utils'

// Mock the API client module
vi.mock('../../api', async () => {
  const actual = await vi.importActual('../../api')
  return {
    ...actual,
    createApiClient: vi.fn(),
  }
})

describe('useMyHook', () => {
  let mockClient: MockApiClient

  beforeEach(async () => {
    mockClient = await setupMockApiClient()
    resetApiClient()

    setupMockLocation()
    setupMockHistory()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('loads data successfully', async () => {
    mockClient.branches.list.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { branches: [] },
    })

    const { result } = renderHook(() => useMyHook())

    await waitFor(() => {
      expect(result.current.branches).toEqual([])
    })

    expect(mockClient.branches.list).toHaveBeenCalled()
  })
})
```

## Common Patterns

### Testing with Different User Roles

```typescript
it('restricts access by role', async () => {
  // Start as editor
  const authPlugin = createMockAuthPlugin({ userId: 'editor1', groups: ['editors'] })
  const client = createApiClient(workspace.handler, authPlugin)

  // Editor can create branch
  const create = await client.branches.create({ branch: 'feature/test' })
  expect(create.ok).toBe(true)

  // Switch to read-only user
  authPlugin.setUser({ userId: 'viewer1', groups: ['viewers'] })

  // Viewer cannot approve
  const approve = await client.workflow.approve('feature/test', { message: 'Approved' })
  expect(approve.ok).toBe(false)
  expect(approve.status).toBe(403)
})
```

### Testing API Validation

```typescript
it('validates required fields', async () => {
  const result = await apiFunction({
    store: mockStore,
    branch: 'main',
    body: {}, // Missing required fields
    userId: 'user1',
  })

  expect(result.ok).toBe(false)
  expect(result.status).toBe(400)
  expect(result.error).toContain('required field name')
})
```

### Testing Complete Workflows

```typescript
it('completes approval workflow', async () => {
  const authPlugin = createMockAuthPlugin({ userId: 'editor1', groups: ['editors'] })
  const client = createApiClient(workspace.handler, authPlugin)

  // 1. Create branch
  await client.branches.create({ branch: 'feature/test' })

  // 2. Add content
  await client.content.write('feature/test', 'posts', 'test', {
    collection: 'posts',
    slug: 'test',
    format: 'mdx',
    data: { title: 'Test' },
    body: 'Content',
  })

  // 3. Submit
  await client.workflow.submit('feature/test', { message: 'Ready' })

  // 4. Switch to reviewer
  authPlugin.setUser({ userId: 'reviewer1', groups: ['reviewers'] })

  // 5. Approve
  const approve = await client.workflow.approve('feature/test', { message: 'LGTM' })
  expect(approve.ok).toBe(true)

  // 6. Verify state
  const branches = await client.branches.list()
  const branch = branches.data?.branches.find((b) => b.name === 'feature/test')
  expect(branch?.workflow?.status).toBe('approved')
})
```

### Testing Hook State Management

```typescript
it('manages draft state in localStorage', async () => {
  const { result } = renderHook(() =>
    useDraftManager({
      branchName: 'main',
      selectedId: 'entry1',
    }),
  )

  // Initial state
  expect(result.current.getDraft('entry1')).toBeUndefined()

  // Save draft
  act(() => {
    result.current.saveDraft('entry1', { title: 'Draft Title' })
  })

  expect(result.current.getDraft('entry1')).toEqual({ title: 'Draft Title' })
  expect(result.current.isDirty('entry1')).toBe(true)

  // Clear draft
  act(() => {
    result.current.clearDraft('entry1')
  })

  expect(result.current.getDraft('entry1')).toBeUndefined()
  expect(result.current.isDirty('entry1')).toBe(false)
})
```

### Testing ApiClient Calls

```typescript
import { setupMockApiClient } from './__test__/test-utils'
import { resetApiClient } from './useMyHook'
import type { MockApiClient } from '../../api/__test__/mock-client'

describe('useMyHook', () => {
  let mockClient: MockApiClient

  beforeEach(async () => {
    mockClient = await setupMockApiClient()
    resetApiClient()
  })

  it('calls API with correct parameters', async () => {
    // Mock the response
    mockClient.content.write.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { format: 'mdx', data: { field: 'value' }, body: '' },
    })

    const { result } = renderHook(() => useMyHook())

    await result.current.saveData({ field: 'value' })

    // Assert on domain behavior, not transport details
    expect(mockClient.content.write).toHaveBeenCalledWith('main', 'posts', 'my-post', {
      collection: 'posts',
      slug: 'my-post',
      format: 'mdx',
      data: { field: 'value' },
      body: '',
    })
  })
})
```

## Contributing

When adding new features or fixing bugs:

1. **Add API unit tests** for new validation rules or business logic
2. **Add integration tests** for new workflows or multi-step operations
3. **Add hook tests** if you're modifying React hooks
4. **Run full test suite** before submitting PR: `npm test`
5. **Run type checking**: `npm run typecheck`

All three layers should pass for a complete feature.
