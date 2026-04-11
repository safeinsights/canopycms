import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'

import { isNotFoundError } from './utils/error'
import { atomicWriteFile } from './utils/atomic-write'

export interface AssetItem {
  key: string
  url?: string
  size?: number
  contentType?: string
  updatedAt?: string
}

export interface AssetStore {
  list(prefix?: string): Promise<AssetItem[]>
  upload(key: string, data: Buffer | Uint8Array, contentType?: string): Promise<AssetItem>
  delete(key: string): Promise<void>
  getSignedUrl?(key: string, expiresInSeconds?: number): Promise<string>
}

export interface LocalAssetStoreOptions {
  root: string
  publicBaseUrl?: string
}

const normalizeKey = (key: string) => key.replace(/^\/+/, '')

/**
 * Local filesystem asset store for dev and tests. In production, swap with S3 adapter.
 */
export class LocalAssetStore implements AssetStore {
  private readonly root: string
  private readonly publicBaseUrl?: string

  constructor(options: LocalAssetStoreOptions) {
    this.root = path.resolve(options.root)
    this.publicBaseUrl = options.publicBaseUrl?.replace(/\/+$/, '')
  }

  private resolvePath(key: string): string {
    const clean = normalizeKey(key)
    const resolved = path.resolve(this.root, clean)
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep
    if (resolved !== this.root && !resolved.startsWith(rootWithSep)) {
      throw new Error('Path traversal detected')
    }
    return resolved
  }

  private toUrl(key: string): string | undefined {
    if (!this.publicBaseUrl) return undefined
    return `${this.publicBaseUrl}/${normalizeKey(key)}`
  }

  async list(prefix = ''): Promise<AssetItem[]> {
    const dir = this.resolvePath(prefix)
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err: unknown) {
      if (isNotFoundError(err)) return []
      throw err
    }
    const items: AssetItem[] = []
    for (const entry of entries) {
      if (entry.isDirectory()) continue
      const key = path.join(prefix, entry.name).split(path.sep).join('/')
      const stat = await fs.stat(path.join(dir, entry.name))
      items.push({
        key,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        url: this.toUrl(key),
      })
    }
    return items
  }

  async upload(key: string, data: Buffer | Uint8Array, contentType?: string): Promise<AssetItem> {
    const filePath = this.resolvePath(key)
    await atomicWriteFile(filePath, data)
    const stat = await fs.stat(filePath)
    return {
      key: normalizeKey(key),
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
      url: this.toUrl(key),
      contentType,
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolvePath(key)
    try {
      await fs.unlink(filePath)
    } catch (err: unknown) {
      if (isNotFoundError(err)) return
      throw err
    }
  }

  async getSignedUrl(key: string): Promise<string> {
    const url = this.toUrl(key)
    if (!url) {
      throw new Error('Public base URL not configured')
    }
    return url
  }
}
