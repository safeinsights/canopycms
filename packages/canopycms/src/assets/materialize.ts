/**
 * Writing transform outputs into the store. Server-only.
 *
 * `storeTransform` computes one key and is shared by the authenticated raw route
 * (api/assets.ts), `materializeAssets` (the batch run that writes every key a build references
 * before that build is released) and canopycms-cdk's lazy transform Lambda.
 */

import { getErrorMessage, isNodeError } from '../utils/error'
import { ASSET_PREFIXES } from './asset-prefixes'
import { loadSharp } from './sharp-loader'
import { applyTransform } from './transform'
import { canonicalizeTransformPath, type ParsedTransformPath } from './transform-directives'
import type { AssetStore, CreateOnlyResult } from './types'

/** Every transform output is stored under a content-addressed key, so it never changes. */
export const TRANSFORM_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/**
 * The object tag on every derivative the lazy transform Lambda writes. Its bucket's `assets/t/`
 * expiry filters on it, so what `materializeAssets` writes, which the Lambda's allowlist may refuse
 * to recompute, is never expired. canopycms-cdk's `AssetSupport` copies these two strings as
 * literals.
 */
export const LAZY_TRANSFORM_TAG = { key: 'canopy-transform', value: 'lazy' } as const

/**
 * `data` is the computed output whether or not it was stored: `stored: 'already-exists'` means
 * another writer stored the key first, and the store kept that object.
 */
export type StoreTransformResult =
  | { ok: true; data: Uint8Array; contentType: string; stored: CreateOnlyResult }
  | { ok: false; status: 400 | 404 | 413 | 422; error: string }

/**
 * Compute the transform `parsed` names from the asset's original and write it under `key`: the
 * canonical key, or that key beneath an output prefix. `parsed` must come from
 * `canonicalizeTransformPath`, so the stored pixels always match their key. A rejection is a fact
 * about the asset or the URL and is never worth retrying; a thrown error belongs to the store or
 * the environment. A 404's `error` names what was missing, so a caller answering a browser
 * replaces it.
 */
export async function storeTransform(
  store: AssetStore,
  parsed: ParsedTransformPath,
  key: string,
  options: { tags?: Readonly<Record<string, string>> } = {},
): Promise<StoreTransformResult> {
  const meta = await store.getMeta(parsed.hash32)
  if (!meta) {
    return { ok: false, status: 404, error: `Asset ${parsed.hash32} has no meta in the store` }
  }
  if (meta.kind !== 'raster') {
    return { ok: false, status: 400, error: 'Not a raster asset - svg/pdf are served statically' }
  }

  // The slug is decorative in the URL but load-bearing in the stored key, so it must equal the
  // asset's real slug — the parser only enforces `[a-z0-9-]+`, and any other string that passes
  // it aliases the same image into a new cache key.
  if (parsed.slug !== meta.slug) {
    return {
      ok: false,
      status: 404,
      error: `Slug '${parsed.slug}' is not asset ${parsed.hash32}'s slug '${meta.slug}'`,
    }
  }

  // Without an explicit `f=`, the transform keeps the source format, so the URL's `{ext}` must be
  // the source's real ext. The parser cannot check this: it does not know the source format.
  const requestedFormat = parsed.directives.identity ? undefined : parsed.directives.format
  if (requestedFormat === undefined && parsed.ext !== meta.ext) {
    return { ok: false, status: 400, error: 'Extension does not match the source format' }
  }

  const original = await store.readOriginal(parsed.hash32, meta.ext)
  if (!original) {
    return { ok: false, status: 404, error: `Asset ${parsed.hash32} has no original in the store` }
  }

  const transformed = await applyTransform(
    { data: original.data, ext: original.ext },
    parsed.directives,
  )
  if (!transformed.ok) {
    return { ok: false, status: transformed.status, error: transformed.error }
  }

  const stored = await store.putPublicObject({
    key,
    data: transformed.data,
    contentType: transformed.contentType,
    cacheControl: TRANSFORM_CACHE_CONTROL,
    tags: options.tags,
  })
  return { ok: true, data: transformed.data, contentType: transformed.contentType, stored }
}

