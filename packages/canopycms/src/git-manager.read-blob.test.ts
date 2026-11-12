import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { SimpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GitManager } from './git-manager'
import { initTestRepo } from './test-utils'

describe('GitManager.readBlob', () => {
  let root: string
  let git: GitManager
  let sha: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-read-blob-'))
    const repo = await initTestRepo(root)
    await fs.writeFile(path.join(root, 'blob.txt'), 'twelve bytes', 'utf8')
    sha = (await repo.raw(['hash-object', '-w', '--', 'blob.txt'])).trim()
    git = new GitManager({ repoPath: root, baseBranch: 'main', remote: 'origin' })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  /** The simple-git client the manager runs its commands through. */
  const client = () => (git as unknown as { git: SimpleGit }).git

  it('reads a blob, refuses one over the cap, and has none for an unknown or malformed id', async () => {
    expect(await git.readBlob(sha, 1024)).toBe('twelve bytes')
    expect(await git.readBlob(sha, 11)).toBe('too-large')
    expect(await git.readBlob('0'.repeat(40), 1024)).toBeUndefined()
    expect(await git.readBlob('HEAD', 1024)).toBeUndefined()
  })

  it('fails rather than read a quiet exit as an empty blob', async () => {
    vi.spyOn(client(), 'raw').mockResolvedValueOnce('')
    await expect(git.readBlob(sha, 1024)).rejects.toThrow(/printed no size/)
    vi.spyOn(client(), 'raw').mockResolvedValueOnce('12\n').mockResolvedValueOnce('')
    await expect(git.readBlob(sha, 1024)).rejects.toThrow(/printed nothing/)
  })
})
