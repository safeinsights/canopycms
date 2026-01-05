# Migration Plan: defineEndpoint Refactor

## Overview

Refactor API route definitions to use a declarative `defineEndpoint()` pattern with:
- Zod validation schemas for params and body
- Automatic route registration (no file parsing needed)
- Type-safe handlers with validated inputs
- Server-side validation before handlers run
- Trivial code generation (no regex parsing)

## Goals

1. **Type safety** - Handler parameters are validated and typed
2. **Runtime validation** - Server validates params/body with Zod
3. **Simple generation** - Generator reads from registry, no parsing
4. **Better DX** - Clear, declarative route definitions
5. **No breaking changes** - Migrate incrementally, one module at a time

## Architecture

### Before (Current)
```typescript
// branch.ts
export const deleteBranch = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: { branch: string }
): Promise<BranchDeleteResponse> => {
  // Manual validation
  if (!params.branch) return { ok: false, status: 400, error: 'branch required' }
  // ...
}

export const BRANCH_ROUTES = {
  delete: {
    method: 'DELETE' as const,
    pattern: [':branch'],
    buildPath: (branch: string) => `/${branch}`,
    handler: deleteBranch,
    response: {} as BranchDeleteResponse,
  },
} as const
```

**Generator:** Parses files with regex to extract metadata

### After (New)
```typescript
// branch.ts
import { defineEndpoint } from './route-builder'
import { z } from 'zod'

const deleteBranchSchema = z.object({ branch: z.string().min(1) })

export const deleteBranch = defineEndpoint({
  namespace: 'branches',
  name: 'delete',
  method: 'DELETE',
  path: '/:branch',
  params: deleteBranchSchema,
  responseType: 'BranchDeleteResponse',
  response: {} as BranchDeleteResponse,
  defaultMockData: { deleted: true },
  handler: async (ctx, req, params) => {
    // params.branch is validated and typed!
    // No manual validation needed
  }
})

export const BRANCH_ROUTES = {
  delete: deleteBranch,
  // ...
} as const
```

**Generator:** Reads from `ROUTE_REGISTRY` (no parsing!)

## Implementation Steps

### Phase 1: Foundation (No Breaking Changes)

#### Step 1.1: Create route-builder.ts
- [ ] Create `src/api/route-builder.ts` with:
  - `defineEndpoint()` function
  - `ROUTE_REGISTRY` global array
  - Type definitions for `RouteDefinition`, `RouteMetadata`
  - `validate()` function for server-side validation

**File:** `src/api/route-builder.ts`

#### Step 1.2: Update Router to Support Validation
- [ ] Modify `src/http/router.ts` to:
  - Accept routes with `validate()` method
  - Call `validate()` before invoking handler
  - Return validation errors as 400 responses
  - Backward compatible with old-style routes

**File:** `src/http/router.ts`

#### Step 1.3: Update Generator to Support Both Approaches
- [ ] Modify `scripts/generate-client.ts` to:
  - First check if `ROUTE_REGISTRY` has entries
  - If yes, use registry (new approach)
  - If no, fall back to regex parsing (old approach)
  - Support mixed mode (some modules old, some new)

**File:** `scripts/generate-client.ts`

**Deliverable:** Infrastructure in place, no modules migrated yet, all tests pass

### Phase 2: Migrate One Module (Proof of Concept)

#### Step 2.1: Migrate branch.ts
- [ ] Create Zod schemas for all branch route params/bodies
- [ ] Refactor handlers to use `defineEndpoint()`
- [ ] Export `defaultMockData` for each route
- [ ] Update `BRANCH_ROUTES` to reference defined endpoints
- [ ] Test that old and new routes work together

**File:** `src/api/branch.ts`