/** One key a build references, and where it was referenced, for the failure report. */
export interface MaterializeTarget {
  /** `assets/t/{directives}/{hash32}/{slug}.{ext}`. */
  key: string
  routes: readonly string[]
  files: readonly string[]
}

/**
 * `content`: the key cannot be produced from what the store holds (asset deleted, wrong slug,
 * undecodable input, malformed key), so a retry would fail the same way and the page must change.
 * `store`: the store kept failing, or refused the request outright; rerunning may succeed.
 */
type MaterializeFailureKind = 'content' | 'store'

export type MaterializeResult = {
  key: string
  routes: string[]
  files: string[]
} & (
  | { status: 'existed' | 'created' | 'copied' }
  | { status: 'failed'; failure: MaterializeFailureKind; error: string }
)

/** The `schemaVersion` of every `MaterializeReport`; a consumer gating on the JSON checks it. */
export const MATERIALIZE_REPORT_SCHEMA_VERSION = 1

export interface MaterializeReport {
  schemaVersion: typeof MATERIALIZE_REPORT_SCHEMA_VERSION
  /** `MaterializeOptions.outputPrefix`, present only when one was given. */
  outputPrefix?: string
  summary: {
    total: number
    existed: number
    created: number
    /** Keys copied from the canonical prefix into an output prefix; 0 until one is configured. */
    copied: number
    failed: number
    contentFailures: number
    storeFailures: number
  }
  /** Sorted by key. */
  results: MaterializeResult[]
}

export interface MaterializeOptions {
  store: AssetStore
  targets: readonly MaterializeTarget[]
  /**
   * `assets/{hash32}/{slug}.{ext}` keys (svg, pdf) a build references. These are only checked:
   * finalize writes them at upload, so a missing one is a content failure nothing here can fix,
   * unless the bucket itself is missing, which is a store failure.
   */
  statics?: readonly MaterializeTarget[]
  /**
   * Write every key `k` at `outputPrefix + k` instead, for a build whose writes must never land
   * where production reads (a PR preview). A key production already stores is copied from there;
   * the rest are transformed from the canonical originals. Production's own run, with no prefix,
   * never reads beneath it. See `assertValidOutputPrefix` for what is accepted.
   */
  outputPrefix?: string
  /** Store requests in flight at once. Default 8. */
  concurrency?: number
  /**
   * Transforms in flight at once. Each holds a decoded image, up to about 1.2 GiB at
   * `MAX_INPUT_PIXELS`, so this stays small whatever `concurrency` is. Default 2.
   */
  transformConcurrency?: number
  /**
   * A directive string referenced by at least this many keys has its whole `assets/t/{directives}/`
   * prefix listed once instead of a HEAD per key, when the store can list. Default 100.
   */
  listThreshold?: number
  /** Attempts per store operation, including the first. Default 3. */
  attempts?: number
  /** First retry delay; each later one doubles. Default 500. */
  baseDelayMs?: number
  /** @internal Test seam for the retry delay. */
  sleep?: (ms: number) => Promise<void>
}

/** sharp cannot load in this process, so nothing missing can be produced here. */
export class SharpUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `sharp failed to load, so the missing transform outputs cannot be produced in this ` +
        `environment: ${getErrorMessage(cause)}. Install sharp for this platform and rerun.`,
    )
    this.name = 'SharpUnavailableError'
  }
}

/** `MaterializeOptions.outputPrefix` broke a rule of `assertValidOutputPrefix`; nothing was read or written. */
export class InvalidOutputPrefixError extends Error {
  constructor(prefix: string, reason: string) {
    super(`Invalid output prefix ${JSON.stringify(prefix)}: ${reason}`)
    this.name = 'InvalidOutputPrefixError'
  }
}

const OUTPUT_PREFIX_SEGMENT_RE = /^[A-Za-z0-9._-]+$/
const CANOPY_PREFIX_SEGMENTS = Object.values(ASSET_PREFIXES).map((prefix) => prefix.split('/'))

/**
 * Throws `InvalidOutputPrefixError` unless `prefix` is relative, ends in `/`, and is a run of
 * `[A-Za-z0-9._-]` segments, none empty, `.` or `..`, whose first segments are not a canopy
 * prefix. Production trusts whatever is under its own prefixes, so a write beneath one is a write
 * production serves. Compared by segment: `assets-x/` is accepted, `assets/x/` is not.
 */
