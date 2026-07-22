/**
 * Filesystem-backed AssetStore for dev and tests. Mirrors the same
 * bucket-prefix layout as S3AssetStore (see keys.ts) so content behaves
 * identically across adapters.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { getErrorMessage, isFileExistsError, isNotFoundError } from '../utils/error'
import { atomicWriteFile } from '../utils/atomic-write'
import { ASSET_PREFIXES, metaKey, originalKey, stagingKey } from './keys'
import type {
  AssetMeta,
  AssetStore,
  BeginUploadInput,
  PublicObject,
  StagedUploadTarget,
} from './types'

export interface LocalAssetStoreOptions {
  /** Root directory. The five bucket prefixes are created as subdirectories under it. */
  root: string
}

/** Matches S3AssetStore's default; local has no separate configuration knob for it. */
const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const DEFAULT_LIST_LIMIT = 24
const HEADERS_SIDECAR_SUFFIX = '.headers.json'

/** Side-channel headers persisted next to a blob (filesystem has no native HTTP header storage). */
interface StoredHeaders {
  contentType?: string
  contentDisposition?: string
  cacheControl?: string
}

export class LocalAssetStore implements AssetStore {
  readonly capabilities = { directUpload: false }
  private readonly root: string

  constructor(options: LocalAssetStoreOptions) {
    this.root = path.resolve(options.root)
  }

  /**
   * Resolve a store key to an absolute filesystem path, guarding against
   * escape from the root. Keys are internally generated (never taken
   * verbatim from user input), but this guard is kept as defense-in-depth
   * (ported from the v1 LocalAssetStore).
   *
   * A naive `resolved.startsWith(root)` check would let a sibling directory
   * that merely shares the root's name as a prefix (e.g. root `.../assets`,
   * sibling `.../assets-evil`) pass. Comparing against `root + path.sep`
   * closes that gap.
   */
  private resolveKey(key: string): string {
    const resolved = path.resolve(this.root, key)
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep
    if (resolved !== this.root && !resolved.startsWith(rootWithSep)) {
      throw new Error(`Path traversal detected for key: ${key}`)
    }
    return resolved
  }

  private headersSidecarPath(filePath: string): string {
    return `${filePath}${HEADERS_SIDECAR_SUFFIX}`
  }

  private async writeHeadersSidecar(filePath: string, headers: StoredHeaders): Promise<void> {
    await atomicWriteFile(this.headersSidecarPath(filePath), JSON.stringify(headers))
  }

  private async readHeadersSidecar(filePath: string): Promise<StoredHeaders> {
    try {
      const raw = await fs.readFile(this.headersSidecarPath(filePath), 'utf-8')
      return JSON.parse(raw) as StoredHeaders
    } catch (err: unknown) {
      if (isNotFoundError(err)) return {}
      throw err
    }
  }

  private async readFileOrNull(filePath: string): Promise<Uint8Array | null> {
    try {
      const buf = await fs.readFile(filePath)
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null
      throw err
    }
  }

  private async writeFile(filePath: string, data: Uint8Array): Promise<void> {
    await atomicWriteFile(filePath, Buffer.from(data))
  }

