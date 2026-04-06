# Provide non-request-scoped context from createNextCanopyContext

## Problem

`createNextCanopyContext` returns `getCanopy()` which is wrapped in React `cache()` and calls `headers()` internally via `extractUser()`. This works for server components and route handlers (which run within a request scope), but fails for Next.js build-time functions:

- `generateStaticParams` — runs outside request scope in dev mode
- `generateMetadata` — can run outside request scope during static generation
- Navigation building in layouts — may run at build time

The error:

```
Error: `headers` was called outside a request scope.
```

In static builds (`deployedAs: 'static'`) this doesn't happen because `isDeployedStatic()` returns `STATIC_DEPLOY_USER` without calling `headers()`. But in dev mode with `deployedAs: 'server'`, it falls through to `extractUser()` → `headers()`.

## Current workaround (in docs-site-proto)

Adopters must import `createCanopyContext` and `STATIC_DEPLOY_USER` from `canopycms/server` and wire up their own non-request-scoped context:

```ts
import { createCanopyContext, STATIC_DEPLOY_USER } from 'canopycms/server'

export const getCanopyForBuild = async () => {
  const { services } = await canopyContextPromise
  const ctx = createCanopyContext({
    services,
    extractUser: async () => STATIC_DEPLOY_USER,
  })
  return ctx.getContext()
}
```

This leaks Canopy internals (`createCanopyContext`, `STATIC_DEPLOY_USER`, `services`) into app code.

## Proposed fix

Have `createNextCanopyContext` return a second accessor:

```ts
const context = await createNextCanopyContext({ ... });

context.getCanopy()          // existing: request-scoped, uses headers() + cache()
context.getCanopyForBuild()  // new: uses STATIC_DEPLOY_USER, no headers()
```

Implementation in `context-wrapper.ts`:

```ts
const buildContext = createCanopyContext({
  services,
  extractUser: async () => STATIC_DEPLOY_USER,
})

return {
  getCanopy, // existing
  getCanopyForBuild: () => buildContext.getContext(), // new
  handler,
  services,
}
```

## Verify

After fixing, docs-site-proto can replace its manual workaround with:

```ts
export const getCanopyForBuild = async () => {
  const context = await canopyContextPromise
  return context.getCanopyForBuild()
}
```
