# API Development Guidelines for Agents

## Generated Files

- **Do not edit `client.ts` or `__test__/mock-client.ts` directly** - these files are auto-generated
- To modify the client, edit `packages/canopycms/scripts/generate-client.ts` and run `pnpm run generate:client`

## Declarative Guards

Use the `guards` array in `defineEndpoint()` for access control and context loading. Guards run before the handler and provide typed context via the `gc` first argument.

```typescript
// Branch access + schema loading
const getSchema = defineEndpoint({
  guards: ['branchAccessWithSchema'] as const,
  handler: async (gc, ctx, req, params) => {
    const { branchContext } = gc // BranchContextWithSchema — flatSchema guaranteed
  },
})

// Role guard + branch loading
const createCollection = defineEndpoint({
  guards: ['admin', 'branch'] as const,
  handler: async (gc, ctx, req, params, body) => {
    const { branchContext } = gc // BranchContext — admin access already verified
  },
})
```

Available guards: `branch`, `branchAccess`, `schema`, `branchAccessWithSchema`, `admin`, `reviewer`, `privileged`. See `guards.ts` for details.

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

3. **Regenerate the client** with `pnpm run generate:client`
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
