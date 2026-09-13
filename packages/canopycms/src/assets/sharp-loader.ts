/**
 * The one place this package loads `sharp` at runtime. Everything else
 * reaches it through `loadSharp()` and imports only its types:
 * `@typescript-eslint/no-restricted-imports` in eslint.config.mjs rejects a
 * static value import of `sharp` anywhere under `src/` outside tests.
 *
 * Why lazily. sharp is a native addon, and loading it dlopens libvips. A
 * static `import sharp from 'sharp'` makes importing the MODULE GRAPH load
 * libvips. With sharp external, as in an adopter's Next 16 standalone build,
 * Turbopack wraps it in an async module that awaits the load when the graph is
 * evaluated. transform.ts is reachable from `canopycms/server` and, through
 * api/assets.ts, from `canopycms/http` and so from `canopycms-next`, which a
 * host app's root layout can import (that adopter's did). When the libvips
 * `.so` was missing from its standalone output, that one static import turned
 * it into a 500 on every on-demand route, 404s included, and defeated
 * pipeline.ts's deliberate fail-open. Loaded on first use, a missing binary
 * affects only the image operations that need it.
 *
 * Memoized INCLUDING a rejection: a failed dlopen does not heal inside a
 * running process, so a retry would only pay for the failure again and log
 * it again. The failure is logged once, here, and every later caller gets the
 * same rejected promise to handle as its operation requires: transform.ts
 * lets it propagate as a server error, pipeline.ts fails open.
 */

import type { SharpConstructor } from 'sharp'

import { getErrorMessage } from '../utils/error'
import { canopyLogError } from '../utils/logger'

let loading: Promise<SharpConstructor> | undefined

/** Resolve sharp's callable constructor, loading the native module on the first call only. */
export function loadSharp(): Promise<SharpConstructor> {
  if (!loading) {
    loading = import('sharp').then(
      (mod) => mod.default,
      (err: unknown) => {
        canopyLogError(
          `[canopycms] sharp failed to load - image transforms and upload decode validation are unavailable in this process: ${getErrorMessage(err)}`,
        )
        throw err
      },
    )
    // Marks the stored promise handled; every caller still gets the rejection.
    // Without it, a caller that does not await - a warm-up `void loadSharp()` -
    // leaves a rejected promise with no handler, which Node treats as fatal by
    // default: a whole-process outage, the shape this module exists to prevent.
    // The failure is already logged above.
    loading.catch(() => undefined)
  }
  return loading
}