export function assertValidOutputPrefix(prefix: string): void {
  const refuse = (reason: string) => {
    throw new InvalidOutputPrefixError(prefix, reason)
  }
  if (prefix.startsWith('/')) refuse('it must be relative, with no leading /')
  if (!prefix.endsWith('/')) refuse('it must end in /')
  const segments = prefix.slice(0, -1).split('/')
  for (const segment of segments) {
    if (segment === '') refuse('it has an empty segment')
    if (segment === '.' || segment === '..') refuse(`it has a ${segment} segment`)
    if (!OUTPUT_PREFIX_SEGMENT_RE.test(segment)) {
      refuse(`segment ${JSON.stringify(segment)} has a character outside [A-Za-z0-9._-]`)
    }
  }
  const canopy = CANOPY_PREFIX_SEGMENTS.find((prefixSegments) =>
    prefixSegments.every((segment, i) => segments[i] === segment),
  )
  if (canopy) refuse(`it begins with the canopy prefix ${canopy.join('/')}/`)
}

const DEFAULT_CONCURRENCY = 8
const DEFAULT_TRANSFORM_CONCURRENCY = 2
// eslint-disable-next-line security/detect-non-literal-regexp -- built from a constant
const STATIC_KEY_RE = new RegExp(
  `^${ASSET_PREFIXES.public}/[a-f0-9]{32}/[a-z0-9-]+\\.[a-z0-9]{1,10}$`,
)
const DEFAULT_LIST_THRESHOLD = 100
const DEFAULT_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 500

const TRANSIENT_NODE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'EBUSY',
  'EMFILE',
])
const TRANSIENT_ERROR_NAMES = new Set([
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
  'SlowDown',
  'Throttling',
  'ThrottlingException',
  'ServiceUnavailable',
  'InternalError',
])

interface AwsErrorShape {
  name?: string
  $retryable?: unknown
  $metadata?: { httpStatusCode?: number }
}

/**
 * @internal Exported for tests. Throttling, 5xx and dropped connections are transient. Any other
 * 4xx (AccessDenied, NoSuchBucket) is a configuration fault that a retry only delays.
 */
export function isTransientStoreError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (isNodeError(err) && err.code && TRANSIENT_NODE_CODES.has(err.code)) return true
  const shaped = err as Error & AwsErrorShape
  if (shaped.$retryable) return true
  if (TRANSIENT_ERROR_NAMES.has(err.name)) return true
  const status = shaped.$metadata?.httpStatusCode
  return status !== undefined && (status === 429 || status >= 500)
}

/** Run `fn` over `items` with at most `limit` in flight. `fn` must not reject. */
async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

interface ValidTarget {
  key: string
  directives: string
  parsed: ParsedTransformPath
}

/**
 * Where a key is stored: at its destination, only at its canonical key (production's copy, under an
 * output prefix), or neither.
 */
type Presence = 'dest' | 'canonical' | 'absent'

/** A directive group's listings; an absent one was not taken or kept failing, so HEAD instead. */
interface Listings {
  dest?: ReadonlySet<string>
  canonical?: ReadonlySet<string>
}

/**
 * Make every referenced transform key exist in `store`, and check every static key does. A key
 * already stored is left alone:
 * keys are content-addressed, so an existing object is the right one. sharp is loaded only when
 * something must be transformed, and a sharp that cannot load throws `SharpUnavailableError` rather
 * than failing each key. An invalid `outputPrefix` throws `InvalidOutputPrefixError` first.
 */