**Example:**
```typescript
// Schemas
const branchParamSchema = z.object({ branch: z.string().min(1) })
const createBranchBodySchema = z.object({
  name: z.string().min(1),
  baseBranch: z.string().optional(),
})

// Export mock data
export const mockBranchListData = { branches: [] }
export const mockBranchData = { branch: {} as BranchMetadata }
export const mockBranchDeleteData = { deleted: true }

// Define endpoints
export const listBranches = defineEndpoint({
  namespace: 'branches',
  name: 'list',
  method: 'GET',
  path: '/branches',
  responseType: 'BranchListResponse',
  response: {} as BranchListResponse,
  defaultMockData: mockBranchListData,
  handler: async (ctx, req) => { /* ... */ }
})

export const deleteBranch = defineEndpoint({
  namespace: 'branches',
  name: 'delete',
  method: 'DELETE',
  path: '/:branch',
  params: branchParamSchema,
  responseType: 'BranchDeleteResponse',
  response: {} as BranchDeleteResponse,
  defaultMockData: mockBranchDeleteData,
  handler: async (ctx, req, params) => { /* ... */ }
})

export const createBranch = defineEndpoint({
  namespace: 'branches',
  name: 'create',
  method: 'POST',
  path: '/branches',
  body: createBranchBodySchema,
  responseType: 'BranchResponse',
  response: {} as BranchResponse,
  defaultMockData: mockBranchData,
  handler: async (ctx, req, body) => { /* ... */ }
})

// Routes object (backward compatible)
export const BRANCH_ROUTES = {
  list: listBranches,
  delete: deleteBranch,
  create: createBranch,
  updateAccess: updateBranchAccess,
} as const
```

#### Step 2.2: Generate and Test
- [ ] Run `npm run generate:client`
- [ ] Verify client.ts and mock-client.ts are correct
- [ ] Run `npm run typecheck` - should pass
- [ ] Run `npm test` - should pass
- [ ] Manually test API endpoints

**Deliverable:** One module fully migrated, tests pass, generation works

### Phase 3: Migrate Remaining Modules

Migrate each module following the same pattern as branch.ts:

#### Step 3.1: Migrate branch-status.ts
- [ ] Create schemas
- [ ] Define endpoints
- [ ] Export mock data
- [ ] Test

#### Step 3.2: Migrate comments.ts
- [ ] Create schemas
- [ ] Define endpoints
- [ ] Export mock data
- [ ] Test

#### Step 3.3: Migrate content.ts
- [ ] Create schemas
- [ ] Define endpoints
- [ ] Export mock data
- [ ] Test

#### Step 3.4: Migrate entries.ts
- [ ] Create schemas
- [ ] Define endpoints
- [ ] Export mock data
- [ ] Test

#### Step 3.5: Migrate assets.ts
- [ ] Create schemas
- [ ] Define endpoints
- [ ] Export mock data
- [ ] Test

#### Step 3.6: Migrate permissions.ts
- [ ] Create schemas
- [ ] Define endpoints
- [ ] Export mock data
- [ ] Test

#### Step 3.7: Migrate groups.ts
- [ ] Create schemas
- [ ] Define endpoints
- [ ] Export mock data
- [ ] Test

**Deliverable:** All modules migrated, full test coverage

### Phase 4: Cleanup and Optimization

#### Step 4.1: Remove Old Generator Code
- [ ] Remove regex parsing logic from generator
- [ ] Remove `inferMockData()` function
- [ ] Remove hardcoded namespace mapping
- [ ] Simplify generator to only read registry

#### Step 4.2: Update Documentation
- [ ] Document `defineEndpoint()` usage in DEVELOPING.md
- [ ] Add examples of common patterns
- [ ] Document validation patterns
- [ ] Update ARCHITECTURE.md

#### Step 4.3: Add Generator Tests
- [ ] Test registry population
- [ ] Test client generation
- [ ] Test mock generation
- [ ] Test validation logic

**File:** `scripts/generate-client.test.ts`

**Deliverable:** Clean, maintainable codebase with documentation

## Detailed File Changes

### New Files

1. **src/api/route-builder.ts** (270 lines)
   - `defineEndpoint()` function
   - `ROUTE_REGISTRY` and types
   - Validation helpers

2. **scripts/generate-client.test.ts** (new)
   - Generator unit tests

### Modified Files

1. **src/http/router.ts** (~30 lines changed)
   - Add validation call before handler
   - Handle validation errors

2. **scripts/generate-client.ts** (~200 lines changed)
   - Replace regex parsing with registry reading
   - Simplify mock data generation
   - Remove hardcoded logic

