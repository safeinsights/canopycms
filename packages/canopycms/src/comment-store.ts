import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'

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
  entryId?: string // Required for field/entry, undefined for branch
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
 * Uses optimistic locking with retry to handle concurrent modifications safely.
 * This is non-blocking - conflicts are detected via version mismatch and retried.
 */
export class CommentStore {
  private filePath: string
  private loadedVersion: number | null = null

  constructor(branchRoot: string) {
    this.filePath = path.join(branchRoot, '.canopy-meta', 'comments.json')
  }

  /**
   * Load comments file. Tracks version for optimistic locking.
   */
  async load(): Promise<CommentsFile> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8')
      const data = JSON.parse(content) as CommentsFile
      // Backward compat: treat missing version as 0
      this.loadedVersion = data.version ?? 0
      return { ...data, version: this.loadedVersion }
    } catch {
      // File doesn't exist yet, return empty structure
      this.loadedVersion = null
      return {
        schemaVersion: 1,
        version: 0,
        threads: {},
      }
    }
  }

  /**
   * Save comments file with optimistic locking.
   * Uses atomic temp-file write to prevent corruption.
   *
   * For new files (expectedVersion === null): uses exclusive create to prevent races
   * For existing files: uses atomic rename with post-write verification
   *
   * @throws CommentStoreConflictError if version has changed since load
   */
  private async save(data: CommentsFile, expectedVersion: number | null): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })

    // Increment version and generate unique write ID for ownership verification
    // New files start at version 1, existing files increment by 1
    const newVersion = expectedVersion === null ? 1 : expectedVersion + 1
    const writeId = randomUUID()
    const newData = { ...data, version: newVersion, writeId }
    const content = JSON.stringify(newData, null, 2)
    const tempPath = `${this.filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`

    if (expectedVersion === null) {
      // New file case: use exclusive create flag to prevent race
      // If file already exists, this will throw EEXIST
      try {
        await fs.writeFile(this.filePath, content, { flag: 'wx' })
        return
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          // File was created by another process, conflict
          throw new CommentStoreConflictError()
        }
        throw err
      }
    }

    // Existing file case: write to temp, atomic rename, then verify we won
    await fs.writeFile(tempPath, content, 'utf-8')

    try {
      // First check: verify expected version before rename
      let currentVersion: number | null = null
      try {
        const current = JSON.parse(await fs.readFile(this.filePath, 'utf-8'))
        currentVersion = current.version ?? 0
      } catch {
        currentVersion = null
      }

      if (currentVersion !== expectedVersion) {
        throw new CommentStoreConflictError()
      }

      // Atomic rename
      await fs.rename(tempPath, this.filePath)

      // Post-write verification with settling delay
      // Wait a small amount to let concurrent renames complete, then verify our writeId
      await new Promise((resolve) => setTimeout(resolve, 5))

      const afterWrite = JSON.parse(await fs.readFile(this.filePath, 'utf-8'))
      if (afterWrite.writeId !== writeId) {
        // Another process won the race - our write was overwritten
        throw new CommentStoreConflictError()
      }
    } catch (err) {
      // Clean up temp file on any error (may already be renamed away)
      await fs.unlink(tempPath).catch(() => {})
      throw err
    }
  }

  /**
   * Retry an operation that may fail due to concurrent modification.
   * Non-blocking - reloads and retries on conflict with exponential backoff.
   */
  private async withRetry<T>(operation: () => Promise<T>, maxAttempts = 10): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation()
      } catch (err) {
        if (err instanceof CommentStoreConflictError && attempt < maxAttempts) {
          // Reset loaded version and retry with exponential backoff + jitter
          this.loadedVersion = null
          const baseDelay = Math.min(10 * Math.pow(2, attempt - 1), 100) // 10, 20, 40, 80, 100ms cap
          const jitter = Math.random() * baseDelay
          await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter))
          continue
        }
        throw err
      }
    }
    throw new Error('Unreachable')
  }

  async addComment(options: {
    userId: string
    text: string
    threadId?: string
    type: CommentType
    entryId?: string
    canopyPath?: string
  }): Promise<{ threadId: string; commentId: string }> {
    // Generate IDs outside retry so they stay stable across retries
    const threadId = options.threadId || randomUUID()
    const commentId = randomUUID()

    return this.withRetry(async () => {
      const data = await this.load()
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
          entryId: options.entryId,
          canopyPath: options.canopyPath,
        }
      } else {
        // Add to existing thread
        data.threads[threadId].comments.push(comment)
      }

      await this.save(data, this.loadedVersion)
      return { threadId, commentId }
    })
  }

  async resolveThread(threadId: string, userId: string): Promise<boolean> {
    return this.withRetry(async () => {
      const data = await this.load()

      if (!data.threads[threadId]) {
        return false
      }

      data.threads[threadId].resolved = true
      data.threads[threadId].resolvedBy = userId
      data.threads[threadId].resolvedAt = new Date().toISOString()

      await this.save(data, this.loadedVersion)
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
    return this.withRetry(async () => {
      const data = await this.load()

      if (!data.threads[threadId]) {
        return false
      }

      delete data.threads[threadId]
      await this.save(data, this.loadedVersion)
      return true
    })
  }

  /**
   * Get all threads for a specific field
   */
  async getThreadsForField(entryId: string, canopyPath: string): Promise<CommentThread[]> {
    const data = await this.load()
    return Object.values(data.threads)
      .filter((t) => t.type === 'field' && t.entryId === entryId && t.canopyPath === canopyPath)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * Get all threads for a specific entry (not field-specific)
   */
  async getThreadsForEntry(entryId: string): Promise<CommentThread[]> {
    const data = await this.load()
    return Object.values(data.threads)
      .filter((t) => t.type === 'entry' && t.entryId === entryId)
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