export async function materializeAssets(options: MaterializeOptions): Promise<MaterializeReport> {
  const { store, outputPrefix } = options
  if (outputPrefix !== undefined) assertValidOutputPrefix(outputPrefix)
  const destOf = (key: string) => (outputPrefix ?? '') + key
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
  const transformConcurrency = Math.max(
    1,
    options.transformConcurrency ?? DEFAULT_TRANSFORM_CONCURRENCY,
  )
  const listThreshold = options.listThreshold ?? DEFAULT_LIST_THRESHOLD
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS)
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const withRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation()
      } catch (err: unknown) {
        if (attempt >= attempts || !isTransientStoreError(err)) throw err
        await sleep(baseDelayMs * 2 ** (attempt - 1) * (1 + Math.random()))
      }
    }
  }

  const references = new Map<string, { routes: Set<string>; files: Set<string> }>()
  const staticKeys = new Set((options.statics ?? []).map((target) => target.key))
  for (const target of [...options.targets, ...(options.statics ?? [])]) {
    const entry = references.get(target.key) ?? { routes: new Set(), files: new Set() }
    target.routes.forEach((route) => entry.routes.add(route))
    target.files.forEach((file) => entry.files.add(file))
    references.set(target.key, entry)
  }

  type Outcome =
    | { status: 'existed' | 'created' | 'copied' }
    | { status: 'failed'; failure: MaterializeFailureKind; error: string }
  const outcomes = new Map<string, Outcome>()
  const fail = (key: string, failure: MaterializeFailureKind, error: string) =>
    outcomes.set(key, { status: 'failed', failure, error })

  // The refs file is an editable file on disk, so every key is re-validated here.
  const transformPrefix = `${ASSET_PREFIXES.transform}/`
  const valid: ValidTarget[] = []
  const validStatics: string[] = []
  for (const key of references.keys()) {
    if (staticKeys.has(key)) {
      if (STATIC_KEY_RE.test(key)) validStatics.push(key)
      else fail(key, 'content', 'Not a static asset key (expected assets/{hash32}/{slug}.{ext})')
      continue
    }
    if (!key.startsWith(transformPrefix)) {
      fail(key, 'content', `Not a transform key (expected a ${transformPrefix} prefix)`)
      continue
    }
    const segments = key.slice(transformPrefix.length).split('/')
    const canonical = canonicalizeTransformPath(segments, 'any')
    if (!canonical.ok) {
      fail(key, 'content', `Invalid transform key: ${canonical.error}`)
    } else if (!canonical.isCanonical) {
      fail(
        key,
        'content',
        `Not canonical; the stored key would be ${transformPrefix}${canonical.canonicalPath}`,
      )
    } else {
      valid.push({ key, directives: segments[0], parsed: canonical })
    }
  }

  const byDirectives = new Map<string, ValidTarget[]>()
  for (const target of valid) {
    const group = byDirectives.get(target.directives) ?? []
    group.push(target)
    byDirectives.set(target.directives, group)
  }

  const listOnce = async (prefix: string): Promise<ReadonlySet<string> | undefined> => {
    if (!store.listPublicObjectKeys) return undefined
    const listKeys = store.listPublicObjectKeys.bind(store)
    try {
      return new Set(
        await withRetry(async () => {
          const keys: string[] = []
          for await (const key of listKeys(prefix)) keys.push(key)
          return keys
        }),
      )
    } catch {
      // A listing that keeps failing costs only speed: its keys are HEADed instead, and each HEAD
      // reports its own failure.
      return undefined
    }
  }

  const listingsByDirectives = new Map<string, Listings>()
  if (store.listPublicObjectKeys) {
    for (const [directives, group] of byDirectives) {
      if (group.length < listThreshold) continue
      const listPrefix = `${transformPrefix}${directives}/`
      const dest = await listOnce(destOf(listPrefix))
      const needsCanonical =
        outputPrefix !== undefined && group.some((target) => !dest?.has(destOf(target.key)))
      const canonical = needsCanonical ? await listOnce(listPrefix) : undefined
      listingsByDirectives.set(directives, { dest, canonical })
    }
  }

  // Every presence check goes through here. Without an output prefix a key's destination is the
  // key itself, so this is one listing lookup or HEAD and never `canonical`.
  const resolvePresence = async (key: string, listings: Listings = {}): Promise<Presence> => {
    const isStored = async (storeKey: string, listing: ReadonlySet<string> | undefined) =>
      listing ? listing.has(storeKey) : withRetry(() => store.hasPublicObject(storeKey))
    const dest = destOf(key)
    if (await isStored(dest, listings.dest)) return 'dest'
    if (dest === key) return 'absent'
    return (await isStored(key, listings.canonical)) ? 'canonical' : 'absent'
  }

  const presence = new Map<string, Presence>()
  await forEachBounded(valid, concurrency, async (target) => {
    try {
      presence.set(
        target.key,
        await resolvePresence(target.key, listingsByDirectives.get(target.directives)),
      )
    } catch (err: unknown) {
      fail(target.key, 'store', `Existence check failed: ${getErrorMessage(err)}`)
    }
  })

  await forEachBounded(validStatics, concurrency, async (key) => {
    try {
      let found = await resolvePresence(key)
      // A HEAD cannot tell a missing key from a missing bucket, and a static key has no
      // transform's meta read to tell them apart afterwards; a GET names which.
      if (found === 'absent' && (await withRetry(() => store.readPublicObject(key))) !== null) {
        found = destOf(key) === key ? 'dest' : 'canonical'
      }
      presence.set(key, found)
    } catch (err: unknown) {
      fail(key, 'store', `Existence check failed: ${getErrorMessage(err)}`)
    }
  })

  const toCopy: string[] = []
  for (const [key, found] of presence) {
    if (found === 'dest') outcomes.set(key, { status: 'existed' })
    else if (found === 'canonical') toCopy.push(key)
  }

  await forEachBounded(toCopy, concurrency, async (key) => {
    try {
      let attempts = 0
      const copied = await withRetry(() => {
        attempts++
        return store.copyPublicObject(key, destOf(key))
      })
      if (copied === 'source-missing') {
        presence.set(key, 'absent')
      } else {
        // As for a transform below: after a failed attempt, `already-exists` may be its own copy.
        const copiedElsewhere = copied === 'already-exists' && attempts === 1
        outcomes.set(key, { status: copiedElsewhere ? 'existed' : 'copied' })
      }
    } catch (err: unknown) {
      fail(key, 'store', `Copy failed: ${getErrorMessage(err)}`)
    }
  })

  for (const key of validStatics) {
    if (presence.get(key) === 'absent') {
      fail(key, 'content', 'No stored object; an svg or pdf is written at upload only')
    }
  }

  const missing = valid.filter((target) => presence.get(target.key) === 'absent')
  if (missing.length > 0) {
    try {
      await loadSharp()
    } catch (err: unknown) {
      throw new SharpUnavailableError(err)
    }
  }

  await forEachBounded(missing, transformConcurrency, async (target) => {
    try {
      let attempts = 0
      const result = await withRetry(() => {
        attempts++
        return storeTransform(store, target.parsed, destOf(target.key))
      })
      if (result.ok) {
        // After a failed attempt, `already-exists` may be that attempt's own write, whose response
        // was lost, so it counts as `created`: a release waiting on its `created` keys then waits
        // on a key it may not have written, never skips one it did.
        const createdElsewhere = result.stored === 'already-exists' && attempts === 1
        outcomes.set(target.key, { status: createdElsewhere ? 'existed' : 'created' })
      } else {
        fail(target.key, 'content', `${result.status}: ${result.error}`)
      }
    } catch (err: unknown) {
      fail(target.key, 'store', getErrorMessage(err))
    }
  })

  const results: MaterializeResult[] = [...references.keys()].sort().map((key) => {
    const refs = references.get(key)
    const outcome = outcomes.get(key) ?? {
      status: 'failed' as const,
      failure: 'store' as const,
      error: 'No outcome recorded',
    }
    return {
      key,
      routes: [...(refs?.routes ?? [])].sort(),
      files: [...(refs?.files ?? [])].sort(),
      ...outcome,
    }
  })

  const count = (predicate: (result: MaterializeResult) => boolean) =>
    results.filter(predicate).length
  return {
    schemaVersion: MATERIALIZE_REPORT_SCHEMA_VERSION,
    ...(outputPrefix !== undefined ? { outputPrefix } : {}),
    summary: {
      total: results.length,
      existed: count((r) => r.status === 'existed'),
      created: count((r) => r.status === 'created'),
      copied: count((r) => r.status === 'copied'),
      failed: count((r) => r.status === 'failed'),
      contentFailures: count((r) => r.status === 'failed' && r.failure === 'content'),
      storeFailures: count((r) => r.status === 'failed' && r.failure === 'store'),
    },
    results,
  }
}
