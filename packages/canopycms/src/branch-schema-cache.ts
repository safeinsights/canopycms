import type { BigIntStats } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { LRUCache } from 'lru-cache'

import type { RootCollectionConfig } from './config'
import type { FlatSchemaItem } from './config/types'
import type { OperatingMode } from './operating-mode'
import type {
  EntrySchemaRegistry,
  SchemaIssue,
  SchemaResolutionResult,
  UnknownSchemaPolicy,
} from './schema/types'
import { resolveSchema, isValidSchema } from './schema/resolver'
import { registryFingerprint } from './schema/registry-fingerprint'
import { flattenSchema } from './config/flatten'
import { validateReferenceEntryTypes } from './validation/entry-type-reference-validator'
import { isBuildMode } from './build-mode'
import {
  bumpResourceGeneration,
  readResourceGeneration,
  isGenerationCurrent,
  type GenerationReadResult,
} from './resource-generation'
import { timeRequestPhase } from './utils/request-timing'
import { CANOPY_META_DIR } from './utils/git'
import { canopyLogWarn } from './utils/logger'

/** Bump when BranchSchemaCacheEntry shape changes to auto-invalidate stale caches */
const SCHEMA_CACHE_VERSION = 4

/** Minimum interval between mtime staleness checks (ms) */
const MTIME_CHECK_DEBOUNCE_MS = 1000

/** Cap on the parsed snapshots one process keeps, counted in bytes of their files. */
const SNAPSHOT_MEMO_MAX_BYTES = 64 * 1024 * 1024

/** File name of the schema cache inside {@link schemaCacheDir}. */
export const SCHEMA_CACHE_FILE = 'schema-cache.json'

/** resource-generation.ts resource key for the schema cache's marker. */
export const SCHEMA_GENERATION_RESOURCE = 'schema'

/** @internal Exported for tests. */
export interface BranchSchemaCacheEntry {
  version: number
  schema: RootCollectionConfig
  flatSchema: FlatSchemaItem[]
  cachedAt: string // ISO timestamp
  /**
   * The marker token this snapshot was resolved against, or null when it was
   * built before any bump on this root. Compared against the live marker (via
   * isGenerationCurrent) to decide freshness.
   */
  generation: string | null
  /**
   * {@link registryFingerprint} of the registry this snapshot was resolved
   * against. A deploy bumps no marker, so without it a new image would keep
   * serving schemas resolved by the old image's registry.
   */
  registryFingerprint: string
  issues: SchemaIssue[]
}

/** A branch's resolved schema, plus what a degraded resolve left out of it. */
export interface ResolvedBranchSchema {
  schema: RootCollectionConfig
  flatSchema: FlatSchemaItem[]
  issues: SchemaIssue[]
}

const reportedIssues = new Set<string>()

/** Log each schema issue once per process, whether it was resolved here or read from a snapshot. */
function reportSchemaIssues(issues: readonly SchemaIssue[]): void {
  for (const issue of issues) {
    const line =
      issue.kind === 'unknown-schema'
        ? `CanopyCMS: ${issue.metaFile} names entry schema "${issue.schemaRef}", which this ` +
          `deployment's entry schema registry does not define, so entry type ` +
          `"${issue.entryType}" is unavailable until code defining it is deployed or the ` +
          `content stops naming it.`
        : `CanopyCMS: ${issue.message} That reference field offers no options until the ` +
          `content declares the entry type.`
    if (reportedIssues.has(line)) continue
    reportedIssues.add(line)
    canopyLogWarn(line)
  }
}

/**
 * True when a .collection.json under `dir` is newer than `cachedAt`.
 *
 * Dev-only, and dev-only on purpose: it catches hand edits made outside the
 * CMS, which bypass SchemaOps and so never bump the marker. Every prod mutation
 * path does bump it, so the marker alone is sufficient there.
 */
