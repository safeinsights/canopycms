/**
 * Writing transform outputs into the store. Server-only.
 *
 * `storeTransform` computes one key and is shared by the authenticated raw route
 * (api/assets.ts) and `materializeAssets`, the batch run that writes every key a build
 * references before that build is released. The transform Lambda in canopycms-cdk keeps its
 * own S3 plumbing around the same checks and an equal Cache-Control string.
 */

import { getErrorMessage, isNodeError } from '../utils/error'
import { ASSET_PREFIXES } from './asset-prefixes'
import { loadSharp } from './sharp-loader'
import { applyTransform } from './transform'
import { canonicalizeTransformPath, type ParsedTransformPath } from './transform-directives'
import type { AssetStore } from './types'

/** Every transform output is stored under a content-addressed key, so it never changes. */
export const TRANSFORM_CACHE_CONTROL = 'public, max-age=31536000, immutable'

export type StoreTransformResult =
  | { ok: true; data: Uint8Array; contentType: string }
  | { ok: false; status: 400 | 404 | 413 | 422; error: string }

/**
 * Compute the transform `parsed` names from the asset's original and write it under
 * `canonicalKey`. `parsed` must come from `canonicalizeTransformPath`, so the stored pixels
 * always match their key. A rejection is a fact about the asset or the URL and is never worth
 * retrying; a thrown error belongs to the store or the environment. A 404's `error` names what
 * was missing, so a caller answering a browser replaces it.
 */
export async function storeTransform(
  store: AssetStore,
  parsed: ParsedTransformPath,
  canonicalKey: string,
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
  // it aliases the same image into a new cache key. The prod transform Lambda
  // (canopycms-cdk's lambda/asset-transform/handler.ts) makes the same check; the two must agree,
  // or the authenticated route accepts URLs the public path 404s.
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

  const original = await store.readOriginal(parsed.hash32)
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

  await store.putPublicObject({
    key: canonicalKey,
    data: transformed.data,
    contentType: transformed.contentType,
    cacheControl: TRANSFORM_CACHE_CONTROL,
  })
  return { ok: true, data: transformed.data, contentType: transformed.contentType }
}

/** @internal One key a build references, and where it was referenced, for the failure report. */
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
  | { status: 'existed' | 'created' }
  | { status: 'failed'; failure: MaterializeFailureKind; error: string }
)

export interface MaterializeReport {
  summary: {
    total: number
    existed: number
    created: number
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
  /** Store requests in flight at once. Default 8. */
  concurrency?: number
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

const DEFAULT_CONCURRENCY = 8
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
 * Make every referenced transform key exist in `store`, and check every static key does. A key
 * already stored is left alone:
 * keys are content-addressed, so an existing object is the right one. sharp is loaded only when
 * something is missing, and a sharp that cannot load throws `SharpUnavailableError` rather than
 * failing each key.
 */
export async function materializeAssets(options: MaterializeOptions): Promise<MaterializeReport> {
  const { store } = options
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
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
    | { status: 'existed' | 'created' }
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
    const canonical = canonicalizeTransformPath(segments)
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

  const toHead: ValidTarget[] = []
  for (const [directives, group] of byDirectives) {
    if (store.listPublicObjectKeys && group.length >= listThreshold) {
      const listPrefix = `${transformPrefix}${directives}/`
      const listKeys = store.listPublicObjectKeys.bind(store)
      try {
        const found = await withRetry(async () => {
          const keys: string[] = []
          for await (const key of listKeys(listPrefix)) keys.push(key)
          return keys
        })
        const listed = new Set(found)
        for (const target of group) {
          if (listed.has(target.key)) outcomes.set(target.key, { status: 'existed' })
        }
        continue
      } catch {
        // A listing that keeps failing costs only speed: HEAD the group instead, and let each
        // HEAD report its own failure.
      }
    }
    toHead.push(...group)
  }

  await forEachBounded(toHead, concurrency, async (target) => {
    try {
      if (await withRetry(() => store.hasPublicObject(target.key))) {
        outcomes.set(target.key, { status: 'existed' })
      }
    } catch (err: unknown) {
      fail(target.key, 'store', `Existence check failed: ${getErrorMessage(err)}`)
    }
  })

  await forEachBounded(validStatics, concurrency, async (key) => {
    try {
      // A HEAD cannot tell a missing key from a missing bucket, and a static key has no
      // transform's meta read to tell them apart afterwards; a GET names which.
      const exists =
        (await withRetry(() => store.hasPublicObject(key))) ||
        (await withRetry(() => store.readPublicObject(key))) !== null
      if (exists) {
        outcomes.set(key, { status: 'existed' })
      } else {
        fail(key, 'content', 'No stored object; an svg or pdf is written at upload only')
      }
    } catch (err: unknown) {
      fail(key, 'store', `Existence check failed: ${getErrorMessage(err)}`)
    }
  })

  const missing = valid.filter((target) => !outcomes.has(target.key))
  if (missing.length > 0) {
    try {
      await loadSharp()
    } catch (err: unknown) {
      throw new SharpUnavailableError(err)
    }
  }

  await forEachBounded(missing, concurrency, async (target) => {
    try {
      const result = await withRetry(() => storeTransform(store, target.parsed, target.key))
      if (result.ok) {
        outcomes.set(target.key, { status: 'created' })
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
    summary: {
      total: results.length,
      existed: count((r) => r.status === 'existed'),
      created: count((r) => r.status === 'created'),
      failed: count((r) => r.status === 'failed'),
      contentFailures: count((r) => r.status === 'failed' && r.failure === 'content'),
      storeFailures: count((r) => r.status === 'failed' && r.failure === 'store'),
    },
    results,
  }
}
