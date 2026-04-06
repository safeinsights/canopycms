# withCanopy can't be imported from next.config.ts

## Problem

`withCanopy` is exported from `canopycms-next`, but `canopycms-next` only has `"import"` conditions in its package.json exports:

```json
{
  ".": {
    "import": "./dist/index.js",
    "types": "./dist/index.d.ts"
  }
}
```

`next.config.ts` is loaded by Next.js in a context that attempts CJS resolution. Without a `"require"` condition, the import fails:

```
Error: No "exports" main defined in .../canopycms-next/package.json
  code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
```

This means adopters can't use `withCanopy` in their Next.js config — the one place it's designed to be used.

## Fix options

1. **Add a CJS export condition** — build `withCanopy` (and its dependencies) as CJS alongside the ESM dist. Since `withCanopy` only uses Node builtins (`node:module`, `node:path`) and no React/Next.js server APIs, a CJS build is straightforward.

2. **Separate entry point** — add a `"./config"` export that only includes `withCanopy`, built as CJS:

   ```json
   "./config": {
     "require": "./dist/with-canopy.cjs",
     "import": "./dist/with-canopy.js",
     "types": "./dist/with-canopy.d.ts"
   }
   ```

3. **Dual format for the main entry** — add `"require"` to the `"."` export. This is broader but means the entire package works in both contexts.

Option 2 is cleanest — `withCanopy` has no overlap with the server-side exports (React cache, headers, etc.), so a dedicated config entry point avoids pulling in incompatible code.

## Verify

After fixing, this should work in a Next.js project's `next.config.ts`:

```ts
import { withCanopy } from 'canopycms-next' // option 3
// or
import { withCanopy } from 'canopycms-next/config' // option 2

export default withCanopy(nextConfig, { staticBuild: true })
```

The docs-site-proto currently has the manual equivalent inline in next.config.ts (transpilePackages + pageExtensions) and can switch to `withCanopy` once this is fixed.
