/**
 * The one place this package loads `sharp` at runtime. Everything else
 * reaches it through `loadSharp()` and imports only its types:
 * `@typescript-eslint/no-restricted-imports` in eslint.config.mjs rejects a
 * static value import of `sharp` anywhere under `src/` outside tests.
 *
 * Why lazily. sharp is a native addon, and loading it dlopens libvips. A
 * static `import sharp from 'sharp'` makes importing the MODULE GRAPH load
 * libvips, and a bundler keeps that eager: Turbopack emits a top-level
 * `await` of the external. transform.ts is reachable from `canopycms/server`
 * and, through api/assets.ts, from `canopycms/http` and so from
 * `canopycms-next`, which a host app's root layout typically imports. When
 * the libvips `.so` was missing from an adopter's standalone output, that one
 * static import turned it into a 500 on every route, 404s included, and
 * defeated pipeline.ts's deliberate fail-open. Loaded on first use, a missing
 * binary fails only the image operations that need it.
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
  loading ??= import('sharp').then(
    (mod) => mod.default,
    (err: unknown) => {
      canopyLogError(
        `[canopycms] sharp failed to load - image transforms and upload decode validation are unavailable in this process: ${getErrorMessage(err)}`,
      )
      throw err
    },
  )
  return loading
}
