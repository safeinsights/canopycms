/**
 * Imports a site's own TypeScript modules for CLI commands that need them: `canopycms.config.ts`
 * (`sync`, `generate-ai-content`, `backfill-item-keys`, `configured-asset-store.ts`) and the
 * entry schema registry (`generate-ai-content`, `backfill-item-keys`). jiti lets plain node
 * import them without tsx. Importing runs the module and loads its own dependencies.
 */

import path from 'node:path'
import { createJiti } from 'jiti'

const jiti = createJiti(import.meta.url)

/** A site module's exports, by name. */
export async function importSiteModule(filePath: string): Promise<Record<string, unknown>> {
  return (await jiti.import(filePath)) as Record<string, unknown>
}

/** The site's server config export (`server` of a split config, else the export itself). */
export async function importSiteServerConfig(
  projectDir: string,
): Promise<{ configPath: string; server: unknown }> {
  const configPath = path.join(projectDir, 'canopycms.config.ts')
  const mod = await importSiteModule(configPath)
  const configExport = mod.default ?? mod.config ?? mod
  const server =
    typeof configExport === 'object' && configExport !== null && 'server' in configExport
      ? (configExport as { server: unknown }).server
      : configExport
  return { configPath, server }
}

/**
 * The site's entry schema registry: `{appDir}/schemas.ts`'s `entrySchemaRegistry` export, else
 * the module's exports. Throws when the file is missing or fails to import.
 */
export async function importSiteEntrySchemaRegistry(
  projectDir: string,
  appDir: string,
): Promise<{ schemasPath: string; registry: Record<string, unknown> }> {
  const schemasPath = path.join(projectDir, appDir, 'schemas.ts')
  const mod = await importSiteModule(schemasPath)
  const registry = (mod.entrySchemaRegistry as Record<string, unknown> | undefined) ?? mod
  return { schemasPath, registry }
}
