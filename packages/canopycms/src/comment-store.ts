import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'

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
  threads: Record<string, CommentThread>
}

/**
 * Manages comment storage for a branch workspace.
 * Comments are stored in .canopycms/comments.json and are NOT committed to git.
 */
export class CommentStore {
  private filePath: string

  constructor(branchRoot: string) {
    this.filePath = path.join(branchRoot, '.canopycms', 'comments.json')
  }

  async load(): Promise<CommentsFile> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8')
      return JSON.parse(content)
    } catch (err) {
      // File doesn't exist yet, return empty structure
      return {
        schemaVersion: 1,
        threads: {},
      }
    }
  }

  async save(data: CommentsFile): Promise<void> {
    // Ensure directory exists
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8')
  }

  async addComment(options: {
    userId: string
    text: string
    threadId?: string
    type: CommentType
    entryId?: string
    canopyPath?: string
  }): Promise<{ threadId: string; commentId: string }> {
    const data = await this.load()

    const threadId = options.threadId || randomUUID()
    const commentId = randomUUID()
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

    await this.save(data)
    return { threadId, commentId }
  }

  async resolveThread(threadId: string, userId: string): Promise<boolean> {
    const data = await this.load()

    if (!data.threads[threadId]) {
      return false
    }

    data.threads[threadId].resolved = true
    data.threads[threadId].resolvedBy = userId
    data.threads[threadId].resolvedAt = new Date().toISOString()

    await this.save(data)
    return true
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
    const data = await this.load()

    if (!data.threads[threadId]) {
      return false
    }

    delete data.threads[threadId]
    await this.save(data)
    return true
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
