# Two sources of truth for "what endpoints exist", with no parity check

## Priority: P2 — cheap fix, silent-404 failure class

Found 2026-08-23 by the [baseline structural evaluation](../../docs/reviews/2026-08-structure.md).

## Problem

There are two independent registries of the API surface:

1. `ROUTE_REGISTRY` (`api/route-builder.ts:48`), populated by `defineEndpoint`, and
   consumed by `packages/canopycms/scripts/generate-client.ts` to emit the typed client.
2. `buildCanopyRoutes()` (`http/router.ts:86-116`), assembled from **14
   hand-maintained `*_ROUTES` const maps**, and used to actually dispatch requests.

**They agree today** — 53 `defineEndpoint` calls, 53 route-map entries — and CI does
verify that `client.ts` regenerates clean. But **nothing asserts the two registries
match**.

So a new endpoint added via `defineEndpoint` but omitted from its module's
`*_ROUTES` map ships a **typed client method that 404s at runtime, with green CI**.
The client compiles, the codegen check passes (the generated file is consistent with
the registry it was generated from), and only a real request finds out.

## Fix

A test, ~20 lines:

```ts
const registry = getAllRoutes()
const router = createCanopyRouter()
expect(router.routes.length).toBe(registry.length)
for (const r of registry) {
  expect(router.routes.some((x) => x.method === r.method && x.path === r.path)).toBe(true)
}
```

Break-and-rerun it: delete one entry from a `*_ROUTES` map and confirm it fails.

## Not in scope

`http/router.ts:33` declares a second, untyped `RouteDefinition` whose handler is
`CanopyHandler = (...args: any[]) => …` (`:27`), and `:104-115` converts the typed
one into it with `'validate' in route ? (route.validate as …)`, erasing every type
the builder computed. That is a much larger refactor with a real design question
behind it (the arities genuinely differ), and it is not what causes the silent 404.
Recorded here so it is not re-raised as a finding.

## Related

- [api-response-constructors.md](api-response-constructors.md)