  private async deleteFileIfPresent(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath)
    } catch (err: unknown) {
      if (!isNotFoundError(err)) throw err
    }
    // Best-effort sidecar cleanup; a missing sidecar is not an error.
    await fs.unlink(this.headersSidecarPath(filePath)).catch(() => {})
  }

  async beginUpload(_input: BeginUploadInput): Promise<StagedUploadTarget> {
    return {
      mode: 'proxied',
      stagingKey: stagingKey(randomUUID()),
      maxBytes: DEFAULT_MAX_UPLOAD_BYTES,
    }
  }

  async writeStaging(key: string, data: Uint8Array, _contentType?: string): Promise<void> {
    await this.writeFile(this.resolveKey(key), data)
  }

  async readStaging(key: string): Promise<Uint8Array | null> {
    return this.readFileOrNull(this.resolveKey(key))
  }

  async deleteStaging(key: string): Promise<void> {
    await this.deleteFileIfPresent(this.resolveKey(key))
  }

  async putOriginal(input: {
    hash32: string
    ext: string
    data: Uint8Array
    contentType: string
  }): Promise<void> {
    const filePath = this.resolveKey(originalKey(input.hash32, input.ext))
    await this.writeFile(filePath, input.data)
    await this.writeHeadersSidecar(filePath, { contentType: input.contentType })
  }

  async readOriginal(
    hash32: string,
  ): Promise<{ data: Uint8Array; ext: string; contentType?: string } | null> {
    const dir = this.resolveKey(ASSET_PREFIXES.originals)
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null
      throw err
    }
    const prefix = `${hash32}.`
    const match = entries.find(
      (name) => name.startsWith(prefix) && !name.endsWith(HEADERS_SIDECAR_SUFFIX),
    )
    if (!match) return null

    const filePath = path.join(dir, match)
    const data = await this.readFileOrNull(filePath)
    if (!data) return null
    const headers = await this.readHeadersSidecar(filePath)
    return { data, ext: match.slice(prefix.length), contentType: headers.contentType }
  }

  async putPublicObject(input: {
    key: string
    data: Uint8Array
    contentType: string
    contentDisposition?: string
    cacheControl?: string
  }): Promise<void> {
    const filePath = this.resolveKey(input.key)
    await this.writeFile(filePath, input.data)
    await this.writeHeadersSidecar(filePath, {
      contentType: input.contentType,
      contentDisposition: input.contentDisposition,
      cacheControl: input.cacheControl,
    })
  }

  async readPublicObject(key: string): Promise<PublicObject | null> {
    const filePath = this.resolveKey(key)
    const data = await this.readFileOrNull(filePath)
    if (!data) return null
    const headers = await this.readHeadersSidecar(filePath)
    return {
      data,
      contentType: headers.contentType,
      contentDisposition: headers.contentDisposition,
      cacheControl: headers.cacheControl,
    }
  }

  /**
   * Atomic-exclusive create: opens with the `wx` flag so two concurrent
   * writers racing on the same hash32 have exactly one winner ('created')
   * and exactly one loser ('already-exists'). The rename-based
   * `atomicWriteFile` helper is deliberately NOT used here — a rename
   * always clobbers the destination, which would let the second writer
   * silently overwrite the first instead of losing cleanly.
   */
  async putMetaIfAbsent(hash32: string, meta: AssetMeta): Promise<'created' | 'already-exists'> {
    const filePath = this.resolveKey(metaKey(hash32))
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    try {
      await fs.writeFile(filePath, JSON.stringify(meta), { flag: 'wx' })
      return 'created'
    } catch (err: unknown) {
      if (isFileExistsError(err)) return 'already-exists'
      throw err
    }
  }

  async getMeta(hash32: string): Promise<AssetMeta | null> {
    const filePath = this.resolveKey(metaKey(hash32))
    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      return JSON.parse(raw) as AssetMeta
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null
      throw err
    }
  }

  async listMeta(input?: { cursor?: string; limit?: number }): Promise<{
    items: AssetMeta[]
    nextCursor?: string
  }> {
    const limit = input?.limit ?? DEFAULT_LIST_LIMIT
    const dir = this.resolveKey(ASSET_PREFIXES.meta)

    let filenames: string[]
    try {
      filenames = (await fs.readdir(dir)).filter((name) => name.endsWith('.json'))
    } catch (err: unknown) {
      if (isNotFoundError(err)) filenames = []
      else throw err
    }

    const all: AssetMeta[] = []
    for (const name of filenames) {
      try {
        const raw = await fs.readFile(path.join(dir, name), 'utf-8')
        all.push(JSON.parse(raw) as AssetMeta)
      } catch (err: unknown) {
        // A meta file racing with deleteMeta is expected under concurrency;
        // anything else is a real problem worth surfacing via getErrorMessage.
        if (!isNotFoundError(err)) {
          throw new Error(`Failed to read asset meta file '${name}': ${getErrorMessage(err)}`)
        }
      }
    }

    // Newest first; hash32 is the deterministic tiebreak for equal timestamps
    // (common in fast test loops using Date.now()), which keeps pagination
    // stable and duplicate/gap-free across calls.
    all.sort((a, b) => {
      if (a.uploadedAt !== b.uploadedAt) return a.uploadedAt < b.uploadedAt ? 1 : -1
      return a.hash32 < b.hash32 ? 1 : -1
    })

    let startIndex = 0
    if (input?.cursor) {
      const afterHash32 = Buffer.from(input.cursor, 'base64').toString('utf-8')
      const idx = all.findIndex((m) => m.hash32 === afterHash32)
      startIndex = idx === -1 ? 0 : idx + 1
    }

    const items = all.slice(startIndex, startIndex + limit)
    const hasMore = startIndex + limit < all.length
    const nextCursor = hasMore
      ? Buffer.from(items[items.length - 1].hash32, 'utf-8').toString('base64')
      : undefined

    return { items, nextCursor }
  }

  async deleteMeta(hash32: string): Promise<void> {
    const filePath = this.resolveKey(metaKey(hash32))
    try {
      await fs.unlink(filePath)
    } catch (err: unknown) {
      if (isNotFoundError(err)) return
      throw err
    }
  }
}
