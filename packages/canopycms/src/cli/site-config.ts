/**
 * Imports a site's `canopycms.config.ts` for CLI commands that need it. Loading the config pulls in
 * jiti and the site's own dependencies, so a command imports this only on the path that reads the
 * config.
 */

import path from 'node:path'
import { createJiti } from 'jiti'

/** The site's server config export (`server` of a split config, else the export itself). */
export async function importSiteServerConfig(
  projectDir: string,
): Promise<{ configPath: string; server: unknown }> {
  const configPath = path.join(projectDir, 'canopycms.config.ts')
  const jiti = createJiti(import.meta.url)
  const mod = (await jiti.import(configPath)) as Record<string, unknown>
  const configExport = mod.default ?? mod.config ?? mod
  const server =
    typeof configExport === 'object' && configExport !== null && 'server' in configExport
      ? (configExport as { server: unknown }).server
      : configExport
  return { configPath, server }
}
