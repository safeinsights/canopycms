/**
 * What finding people remembers between requests, under `{workspaceRoot}/.people/`: outside every
 * branch clone, so no branch scan reads it, and the same in dev and prod.
 *
 * - `seen/<base64url(userId)>`: a write-once empty marker for someone who opened the editor while
 *   holding a group that reaches content (api/people.ts `enrolSeenUser`). The name is the id, so
 *   one `readdir` lists the set. Created by temp + `link()`, so it needs no lock: `EEXIST` means
 *   another request recorded them first.
 * - `shares/<sha256(sharerId)>.json`: whom one person shared branches with, and when. Written only
 *   by that person's own requests, under the mutable-JSON recipe of docs/concurrency.md, but taking
 *   the file lock try-once: a busy lock skips the record rather than delaying the share.
 *
 * Losing either is harmless: people are enrolled again on their next visit, and suggestions start
 * over. Nothing here is memoized across requests but the ids this process has already recorded.
 */

import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { CanopyUserId } from './types'
import { withLock } from './utils/async-mutex'
import { getErrorMessage, isFileExistsError, isNotFoundError } from './utils/error'
import { canopyLogWarn } from './utils/logger'
import { withOccFileLock, withOccRetry, writeOccJsonFile } from './utils/occ-json-write'

/** The `.people` folder under a workspace root. */
export const PEOPLE_DIR = '.people'

const hashId = (id: string): string => createHash('sha256').update(id, 'utf8').digest('hex')

/**
 * The longest marker name: well under the 255 bytes a filename may take, leaving room for the
 * temp file's prefix and suffix. It holds an id of up to 150 bytes.
 */
const MAX_MARKER_NAME = 200
const MARKER_NAME = /^[A-Za-z0-9_-]+$/

/** `userId` as a marker name: base64url, so no `/`, `.` or `..`; undefined when it won't fit. */
function markerName(userId: CanopyUserId): string | undefined {
  const name = Buffer.from(userId, 'utf8').toString('base64url')
  return name.length > 0 && name.length <= MAX_MARKER_NAME ? name : undefined
}

/** The id a marker name holds, or undefined for a name no marker of this store would have. */
function idOfMarker(name: string): CanopyUserId | undefined {
  if (name.length > MAX_MARKER_NAME || !MARKER_NAME.test(name)) return undefined
  const id = Buffer.from(name, 'base64url').toString('utf8')
  return markerName(id) === name ? id : undefined
}

/** Ids too long to record as seen that this process has reported, so each is logged once. */
const reportedTooLong = new Set<CanopyUserId>()

/** Shares older than this are dropped on write and ignored on read. */
const RETENTION_MONTHS = 12

interface SharesFile {
  v: 1
  sharedWith: Record<CanopyUserId, string>
}

export interface RecentShare {
  userId: CanopyUserId
  at: string
}

const cutoffOf = (now: Date): number => {
  const cutoff = new Date(now)
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS)
  return cutoff.getTime()
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The entries of a parsed shares file still within the retention window; anything else drops. */
function liveShares(parsed: Record<string, unknown>, now: Date): Record<CanopyUserId, string> {
  const live: Record<CanopyUserId, string> = {}
  if (parsed.v !== 1 || !isPlainObject(parsed.sharedWith)) return live
  const cutoff = cutoffOf(now)
  for (const [userId, at] of Object.entries(parsed.sharedWith)) {
    if (typeof at !== 'string') continue
    const time = Date.parse(at)
    if (Number.isFinite(time) && time >= cutoff) live[userId] = at
  }
  return live
}

/** Shares files this process has reported as unreadable, so each is logged once. */
const reportedCorrupt = new Set<string>()

function reportCorrupt(filePath: string, reason: string): void {
  if (reportedCorrupt.has(filePath)) return
  reportedCorrupt.add(filePath)
  canopyLogWarn(`[canopy] Recent shares file unreadable, read as empty: ${filePath}: ${reason}`)
}

export class PeopleStore {
  private readonly seenDir: string
  private readonly sharesDir: string
  private readonly settleMs: number | undefined
  /** Ids this process has recorded as seen, so a repeat visit costs no fs call. */
  private readonly recorded = new Set<CanopyUserId>()

  constructor(peopleRoot: string, options?: { settleMs?: number }) {
    // Resolved, so the shares file's in-process lock key is one spelling.
    const root = path.resolve(peopleRoot)
    this.seenDir = path.join(root, 'seen')
    this.sharesDir = path.join(root, 'shares')
    this.settleMs = options?.settleMs
  }

  /** Whether this process already recorded `userId` as seen. */
  hasRecordedSeen(userId: CanopyUserId): boolean {
    return this.recorded.has(userId)
  }

