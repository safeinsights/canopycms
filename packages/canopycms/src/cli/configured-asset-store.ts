/**
 * Resolves the asset store a site's `canopycms.config.ts` names. Imported dynamically, and only
 * by the config path of `materialize-assets`, because loading the config pulls in jiti and the
 * site's own dependencies, which a release job given `--bucket` does not have.
 */

import path from 'node:path'
import { createJiti } from 'jiti'
import { z } from 'zod'

import { createAssetStore } from '../assets/factory'
import type { AssetStore } from '../assets/types'
import { mediaSchema } from '../config/schemas/media'
import { operatingStrategy } from '../operating-mode'

const serverConfigSchema = z.object({
  mode: z.enum(['prod', 'dev']),
  media: mediaSchema.optional(),
})

/**
 * The store the site's `media` config names, resolved as the running CMS resolves it when its
 * working directory is the project: dev mode with no `media` falls back to the dev workspace's
 * local store, prod never does.
 */
export async function loadConfiguredAssetStore(projectDir: string): Promise<AssetStore> {
  const configPath = path.join(projectDir, 'canopycms.config.ts')
  const jiti = createJiti(import.meta.url)
  const mod = (await jiti.import(configPath)) as Record<string, unknown>
  const configExport = mod.default ?? mod.config ?? mod
  const server =
    typeof configExport === 'object' && configExport !== null && 'server' in configExport
      ? (configExport as { server: unknown }).server
      : configExport

  const parsed = serverConfigSchema.safeParse(server)
  if (!parsed.success) {
    throw new Error(`Invalid CanopyCMS config at ${configPath}: ${parsed.error.message}`)
  }
  const { mode, media } = parsed.data
  const devAssetsDir =
    mode === 'dev'
      ? path.join(operatingStrategy(mode).getWorkspaceRoot(projectDir), 'assets')
      : undefined
  // A relative `media.directory` is relative to the project, wherever the command was run from.
  const resolvedMedia =
    media?.adapter === 'local' && media.directory
      ? { ...media, directory: path.resolve(projectDir, media.directory) }
      : media
  const store = createAssetStore(resolvedMedia, { devAssetsDir })
  if (!store) {
    throw new Error(
      `No asset store is configured in ${configPath}: set \`media\` (an s3 adapter in prod).`,
    )
  }
  return store
}