3. **src/api/branch.ts** (~150 lines changed)
   - Add Zod schemas
   - Refactor to `defineEndpoint()`
   - Export mock data

4. **src/api/branch-status.ts** (~120 lines changed)
   - Same refactor pattern

5. **src/api/comments.ts** (~80 lines changed)
   - Same refactor pattern

6. **src/api/content.ts** (~60 lines changed)
   - Same refactor pattern

7. **src/api/entries.ts** (~40 lines changed)
   - Same refactor pattern

8. **src/api/assets.ts** (~80 lines changed)
   - Same refactor pattern

9. **src/api/permissions.ts** (~100 lines changed)
   - Same refactor pattern

10. **src/api/groups.ts** (~70 lines changed)
    - Same refactor pattern

### Generated Files (Auto-updated)

1. **src/api/client.ts**
   - Generated methods now have explicit types
   - No more `RouteArgs<typeof ...>` inference

2. **src/api/__test__/mock-client.ts**
   - Mock data from `defaultMockData` in definitions
   - No more `inferMockData()` guesswork

## Testing Strategy

### For Each Module Migration

1. **Before Migration**
   - Run full test suite: `npm test`
   - Run typecheck: `npm run typecheck`
   - Capture baseline

2. **After Migration**
   - Run generator: `npm run generate:client`
   - Run typecheck: `npm run typecheck` (should pass)
   - Run unit tests for that module
   - Run integration tests
   - Manual API testing

3. **Validation Testing**
   - Test invalid params (should get 400)
   - Test invalid body (should get 400)
   - Test valid requests (should work)

### Integration Tests

- [ ] Test mixed old/new routes
- [ ] Test generated client methods
- [ ] Test mock client in tests
- [ ] Test server-side validation
- [ ] Test error messages

## Rollback Plan

If issues arise during migration:

1. **Per-module rollback**: Git revert that module's changes
2. **Generator rollback**: Generator supports mixed mode, old modules keep working
3. **Full rollback**: Git revert entire branch, all old code still works

## Timeline Estimate

- **Phase 1 (Foundation):** 4-6 hours
- **Phase 2 (POC Migration):** 3-4 hours
- **Phase 3 (Remaining Modules):** 6-8 hours (1 hour per module average)
- **Phase 4 (Cleanup):** 2-3 hours

**Total:** 15-21 hours

## Success Criteria

- [ ] All 8 API modules using `defineEndpoint()`
- [ ] Generator reads from registry (no regex parsing)
- [ ] All tests passing
- [ ] TypeScript type checking passing
- [ ] Server validates params/body automatically
- [ ] Generated client has explicit types
- [ ] Mock data comes from route definitions
- [ ] Documentation updated
- [ ] No hardcoded logic in generator

## Benefits After Migration

1. **Type Safety**: Handler params are validated and typed
2. **Runtime Safety**: Invalid requests rejected before handler runs
3. **Better DX**: Clear, self-documenting route definitions
4. **Simpler Generator**: No regex parsing, no special cases
5. **Easier Testing**: Mock data defined alongside routes
6. **Maintainability**: Adding new routes is straightforward
7. **Validation**: Zod schemas provide runtime validation and docs

## Questions & Decisions

### Q: Should we validate on the client side too?
**A:** Not in this phase. Server-side validation is sufficient. Client-side can be added later.

### Q: What about routes with optional params?
**A:** Zod handles this: `z.object({ id: z.string().optional() })`

### Q: What about FormData uploads?
**A:** Use `body: undefined` and access `req.body` directly in handler. Zod validation skipped for FormData.

### Q: Can we share schemas between client and server?
**A:** Yes! Export the Zod schemas and use them for client-side validation too.

### Q: How do we handle body and params together (PATCH)?
**A:** Handler signature: `async (ctx, req, params, body) => ...`

### Q: What about routes that don't fit the pattern?
**A:** Keep using old-style route definitions for exceptional cases. Generator supports both.

## Next Steps

1. Review this plan
2. Get approval to proceed
3. Create a feature branch: `feature/defineEndpoint-refactor`
4. Start with Phase 1
5. Commit after each phase
6. Create PR when all phases complete
