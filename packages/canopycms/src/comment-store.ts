import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { withLock } from './utils/async-mutex'
import {
  writeOccJsonFile,
  withOccRetry,
  withOccFileLock,
  OccWriteConflictError,
} from './utils/occ-json-write'

/**
 * Error thrown when a concurrent modification is detected.
 * Operations that encounter this error will automatically retry.
 */
export class CommentStoreConflictError extends Error {
  constructor() {
    super('Concurrent modification detected')
    this.name = 'CommentStoreConflictError'
  }
}

export type CommentType = 'field' | 'entry' | 'branch'

export interface Comment {
  id: string
  threadId: string
  userId: string
  timestamp: string // ISO string for individual comment
  text: string
  // Note: No resolved flag on individual comments
}

export interface CommentThread {
  id: string
  comments: Comment[] // Sorted by timestamp (oldest first)
  resolved: boolean // Applies to entire thread
  createdAt: string // ISO string, timestamp of first comment (for sorting)
  resolvedBy?: string // userId who resolved (for audit trail)
  resolvedAt?: string // ISO string
  type: CommentType
  authorId: string // userId of thread creator (for resolve permission)

  // Addressing (all optional based on type)
  entryPath?: string // Required for field/entry, undefined for branch
  canopyPath?: string // Required for field, undefined for entry/branch
}

export interface CommentsFile {
  schemaVersion: number
  version: number // Incremented on each write for optimistic locking
  writeId?: string // Unique ID for each write, used to verify write ownership
  threads: Record<string, CommentThread>
}

/**
 * Manages comment storage for a branch workspace.
 * Comments are stored in .canopy-meta/comments.json and are NOT committed to git.
 *
 * Mutators are protected by three layers, outermost to innermost:
 *
 * 1. {@link withLock} - an in-process FIFO mutex keyed by the resolved file
 *    path. Serializes concurrent mutators on the SAME process/host
 *    deterministically, so racing `resolveThread`/`deleteThread`/`addComment`
 *    calls against the same store (or two store instances pointed at the
 *    same branch) never race each other's load-modify-write cycle.
 * 2. {@link withOccFileLock} - a server-enforced, cross-process/cross-host
 *    lock (proper-lockfile, mkdir-based). This is the actual fix for lost
 *    comments across two warm Lambda containers on EFS, where rename-based
 *    OCC verification alone is unreliable (see guarantee doc on
 *    `utils/occ-json-write.ts`).
 * 3. {@link withOccRetry} around {@link writeOccJsonFile} - version/writeId
 *    based optimistic concurrency control. With layers 1-2 in place this is
 *    now a defense-in-depth backstop only (e.g. a stale process from a
 *    rolling deploy writing without the lock), not the primary safety
 *    mechanism.
 *
 * See `utils/occ-json-write.ts` for full guarantee documentation of layers 2-3.
 */
export class CommentStore {
  private readonly filePath: string
  private readonly settleMs: number | undefined

  constructor(branchRoot: string, options?: { settleMs?: number }) {
    // Resolve so two differently-spelled paths to the same branch root map
    // to the same in-process lock key (see withLock).
    this.filePath = path.join(path.resolve(branchRoot), '.canopy-meta', 'comments.json')
    this.settleMs = options?.settleMs
  }

  /**
   * Load comments file for read-only access.
   */
  async load(): Promise<CommentsFile> {
    const { data } = await this.loadWithVersion()
    return data
  }

