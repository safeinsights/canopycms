import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'

export interface Comment {
  id: string
  threadId: string
  userId: string
  timestamp: string
  text: string
  resolved: boolean
  filePath?: string
  lineNumber?: number
  type: 'review' | 'discussion'
}

export interface CommentThread {
  id: string
  comments: Comment[]
  resolved: boolean
  filePath?: string
  lineRange?: { start: number; end: number }
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

  constructor(metadataRoot: string) {
    this.filePath = path.join(metadataRoot, 'comments.json')
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
    filePath?: string
    lineNumber?: number
    type?: 'review' | 'discussion'
  }): Promise<{ threadId: string; commentId: string }> {
    const data = await this.load()

    const threadId = options.threadId || randomUUID()
    const commentId = randomUUID()

    const comment: Comment = {
      id: commentId,
      threadId,
      userId: options.userId,
      timestamp: new Date().toISOString(),
      text: options.text,
      resolved: false,
      filePath: options.filePath,
      lineNumber: options.lineNumber,
      type: options.type || 'discussion',
    }

    if (!data.threads[threadId]) {
      // Create new thread
      data.threads[threadId] = {
        id: threadId,
        comments: [comment],
        resolved: false,
        filePath: options.filePath,
        lineRange: options.lineNumber
          ? { start: options.lineNumber, end: options.lineNumber }
          : undefined,
      }
    } else {
      // Add to existing thread
      data.threads[threadId].comments.push(comment)
    }

    await this.save(data)
    return { threadId, commentId }
  }

  async resolveThread(threadId: string): Promise<boolean> {
    const data = await this.load()

    if (!data.threads[threadId]) {
      return false
    }

    data.threads[threadId].resolved = true
    // Mark all comments in thread as resolved
    data.threads[threadId].comments.forEach((c) => {
      c.resolved = true
    })

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
}
