# API Development Guidelines for Agents

## Generated Files

- **Do not edit `client.ts` or `__test__/mock-client.ts` directly** - these files are auto-generated
- To modify the client, edit `packages/canopycms/scripts/generate-client.ts` and run `npm run generate:client`

## Branch Access Middleware

Use the middleware patterns from `middleware/branch-access.ts` for common access guard patterns:

```typescript
import {
  guardBranchAccess,
  guardBranchExists,
  isBranchAccessError,
} from '../middleware/branch-access'

// For operations that need both branch existence and user access
const branchAccess = guardBranchAccess(deps, context, user, branchName)
if (isBranchAccessError(branchAccess)) {
  return branchAccess // Returns 404 or 403 response
}
const { branch, branchRoot } = branchAccess

// For operations that only need branch existence (e.g., read operations)
const branchExists = guardBranchExists(deps, context, branchName)
if (isBranchAccessError(branchExists)) {
  return branchExists
}
```

## Adding New API Endpoints

When adding a new API endpoint with a request body, follow these steps to ensure full type safety:

1. **Export the body type** in the endpoint's module (e.g., `permissions.ts`, `comments.ts`)

   ```typescript
   export interface UpdatePermissionsBody {
     permissions: PathPermission[]
   }
   ```

2. **Add the `bodyType` field** to the `defineEndpoint()` call

   ```typescript
   const updatePermissions = defineEndpoint({
     namespace: 'permissions',
     name: 'update',
     method: 'PUT',
     path: '/permissions',
     body: updatePermissionsBodySchema, // Zod schema for runtime validation
     bodyType: 'UpdatePermissionsBody', // TypeScript type for codegen
     responseType: 'PermissionsResponse',
     response: {} as PermissionsResponse,
     handler: updatePermissionsHandler,
   })
   ```

3. **Regenerate the client** with `npm run generate:client`
   - The generated client will have typed methods like `update(body: UpdatePermissionsBody)` instead of `update(body: unknown)`

## Why Both `body` and `bodyType`?

- **`body`** (Zod schema) - Runtime validation of incoming requests
- **`bodyType`** (string) - Type name used by the code generator to create typed client methods
- This dual approach provides both compile-time type safety and runtime validation

## Finding Endpoints Missing Body Types

Search for endpoints with bodies but no `bodyType`:

```bash
# Find all endpoints with body schemas
grep -r "body: \w\+Schema" packages/canopycms/src/api/*.ts

# Check which have bodyType specified
grep -r "bodyType:" packages/canopycms/src/api/*.ts
```

Any endpoint with a `body` field but no `bodyType` field will generate a client method with `body: unknown`.