  /**
   * Load comments file along with the version observed at load time. Used by
   * mutators, which need the version as a LOCAL value threaded through their
   * load-modify-write cycle rather than shared mutable instance state (so
   * concurrent mutate cycles on the same instance never clobber each other's
   * expected version).
   */
  private async loadWithVersion(): Promise<{ data: CommentsFile; version: number | null }> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(content) as CommentsFile
      // Backward compat: treat missing version as 0
      const version = parsed.version ?? 0
      return { data: { ...parsed, version }, version }
    } catch {
      // File doesn't exist yet, return empty structure
      return {
        data: {
          schemaVersion: 1,
          version: 0,
          threads: {},
        },
        version: null,
      }
    }
  }

  /**
   * Write comments file via the shared OCC helper.
   *
   * Throws the helper's raw {@link OccWriteConflictError} so the surrounding
   * {@link withOccRetry} in withMutation() recognizes and retries it;
   * translation to the public `CommentStoreConflictError` contract happens at
   * the withMutation() boundary, after retries are exhausted.
   *
   * Note: comment-store historically wrote without a trailing newline;
   * `writeOccJsonFile`'s default (`trailingNewline: false`) preserves that.
   */
  private async writeData(data: CommentsFile, expectedVersion: number | null): Promise<void> {
    await writeOccJsonFile(
      this.filePath,
      { ...data },
      {
        expectedVersion,
        settleMs: this.settleMs,
      },
    )
  }

  /**
   * Run a mutate cycle (load -> modify -> write) under the full lock +
   * OCC-retry stack described in the class doc comment. A conflict that
   * survives every retry surfaces as the public `CommentStoreConflictError`.
   */
  private async withMutation<T>(
    operation: (data: CommentsFile, version: number | null) => Promise<T>,
  ): Promise<T> {
    try {
      return await withLock(this.filePath, () =>
        withOccFileLock(this.filePath, () =>
          withOccRetry(async () => {
            const { data, version } = await this.loadWithVersion()
            return operation(data, version)
          }),
        ),
      )
    } catch (err) {
      if (err instanceof OccWriteConflictError) {
        throw new CommentStoreConflictError()
      }
      throw err
    }
  }

  async addComment(options: {
    userId: string
    text: string
    threadId?: string
    type: CommentType
    entryPath?: string
    canopyPath?: string
  }): Promise<{ threadId: string; commentId: string }> {
    // Generate IDs outside the mutation so they stay stable across retries
    const threadId = options.threadId || randomUUID()
    const commentId = randomUUID()

    return this.withMutation(async (data, version) => {
      const timestamp = new Date().toISOString()

      const comment: Comment = {
        id: commentId,
        threadId,
        userId: options.userId,
        timestamp,
        text: options.text,
      }

      if (!data.threads[threadId]) {
        // Create new thread
        data.threads[threadId] = {
          id: threadId,
          comments: [comment],
          resolved: false,
          createdAt: timestamp,
          type: options.type,
          authorId: options.userId,
          entryPath: options.entryPath,
          canopyPath: options.canopyPath,
        }
      } else {
        // Add to existing thread
        data.threads[threadId].comments.push(comment)
      }

      await this.writeData(data, version)
      return { threadId, commentId }
    })
  }

  async resolveThread(threadId: string, userId: string): Promise<boolean> {
    return this.withMutation(async (data, version) => {
      if (!data.threads[threadId]) {
        return false
      }

      data.threads[threadId].resolved = true
      data.threads[threadId].resolvedBy = userId
      data.threads[threadId].resolvedAt = new Date().toISOString()

      await this.writeData(data, version)
      return true
    })
  }

  async listThreads(options?: { includeResolved?: boolean }): Promise<CommentThread[]> {
    const data = await this.load()
    const threads = Object.values(data.threads)

    if (options?.includeResolved === false) {
      return threads.filter((t) => !t.resolved)
    }

    return threads
  }

  async getThread(threadId: string): Promise<CommentThread | null> {
    const data = await this.load()
    return data.threads[threadId] || null
  }

  async deleteThread(threadId: string): Promise<boolean> {
    return this.withMutation(async (data, version) => {
      if (!data.threads[threadId]) {
        return false
      }

      delete data.threads[threadId]
      await this.writeData(data, version)
      return true
    })
  }

  /**
   * Get all threads for a specific field
   */
  async getThreadsForField(entryPath: string, canopyPath: string): Promise<CommentThread[]> {
    const data = await this.load()
    return Object.values(data.threads)
      .filter((t) => t.type === 'field' && t.entryPath === entryPath && t.canopyPath === canopyPath)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * Get all threads for a specific entry (not field-specific)
   */
  async getThreadsForEntry(entryPath: string): Promise<CommentThread[]> {
    const data = await this.load()
    return Object.values(data.threads)
      .filter((t) => t.type === 'entry' && t.entryPath === entryPath)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * Get all branch-level threads
   */
  async getBranchThreads(): Promise<CommentThread[]> {
    const data = await this.load()
    return Object.values(data.threads)
      .filter((t) => t.type === 'branch')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
}
