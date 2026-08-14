import type { CanopyConfig } from './config'
import type { EntrySchemaRegistry } from './schema/types'
import { createCanopyServices } from './services'
import { createCanopyContext, type CanopyBuildContext } from './context'
import { STATIC_DEPLOY_USER } from './build-mode'

export interface CreateBuildCanopyOptions {
  /**
   * Entry schema registry for resolving `.collection.json` references.
   * Same shape as `createCanopyServices`'s option of the same name.
   */
  entrySchemaRegistry?: EntrySchemaRegistry
}

/**
 * One-call factory for a **build/admin** Canopy context — for standalone
 * scripts that run entirely outside a Next.js request or build phase (index
 * builders, content audits, codegen, ad hoc reports).
 *
 * **This is a build/admin context: it reads the filesystem directly as a
 * synthetic admin user (`STATIC_DEPLOY_USER`) and bypasses ALL branch and
 * path ACLs.** There is no per-request auth to enforce because there is no
 * request. Do not reach for this from request-handling code (an API route,
 * a server component rendering for a specific visitor, anything with a real
 * user on the other end) — there, use `createNextCanopyContext(...)`'s
 * `getCanopy()` (or its phase-selecting `read`/`readByUrlPath`), which
 * enforce branch/path permissions per user. This factory mirrors the same
 * `createCanopyServices` + `createCanopyContext` + `STATIC_DEPLOY_USER` boot
 * sequence that `createNextCanopyContext`'s own `getCanopyForBuild()` uses
 * internally, minus the Next.js pieces (no `next/headers`, no React
 * `cache()`, no request-time misuse guard — there is no request phase for
 * it to guard against) — so it works in a plain script run with `tsx`/`node`.
 *
 * Trivially stubbable by design: the boot sequence is one function call
 * taking a plain config object and returning a plain context, so a script
 * that calls it can be imported and exercised from a test with the config
 * (or this function itself) swapped out. Contrast with a hand-rolled
 * top-level-`await` boot block, which can never be imported by a test at
 * all — that's the concrete problem this factory removes.
 *
 * @example
 * ```ts
 * // scripts/build-search-index.ts
 * import { createBuildCanopy } from 'canopycms/server'
 * import config from '../canopycms.config'
 * import { entrySchemaRegistry } from '../src/schemas'
 *
 * const canopy = await createBuildCanopy(config.server, { entrySchemaRegistry })
 * const entries = await canopy.listEntries()
 * ```
 */
export async function createBuildCanopy(
  config: CanopyConfig,
  options: CreateBuildCanopyOptions = {},
): Promise<CanopyBuildContext> {
  const services = await createCanopyServices(config, {
    entrySchemaRegistry: options.entrySchemaRegistry,
  })

  const {
    buildContentTree,
    listEntries,
    read,
    readByUrlPath,
    services: contextServices,
  } = await createCanopyContext({
    services,
    extractUser: async () => STATIC_DEPLOY_USER,
  }).getContext()

  return { buildContentTree, listEntries, read, readByUrlPath, services: contextServices }
}