async function isStaleByMtime(dir: string, cachedAt: Date): Promise<boolean> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir, { recursive: true, encoding: 'utf-8' })
  } catch {
    return true
  }
  for (const entry of entries) {
    if (!entry.endsWith('.collection.json')) continue
    const full = path.join(dir, entry)
    try {
      const stat = await fs.stat(full)
      if (stat.mtimeMs > cachedAt.getTime()) return true
    } catch {
      // File may have been deleted between readdir and stat
      return true
    }
  }
  return false
}

interface MemoizedSnapshot {
  /** {@link fileIdentity} of the file `entry` was parsed from. */
  identity: string
  entry: BranchSchemaCacheEntry
  bytes: number
}

/**
 * Names one version of a file. Every write of the schema cache renames a new temp file into
 * place, so a rewrite always changes the inode, whatever token or content it carries.
 */
function fileIdentity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`
}

/**
 * Directory holding a branch's schema cache: `{branchRoot}/.git/canopycms` when
 * the branch root is a full clone (every canopycms branch workspace is), else
 * `{branchRoot}/.canopy-meta`. Under `.git/` because nothing there is ever
 * tracked or reported by `git status`, so the cache can neither dirty the
 * workspace nor enter a commit, even where an adopter has committed
 * `.canopy-meta/`. It also lives and dies with the clone, so a re-clone never
 * reads its predecessor's snapshot.
 */
async function schemaCacheDir(branchRoot: string): Promise<string> {
  const gitDir = path.join(branchRoot, '.git')
  const isClone = await fs.stat(gitDir).then(
    (stat) => stat.isDirectory(),
    () => false,
  )
  return isClone ? path.join(gitDir, 'canopycms') : path.join(branchRoot, CANOPY_META_DIR)
}

/**
 * Per-branch schema cache: one file in {@link schemaCacheDir}, the only state
 * shared across processes. Each process keeps the entries it parsed or wrote,
 * keyed by the file's identity, so it parses an unchanged file once while the
 * entry stays in its size-bounded memo. Every call still opens the file and
 * runs every freshness check below on the entry, and the file is only ever
 * replaced by rename (see {@link fileIdentity}), so a process is as fresh as if
 * it re-read the file. The identity is fstat'ed on an open handle because NFS
 * revalidates attributes on open (close-to-open), while a bare stat() may
 * answer from its attribute cache.
 *
 * Freshness follows the generation-marker protocol owned by
 * resource-generation.ts, and this is one of that protocol's durable-snapshot
 * consumers. Its eager re-resolve lives one level up, in
 * `SchemaOps.invalidateSchemaCache()` (schema/schema-store.ts), because that is
 * where the entrySchemaRegistry/contentRootName arguments {@link invalidate}
 * lacks are available; it calls {@link resolveAndPersist}, never getSchema().
 * Callers that bypass SchemaOps (api/schema.ts's invalidate endpoint, and the
 * bulk git-op bump in invalidateBranchContentCaches) accept the lazy
 * next-read regen instead.
 *
 * The owner of the strict/degrade split. Content read from the checkout (a
 * build, a static deployment) shares a commit with the code, so a schema
 * reference the registry lacks is a real bug and resolution throws. A branch
 * workspace's content arrives by sync, which can land before the image whose
 * registry it needs, or after an image that needs content it lacks; there an
 * unknown schema marks only its entry type `unavailable`, an unknown reference
 * `entryTypes` value only empties that field's options, and both are returned
 * as `issues`.
 */
export class BranchSchemaCache {
  /** Tracks when we last checked mtimes per contentRoot, to debounce rapid requests */
  private lastMtimeCheck = new Map<string, number>()

  /** Parsed cache files, by absolute path; see the class doc. */
  private readonly snapshots = new LRUCache<string, MemoizedSnapshot>({
    maxSize: SNAPSHOT_MEMO_MAX_BYTES,
    sizeCalculation: (snapshot) => Math.max(1, snapshot.bytes),
  })

  /**
   * In-flight resolves of the checkout during a build, by content root and registry. A build
   * reads a checkout that does not change under it, so those two are its whole input and the
   * result needs no revalidation. Only {@link isBuildMode}: `CANOPY_BUILD_MODE` is a build and
   * script switch, and a long-lived process setting it would see a schema edit only on
   * restart. A rejected resolve is dropped, so a strict-mode failure fails every read.
   */
  private readonly buildResolves = new Map<string, Promise<ResolvedBranchSchema>>()

  private readonly devMode: boolean

  constructor(mode: OperatingMode = 'prod') {
    this.devMode = mode === 'dev'
  }

  /**
   * Whether this branchRoot is the checkout rather than a branch workspace,
   * which skips the on-disk cache and resolves strictly (see the class doc).
   *
   * Never write a schema cache at the project root, whichever entrypoint
   * produced the cwd branchRoot. branchRoot equals process.cwd() only in the
   * synthetic contexts static deployments and build phases use; a real branch
   * root is always nested under the workspace.
   */
  private readsCheckout(branchRoot: string): boolean {
    return isBuildMode() || path.resolve(branchRoot) === path.resolve(process.cwd())
  }

  /** Get schema for a branch, from the cache when fresh, else resolved fresh. */
  async getSchema(
    branchRoot: string,
    entrySchemaRegistry: EntrySchemaRegistry,
    contentRootName: string = 'content',
  ): Promise<ResolvedBranchSchema> {
    return timeRequestPhase('schema', () =>
      this.loadFromCacheOrResolve(branchRoot, entrySchemaRegistry, contentRootName),
    )
  }

  /**
   * Resolve the schema from disk. Protected rather than a direct resolveSchema
   * call so tests can subclass and block it to simulate cross-process
   * interleavings — mirrors BranchRegistry's scanBranchDirectories() hook.
   */
  protected async resolveFresh(
    contentRoot: string,
    entrySchemaRegistry: EntrySchemaRegistry,
    unknownSchema: UnknownSchemaPolicy,
  ): Promise<SchemaResolutionResult> {
    return resolveSchema(contentRoot, entrySchemaRegistry, { unknownSchema })
  }

  private async loadFromCacheOrResolve(
    branchRoot: string,
    entrySchemaRegistry: EntrySchemaRegistry,
    contentRootName: string,
  ): Promise<ResolvedBranchSchema> {
    const contentRoot = path.join(branchRoot, contentRootName)

    const fromCheckout = this.readsCheckout(branchRoot)

    if (fromCheckout && isBuildMode()) {
      return this.resolveForBuild(branchRoot, entrySchemaRegistry, contentRootName)
    }

    if (!fromCheckout) {
      const cachePath = path.join(await schemaCacheDir(branchRoot), SCHEMA_CACHE_FILE)

      let cacheData = await this.readSnapshot(cachePath)

      // Strict version check, not truthiness: a snapshot from an older version
      // left on EFS by a rolling deploy has no `generation` field, and an
      // `undefined` token breaks the freshness comparison below.
      if (
        cacheData &&
        cacheData.version === SCHEMA_CACHE_VERSION &&
        cacheData.registryFingerprint === registryFingerprint(entrySchemaRegistry)
      ) {
        const read = await readResourceGeneration(branchRoot, SCHEMA_GENERATION_RESOURCE)
        if (isGenerationCurrent(cacheData.generation, read)) {
          // Dev also walks mtimes, debounced, to catch edits made outside the CMS.
          const now = Date.now()
          const lastCheck = this.lastMtimeCheck.get(contentRoot) ?? 0
          if (
            this.devMode &&
            now - lastCheck >= MTIME_CHECK_DEBOUNCE_MS &&
            (await isStaleByMtime(contentRoot, new Date(cacheData.cachedAt)))
          ) {
            this.lastMtimeCheck.set(contentRoot, now)
            cacheData = null
          } else {
            if (this.devMode) this.lastMtimeCheck.set(contentRoot, now)
            reportSchemaIssues(cacheData.issues)
            return {
              schema: cacheData.schema,
              flatSchema: cacheData.flatSchema,
              issues: cacheData.issues,
            }
          }
        } else {
          // Marker mismatch (or unreadable) — treat as a cache miss.
          cacheData = null
        }
      } else {
        cacheData = null
      }
    }

    return this.resolveFreshAndPersist(branchRoot, entrySchemaRegistry, contentRootName, {
      fromCheckout,
    })
  }

  private resolveForBuild(
    branchRoot: string,
    entrySchemaRegistry: EntrySchemaRegistry,
    contentRootName: string,
  ): Promise<ResolvedBranchSchema> {
    const key = `${path.resolve(branchRoot, contentRootName)}\0${registryFingerprint(entrySchemaRegistry)}`
    let pending = this.buildResolves.get(key)
    if (!pending) {
      pending = this.resolveFreshAndPersist(branchRoot, entrySchemaRegistry, contentRootName, {
        fromCheckout: true,
      })
      this.buildResolves.set(key, pending)
      pending.catch(() => this.buildResolves.delete(key))
    }
    return pending
  }

  /** The parsed cache file, or null when it is absent or unreadable. */
  private async readSnapshot(cachePath: string): Promise<BranchSchemaCacheEntry | null> {
    let handle: FileHandle
    try {
      handle = await fs.open(cachePath, 'r')
    } catch {
      return null
    }
    try {
      const stat = await handle.stat({ bigint: true })
      const identity = fileIdentity(stat)
      const memo = this.snapshots.get(cachePath)
      if (memo?.identity === identity) return memo.entry
      const entry = JSON.parse(await fs.readFile(handle, 'utf-8')) as BranchSchemaCacheEntry
      this.snapshots.set(cachePath, { identity, entry, bytes: Number(stat.size) })
      return entry
    } catch {
      return null
    } finally {
      await handle.close().catch(() => {})
    }
  }

  /**
   * Resolve the schema fresh from disk and persist it (subject to the
   * skip-persist rule below), UNCONDITIONALLY -- never through the cache-read
   * fast path in {@link loadFromCacheOrResolve}. Shared by that method's
   * cache-miss fallback and by {@link resolveAndPersist}.
   */
  private async resolveFreshAndPersist(
    branchRoot: string,
    entrySchemaRegistry: EntrySchemaRegistry,
    contentRootName: string,
    options: { fromCheckout: boolean },
  ): Promise<ResolvedBranchSchema> {
    const { fromCheckout } = options
    const contentRoot = path.join(branchRoot, contentRootName)

    // Capture the marker strictly BEFORE resolving, so a bump landing
    // mid-resolve differs from the token persisted below and forces a
    // re-resolve on the next read.
    const read: GenerationReadResult | null = fromCheckout
      ? null
      : await readResourceGeneration(branchRoot, SCHEMA_GENERATION_RESOURCE)

    // Nested under `schema`, so a request summary names a cache miss (`…schema>resolve`).
    const result = await timeRequestPhase('resolve', () =>
      this.resolveFresh(contentRoot, entrySchemaRegistry, fromCheckout ? 'throw' : 'degrade'),
    )

    // Validate schema has content
    if (!isValidSchema(result.schema)) {
      throw new Error(
        `No schema found in ${contentRoot}. Create .collection.json files ` +
          'with references to field schemas defined in your entry schema registry.',
      )
    }

    // Reference fields may only scope themselves to entry types that exist.
    // Checked here, before anything is cached, so a typo fails a build loudly
    // instead of silently resolving to zero reference options.
    const entryTypeIssues = validateReferenceEntryTypes(result.schema)
    if (entryTypeIssues.length > 0 && fromCheckout) {
      throw new Error(
        `Invalid reference field entryTypes in ${contentRoot}:\n` +
          entryTypeIssues.map((issue) => `  - ${issue}`).join('\n'),
      )
    }
    const issues: SchemaIssue[] = [
      ...result.issues,
      ...entryTypeIssues.map((message) => ({ kind: 'reference-entry-type' as const, message })),
    ]

    // Use configured contentRoot name as base path for logical paths
    const flatSchema = flattenSchema(result.schema, contentRootName)

    if (!fromCheckout) {
      const cacheDir = await schemaCacheDir(branchRoot)
      const cachePath = path.join(cacheDir, SCHEMA_CACHE_FILE)

      // Opportunistic cleanup of the retired .stale marker file, which a
      // mid-flight deploy can leave behind. Not load-bearing.
      await fs.unlink(path.join(branchRoot, CANOPY_META_DIR, 'schema-cache.stale')).catch(() => {})

      if (read && read.ok) {
        const newCache: BranchSchemaCacheEntry = {
          version: SCHEMA_CACHE_VERSION,
          schema: result.schema,
          flatSchema,
          cachedAt: new Date().toISOString(),
          generation: read.token,
          registryFingerprint: registryFingerprint(entrySchemaRegistry),
          issues,
        }

        // Temp file then rename, with the temp file unlinked on a failed
        // rename so a transient error leaves no stray `.tmp` beside the cache.
        // The memo is seeded from the temp file's own identity, which the
        // rename keeps: stat'ing cachePath afterwards could see a concurrent
        // writer's file and pair it with this entry. It holds the parsed body,
        // as every reader does, not the resolver's objects, which alias the
        // registry and keep values JSON changes or drops.
        await fs.mkdir(cacheDir, { recursive: true })
        const tmpPath = path.join(cacheDir, `schema-cache.tmp.${Date.now()}.${Math.random()}.json`)
        const body = JSON.stringify(newCache)
        let identity: string
        try {
          await fs.writeFile(tmpPath, body, 'utf-8')
          identity = fileIdentity(await fs.stat(tmpPath, { bigint: true }))
          await fs.rename(tmpPath, cachePath)
        } catch (err) {
          await fs.unlink(tmpPath).catch(() => {})
          throw err
        }
        this.snapshots.set(cachePath, {
          identity,
          entry: JSON.parse(body) as BranchSchemaCacheEntry,
          bytes: Buffer.byteLength(body),
        })
      }
      // else: the marker read failed for a reason other than "never bumped",
      // so no token can be attributed to this resolve, and a snapshot stamped
      // with an unattributable one would look correctly attributed to every
      // future reader. Serve the fresh result without persisting it.
    }

    reportSchemaIssues(issues)
    return { schema: result.schema, flatSchema, issues }
  }

  /**
   * Resolve fresh from disk and persist, SKIPPING the cache read entirely.
   * That is what makes it, and not {@link getSchema}, the right call for the
   * eager re-resolve in `SchemaOps.invalidateSchemaCache()` (its sole intended
   * caller): an eager re-resolve exists to guarantee ONE scan coherent with the
   * mutation this host just made, and getSchema()'s cache-read fast path can
   * instead return a snapshot a concurrent host wrote — possibly one embedding
   * the now-current token over ITS own stale-NFS scan — skipping that scan.
   */
  async resolveAndPersist(
    branchRoot: string,
    entrySchemaRegistry: EntrySchemaRegistry,
    contentRootName: string = 'content',
  ): Promise<ResolvedBranchSchema> {
    const fromCheckout = this.readsCheckout(branchRoot)
    return this.resolveFreshAndPersist(branchRoot, entrySchemaRegistry, contentRootName, {
      fromCheckout,
    })
  }

  /**
   * Invalidate a branch's cache by bumping the marker; every process sharing
   * this branchRoot re-resolves at its next read. The bump must succeed —
   * swallowing that failure leaves the schema cache stale indefinitely, and
   * unlike BranchRegistry there is no get-miss backstop for a resolved schema.
   *
   * No eager re-resolve here; it lives in SchemaOps (see the class doc).
   */
  async invalidate(branchRoot: string): Promise<void> {
    if (this.readsCheckout(branchRoot)) return

    await bumpResourceGeneration(branchRoot, SCHEMA_GENERATION_RESOURCE, { mustSucceed: true })
  }
}
