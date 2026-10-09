---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-08, from the preview first-paint fix's review. `import { cache } from 'react'` is a link-time SyntaxError under unbundled Node ESM on React 18, which the peer range allows; App Router pages are unaffected
---
# `canopycms-next` cannot be imported by unbundled Node ESM on React 18

**Status:** Open. **Priority: P3.** Filed 2026-10-08 from a review of the preview first-paint fix
([preview-first-paint-public-asset-urls.md](preview-first-paint-public-asset-urls.md)).

## State

`canopycms-next/src/context-wrapper.ts` and `preview-page.tsx` import `{ cache }` from `'react'`.
React 18 is CommonJS, and its named `cache` export does not exist, so Node's ESM loader fails at
link time (`SyntaxError: Named export 'cache' not found`) whenever the `canopycms-next` index is
loaded without a bundler. That includes an adopter's `tsx` or `node` script, or a test that
imports their `lib/canopy.ts`. The peer range still allows React 18. Inside Next's App Router the
import is aliased to Next's vendored React canary, which has `cache`, so pages are unaffected.

## Fix

Use `import * as React from 'react'`, and read `React.cache` at call time, falling back to an
uncached factory when it is absent. Alternatively, drop React 18 from the peer range if no
supported setup needs it.