  /**
   * Records `userId` as seen; a no-op when anyone already has. An id too long for a marker name is
   * not recorded, and logged once: such a person is found only as any other CMS user is.
   */
  async recordSeen(userId: CanopyUserId): Promise<void> {
    if (this.recorded.has(userId)) return
    const name = markerName(userId)
    if (!name) {
      if (!reportedTooLong.has(userId)) {
        reportedTooLong.add(userId)
        canopyLogWarn(`[canopy] A user id is too long to record as seen (${userId.length} chars)`)
      }
      return
    }
    await fs.mkdir(this.seenDir, { recursive: true })
    // Dot-prefixed, so a listing never reads a temp file as a marker.
    const temp = path.join(this.seenDir, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      await fs.writeFile(temp, '')
      await fs.link(temp, path.join(this.seenDir, name)).catch((err: unknown) => {
        if (!isFileExistsError(err)) throw err
      })
    } finally {
      await fs.unlink(temp).catch(() => {})
    }
    this.recorded.add(userId)
  }

  /**
   * Every id recorded as seen, from one `readdir`. A missing folder is an empty set; any other
   * failure rejects, so an unreadable folder never passes for nobody.
   */
  async listSeen(): Promise<Set<CanopyUserId>> {
    let names: string[]
    try {
      names = await fs.readdir(this.seenDir)
    } catch (err: unknown) {
      if (isNotFoundError(err)) return new Set()
      throw err
    }
    const ids = new Set<CanopyUserId>()
    for (const name of names) {
      const id = idOfMarker(name)
      if (id !== undefined) ids.add(id)
    }
    return ids
  }

  /**
   * Removes `userId`'s seen marker, resolving whether there was one. Another process that recorded
   * them keeps skipping the write until it restarts; they are enrolled again here on their next
   * qualifying visit.
   */
  async removeSeen(userId: CanopyUserId): Promise<boolean> {
    this.recorded.delete(userId)
    const name = markerName(userId)
    if (!name) return false
    try {
      await fs.unlink(path.join(this.seenDir, name))
      return true
    } catch (err: unknown) {
      if (isNotFoundError(err)) return false
      throw err
    }
  }

  private sharesFile(sharerId: CanopyUserId): string {
    return path.join(this.sharesDir, `${hashId(sharerId)}.json`)
  }

  /** Whom `sharerId` shared with in the last 12 months, newest first. */
  async recentShares(sharerId: CanopyUserId, now = new Date()): Promise<RecentShare[]> {
    const filePath = this.sharesFile(sharerId)
    let content: string
    try {
      content = await fs.readFile(filePath, 'utf8')
    } catch (err: unknown) {
      if (isNotFoundError(err)) return []
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (err: unknown) {
      reportCorrupt(filePath, getErrorMessage(err))
      return []
    }
    if (!isPlainObject(parsed)) {
      reportCorrupt(filePath, 'not an object')
      return []
    }
    return Object.entries(liveShares(parsed, now))
      .map(([userId, at]) => ({ userId, at }))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  }

  /**
   * Records that `sharerId` shared with each of `userIds` at `now`, dropping shares past the
   * retention window. A file that does not parse is replaced. Rejects, recording nothing, when
   * another process holds the file's lock, even a crashed one not yet stale.
   */
  async recordShares(
    sharerId: CanopyUserId,
    userIds: readonly CanopyUserId[],
    now = new Date(),
  ): Promise<void> {
    if (userIds.length === 0) return
    const filePath = this.sharesFile(sharerId)
    // withOccFileLock creates only the lock's own folder.
    await fs.mkdir(this.sharesDir, { recursive: true })
    await withLock(filePath, () =>
      withOccFileLock(filePath, () => this.writeShares(filePath, userIds, now), { tryOnce: true }),
    )
  }

  private writeShares(filePath: string, userIds: readonly CanopyUserId[], now: Date) {
    return withOccRetry(async () => {
      const { sharedWith, version } = await this.loadForWrite(filePath, now)
      const at = now.toISOString()
      for (const userId of userIds) sharedWith[userId] = at
      const next: SharesFile = { v: 1, sharedWith }
      await writeOccJsonFile(
        filePath,
        { ...next },
        { expectedVersion: version, settleMs: this.settleMs },
      )
    })
  }

  /**
   * The live shares and the version to write over. Called under the file's lock, so a file that
   * does not parse is removed here, and the write then creates it afresh.
   */
  private async loadForWrite(
    filePath: string,
    now: Date,
  ): Promise<{ sharedWith: Record<CanopyUserId, string>; version: number | null }> {
    let content: string
    try {
      content = await fs.readFile(filePath, 'utf8')
    } catch (err: unknown) {
      if (isNotFoundError(err)) return { sharedWith: {}, version: null }
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      parsed = undefined
    }
    if (!isPlainObject(parsed)) {
      await fs.rm(filePath, { force: true })
      return { sharedWith: {}, version: null }
    }
    const version = typeof parsed.version === 'number' ? parsed.version : 0
    return { sharedWith: liveShares(parsed, now), version }
  }
}
