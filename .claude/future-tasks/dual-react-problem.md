# Problem: Dual React instances when consuming canopycms via `file:` references

## Symptom

When a Next.js app uses canopycms packages via `file:` references (e.g., `"canopycms": "file:../canopycms/packages/canopycms"`) and imports client-side hooks like `useCanopyPreview` from `canopycms/client`, React hooks crash at runtime:

```
Invalid hook call. Hooks can only be called inside of the body of a function component.
TypeError: Cannot read properties of null (reading 'useState')
```

This happens because **two copies of React are loaded**: the consumer app's React 19 and the canopycms monorepo's React 18.

## Root cause

1. The canopycms library packages correctly declare React as a `peerDependency` (`^18.0.0 || ^19.0.0`)
2. The example apps (`apps/example1`, `apps/test-app`) depend on `"react": "^18.3.1"` as a direct dependency
3. npm hoists React 18.3.1 to `canopycms/node_modules/react/`
4. When a consumer uses `file:` references + `transpilePackages`, the bundler follows the symlink to the real file path inside the canopycms monorepo, then resolves `import React from 'react'` by walking up from there — finding `canopycms/node_modules/react@18` before the consumer's `node_modules/react@19`
5. This results in two React instances: hooks registered with one, rendered with the other → crash

This affects **both webpack and Turbopack**, though webpack can be worked around with `resolve.alias`. Turbopack's `resolveAlias` with absolute file paths appears unreliable (paths get treated as relative in some configurations).

## Who is affected

Any external project consuming canopycms packages via `file:` symlinks during local development. The example1 app is unaffected because it lives inside the monorepo and shares the same hoisted React.

## Proposed fix: `withCanopy()` Next.js config plugin in `canopycms-next`

Add a config wrapper that consumers use in their `next.config.ts`:

```ts
// consumer's next.config.ts
import { withCanopy } from 'canopycms-next/config'

export default withCanopy({
  // their normal Next.js config
})
```

The plugin would:

1. **Add `transpilePackages`** for all canopy packages (so consumers don't need to know the list)
2. **Add React aliases** for both webpack and Turbopack, resolving to the consumer's React:

```ts
// Inside withCanopy — require.resolve runs in the consumer's context
// since next.config.ts is evaluated from the consumer's project root
const reactAlias = {
  react: require.resolve('react'),
  'react/jsx-runtime': require.resolve('react/jsx-runtime'),
  'react/jsx-dev-runtime': require.resolve('react/jsx-dev-runtime'),
  'react-dom': require.resolve('react-dom'),
  'react-dom/client': require.resolve('react-dom/client'),
}
```

This automatically uses whatever React version the consumer has installed (as long as it meets the peer dep range), and works with both webpack and Turbopack.

## Open question

Turbopack's `resolveAlias` with absolute file paths may not work reliably — we saw it prepend `./` to absolute paths when `turbopack.root` was set. **We need to verify that the alias actually takes effect with Turbopack before committing to this approach.** The current docs-site-proto branch has the alias configured; testing is needed.

## Files involved

- **canopycms side:** `packages/canopycms-next/src/` — where `withCanopy()` would be added
- **consumer side:** `next.config.ts` — would simplify to just `withCanopy(config)`
- **Example apps:** `apps/example1/package.json`, `apps/test-app/package.json` — have `react@^18.3.1` as direct deps (the source of the hoisted React 18)
