import type { CanopyConfig } from './config'
import type { EntrySchemaRegistry } from './schema/types'
import { createCanopyServices } from './services'
import { createCanopyContext, type CanopyBuildContext } from './context'
import { STATIC_DEPLOY_USER } from './build-mode'

export interface CreateBuildCanopyOptions {
  /** Entry schema registry for `.collection.json` references; `createCanopyServices`'s shape. */
  entrySchemaRegistry?: EntrySchemaRegistry
}

/**
 * One-call factory for a **build/admin** Canopy context, for standalone scripts
 * that run entirely outside a Next.js request or build phase (index builders,
 * content audits, codegen, ad hoc reports).
 *
 * **Bypasses ALL branch and path ACLs: it reads the filesystem directly as the
 * synthetic admin user `STATIC_DEPLOY_USER`.** That is safe only because there
 * is no request, and so no per-request auth to enforce. Never reach for it from
 * request-handling code (an API route, a server component rendering for a
 * specific visitor); there, use `createNextCanopyContext(...)`'s `getCanopy()`
 * or its phase-selecting `read`/`readByUrlPath`, which enforce branch and path
 * permissions per user.
 *
 * Mirrors the `createCanopyServices` + `createCanopyContext` +
 * `STATIC_DEPLOY_USER` boot sequence of `createNextCanopyContext`'s own
 * `getCanopyForBuild()`, minus the Next.js pieces (no `next/headers`, no React
 * `cache()`, no request-time misuse guard — there is no request phase to guard
 * against), so it runs in a plain `tsx`/`node` script and can be stubbed from a
 * test the way a top-level-`await` boot block cannot.
 *
 * @example
 * ```ts
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
