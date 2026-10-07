/**
 * CLI commands: `canopycms collect-asset-refs <outDir>` and
 * `canopycms materialize-assets --refs <file>`, the two release steps that make every image URL a
 * build references exist in the store before that build is served. The logic lives in
 * `build/asset-refs.ts` and `assets/materialize.ts`; this file loads config and reports.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { createJiti } from 'jiti'
import { z } from 'zod'

import { createAssetStore } from '../assets/factory'
import {
  materializeAssets,
  SharpUnavailableError,
  type MaterializeReport,
  type MaterializeResult,
} from '../assets/materialize'
import type { AssetStore } from '../assets/types'
import { AssetRefsError, collectAssetRefs, readAssetRefsFile } from '../build/asset-refs'
import { mediaSchema } from '../config/schemas/media'
import { operatingStrategy } from '../operating-mode'
import { atomicWriteFile } from '../utils/atomic-write'
import { isNotFoundError } from '../utils/error'

/** @returns the process exit code. */
export async function collectAssetRefsCLI(options: {
  outDir: string | undefined
}): Promise<number> {
  if (!options.outDir) {
    console.error('Usage: canopycms collect-asset-refs <outDir>')
    return 1
  }
  const outDir = path.resolve(options.outDir)
  try {
    if (!(await fs.stat(outDir)).isDirectory()) {
      console.error(`Not a directory: ${outDir}`)
      return 1
    }
  } catch (err: unknown) {
    if (!isNotFoundError(err)) throw err
    console.error(`No build output at ${outDir}. Run this after the static build.`)
    return 1
  }

  try {
    const { refs, filePath, scannedFiles } = await collectAssetRefs(outDir)
    console.log(
      `canopycms collect-asset-refs: ${refs.transforms.length} transform and ` +
        `${refs.statics.length} static asset reference(s) in ${scannedFiles} file(s), ` +
        `written to ${filePath}`,
    )
    return 0
  } catch (err: unknown) {
    if (!(err instanceof AssetRefsError)) throw err
    console.error(`canopycms collect-asset-refs: ${err.message}`)
    console.error(
      'Build these URLs with assetUrl/assetSrcSet, which always write the canonical form; ' +
        'a hand-written or edited URL has no stored object behind it.',
    )
    return 1
  }
}

const serverConfigSchema = z.object({
  mode: z.enum(['prod', 'dev']),
  media: mediaSchema.optional(),
})

/**
 * The store the site's `media` config names, resolved as the running CMS resolves it when its
 * working directory is the project: dev mode with no `media` falls back to the dev workspace's
 * local store, prod never does.
 */
async function loadConfiguredAssetStore(projectDir: string): Promise<AssetStore> {
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

export interface MaterializeAssetsCLIOptions {
  projectDir: string
  refsPath: string | undefined
  reportPath?: string
  allowFailures: boolean
  concurrency?: string
  /** @internal Test seam: skips loading the project's config. */
  store?: AssetStore
}

function describeReferences(result: MaterializeResult): string {
  if (result.routes.length > 0) return `pages: ${result.routes.join(', ')}`
  return `files: ${result.files.join(', ')}`
}

function printReport(report: MaterializeReport): void {
  const { summary } = report
  console.log(
    `canopycms materialize-assets: ${summary.total} key(s): ${summary.existed} existed, ` +
      `${summary.created} created, ${summary.failed} failed`,
  )
  for (const result of report.results) {
    if (result.status !== 'failed') continue
    console.error(`  FAILED (${result.failure}) /${result.key}`)
    console.error(`    ${result.error}`)
    console.error(`    ${describeReferences(result)}`)
  }
}

/**
 * Exits non-zero on any failure. `--allow-failures` tolerates content failures only — a
 * reference to an asset the store can no longer produce — so one deleted image does not block a
 * release. A store failure (access denied, an outage that outlasted the retries) still fails the
 * run, since it says nothing about which images are actually fine.
 *
 * @returns the process exit code.
 */
export async function materializeAssetsCLI(options: MaterializeAssetsCLIOptions): Promise<number> {
  if (!options.refsPath) {
    console.error('Usage: canopycms materialize-assets --refs <file> [--report <file>]')
    return 1
  }
  const concurrency = options.concurrency === undefined ? undefined : Number(options.concurrency)
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) {
    console.error(`--concurrency must be a positive integer, got "${options.concurrency}"`)
    return 1
  }

  const refs = await readAssetRefsFile(path.resolve(options.refsPath))
  const store = options.store ?? (await loadConfiguredAssetStore(options.projectDir))

  let report: MaterializeReport
  try {
    report = await materializeAssets({
      store,
      targets: refs.transforms,
      statics: refs.statics,
      concurrency,
    })
  } catch (err: unknown) {
    if (!(err instanceof SharpUnavailableError)) throw err
    console.error(`canopycms materialize-assets: ${err.message}`)
    return 1
  }

  if (options.reportPath) {
    await atomicWriteFile(path.resolve(options.reportPath), `${JSON.stringify(report, null, 2)}\n`)
  }
  printReport(report)

  const { contentFailures, storeFailures } = report.summary
  if (storeFailures > 0) {
    if (options.allowFailures) {
      console.error('--allow-failures does not cover store failures; fix access or rerun.')
    }
    return 1
  }
  if (contentFailures === 0) return 0
  if (!options.allowFailures) return 1
  console.warn(
    `\nWARNING: --allow-failures is set. ${contentFailures} image URL(s) above will be MISSING ` +
      `from the released site. Fix the pages listed and rerun.\n`,
  )
  return 0
}
