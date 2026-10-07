/**
 * CLI commands: `canopycms collect-asset-refs <outDir>` and
 * `canopycms materialize-assets --refs <file>`, the two release steps that make every image URL a
 * build references exist in the store before that build is served. The logic lives in
 * `build/asset-refs.ts` and `assets/materialize.ts`; this file picks the store and reports.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import {
  materializeAssets,
  type MaterializeReport,
  type MaterializeResult,
} from '../assets/materialize'
import { S3AssetStore } from '../assets/store-s3'
import type { AssetStore } from '../assets/types'
import { AssetRefsError, collectAssetRefs, readAssetRefsFile } from '../build/asset-refs'
import { atomicWriteFile } from '../utils/atomic-write'
import { getErrorMessage, isNotFoundError } from '../utils/error'

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

/**
 * @internal Exported for tests. `materialize-assets` exit codes: a release gates on them, so `1`
 * means the run did not finish, and `2` and `3` mean it ran and
 * some keys are missing.
 */
export const MATERIALIZE_EXIT_CODES = {
  ok: 0,
  /** Bad flags, an unreadable refs file, a config or sharp failure, any uncaught throw. */
  error: 1,
  /** Content failures only; `--allow-failures` turns this into `ok`. */
  contentFailures: 2,
  /** Any store failure, whatever `--allow-failures` says. */
  storeFailures: 3,
} as const

export interface MaterializeAssetsCLIOptions {
  /** The project root; read only when the store comes from `canopycms.config.ts`. */
  projectDir?: string
  refsPath: string | undefined
  reportPath?: string
  allowFailures: boolean
  concurrency?: string
  transformConcurrency?: string
  /** With `region`, builds the S3 store directly and never loads the site config. */
  bucket?: string
  region?: string
  /** Accept a non-S3 store resolved from the config. */
  allowLocal?: boolean
  /** @internal Test seam: skips resolving the store. */
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
      `${summary.created} created, ${summary.copied} copied, ${summary.failed} failed`,
  )
  for (const result of report.results) {
    if (result.status !== 'failed') continue
    console.error(`  FAILED (${result.failure}) /${result.key}`)
    console.error(`    ${result.error}`)
    console.error(`    ${describeReferences(result)}`)
  }
}

/** `undefined` when the flag is absent; `null`, after printing why, when it is not a positive integer. */
function parsePositiveInteger(flag: string, value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (Number.isInteger(parsed) && parsed >= 1) return parsed
  console.error(`${flag} must be a positive integer, got "${value}"`)
  return null
}

/** The store to materialize into, or `null`, after printing why, when the run cannot start. */
async function resolveStore(options: MaterializeAssetsCLIOptions): Promise<AssetStore | null> {
  const { bucket, region } = options
  if ((bucket === undefined) !== (region === undefined)) {
    return refuse('--bucket and --region go together')
  }
  if (bucket === '' || region === '') return refuse('--bucket and --region need a value')
  if (bucket !== undefined && options.allowLocal) {
    return refuse('--allow-local does not apply with --bucket')
  }
  if (options.store) return options.store
  if (bucket !== undefined && region !== undefined) return new S3AssetStore({ bucket, region })
  if (!options.projectDir) {
    return refuse('no project root to read canopycms.config.ts from; pass --bucket/--region')
  }

  const { loadConfiguredAssetStore } = await import('./configured-asset-store')
  const store = await loadConfiguredAssetStore(options.projectDir)
  if (!(store instanceof S3AssetStore) && !options.allowLocal) {
    return refuse(
      'canopycms.config.ts resolved to a local asset store, which a release job would fill ' +
        "instead of the bucket. Likely causes: `media` is unset or `adapter: 'local'`, or " +
        "`mode: 'dev'` where the release expected CANOPY_MODE=prod and an s3 `media`. " +
        'Fix the config, pass --bucket and --region, or pass --allow-local to use it.',
    )
  }
  return store
}

function refuse(message: string): null {
  console.error(`canopycms materialize-assets: ${message}`)
  return null
}

/**
 * `--allow-failures` tolerates content failures only — a reference to an asset the store can no
 * longer produce — so one deleted image does not block a release. A store failure (access
 * denied, an outage that outlasted the retries) still fails the run, since it says nothing about
 * which images are actually fine.
 *
 * @returns a `MATERIALIZE_EXIT_CODES` value; a throw is caught and reported as `error`.
 */
export async function materializeAssetsCLI(options: MaterializeAssetsCLIOptions): Promise<number> {
  try {
    return await runMaterialize(options)
  } catch (err: unknown) {
    console.error(`canopycms materialize-assets: ${getErrorMessage(err)}`)
    return MATERIALIZE_EXIT_CODES.error
  }
}

async function runMaterialize(options: MaterializeAssetsCLIOptions): Promise<number> {
  if (!options.refsPath) {
    console.error(
      'Usage: canopycms materialize-assets --refs <file> [--report <file>] [--bucket <name> --region <region>]',
    )
    return MATERIALIZE_EXIT_CODES.error
  }
  if (options.reportPath === '') {
    console.error('canopycms materialize-assets: --report needs a file')
    return MATERIALIZE_EXIT_CODES.error
  }
  // A gate reading the report must never find an earlier run's after this run exits early.
  if (options.reportPath) await fs.rm(path.resolve(options.reportPath), { force: true })
  const concurrency = parsePositiveInteger('--concurrency', options.concurrency)
  const transformConcurrency = parsePositiveInteger(
    '--transform-concurrency',
    options.transformConcurrency,
  )
  if (concurrency === null || transformConcurrency === null) return MATERIALIZE_EXIT_CODES.error

  const refs = await readAssetRefsFile(path.resolve(options.refsPath))
  const store = await resolveStore(options)
  if (!store) return MATERIALIZE_EXIT_CODES.error

  // A `SharpUnavailableError` reaches `materializeAssetsCLI`'s catch: exit 1.
  const report = await materializeAssets({
    store,
    targets: refs.transforms,
    statics: refs.statics,
    concurrency,
    transformConcurrency,
  })

  printReport(report)
  if (options.reportPath) {
    await atomicWriteFile(path.resolve(options.reportPath), `${JSON.stringify(report, null, 2)}\n`)
  }

  const { contentFailures, storeFailures } = report.summary
  if (storeFailures > 0) {
    if (options.allowFailures) {
      console.error('--allow-failures does not cover store failures; fix access or rerun.')
    }
    return MATERIALIZE_EXIT_CODES.storeFailures
  }
  if (contentFailures === 0) return MATERIALIZE_EXIT_CODES.ok
  if (!options.allowFailures) return MATERIALIZE_EXIT_CODES.contentFailures
  console.warn(
    `\nWARNING: --allow-failures is set. ${contentFailures} image URL(s) above will be MISSING ` +
      `from the released site. Fix the pages listed and rerun.\n`,
  )
  return MATERIALIZE_EXIT_CODES.ok
}
