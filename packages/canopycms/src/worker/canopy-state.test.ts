import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SimpleGit } from 'simple-git'

import { initTestRepo } from '../test-utils'
import { restoreRetiredSchemaCache } from './canopy-state'

/**
 * restoreRetiredSchemaCache is the one step in the sync loop that discards bytes in a clone, so
 * these pin exactly what it may touch.
 */
describe('restoreRetiredSchemaCache', () => {
  let repo: string
  let git: SimpleGit

  const STATE_FILES = [
    'schema-cache.json',
    'branch.json',
    'comments.json',
    'content-index.generation',
    'schema.generation',
  ]
  const metaPath = (file: string) => path.join(repo, '.canopy-meta', file)

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-state-'))
    git = await initTestRepo(repo)
    await fs.writeFile(path.join(repo, 'a.md'), 'a')
  })

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true })
  })

  async function commitTracked(files: string[]): Promise<void> {
    await fs.mkdir(path.join(repo, '.canopy-meta'), { recursive: true })
    for (const file of files) await fs.writeFile(metaPath(file), `committed ${file}`)
    await git.add(['.'])
    await git.commit('repo tracks canopycms state')
  }

  it('restores only the schema cache, leaving every other tracked, modified state file alone', async () => {
    await commitTracked(STATE_FILES)
    for (const file of STATE_FILES) await fs.writeFile(metaPath(file), `live ${file}`)

    await expect(restoreRetiredSchemaCache(git, await git.status())).resolves.toBe(true)

    await expect(fs.readFile(metaPath('schema-cache.json'), 'utf8')).resolves.toBe(
      'committed schema-cache.json',
    )
    for (const file of STATE_FILES.filter((f) => f !== 'schema-cache.json')) {
      await expect(fs.readFile(metaPath(file), 'utf8')).resolves.toBe(`live ${file}`)
    }
    const stillModified = (await git.status()).files.map((f) => f.path).sort()
    expect(stillModified).toEqual(
      STATE_FILES.filter((f) => f !== 'schema-cache.json')
        .map((f) => `.canopy-meta/${f}`)
        .sort(),
    )
  })

  it('restores a tracked schema cache that was deleted', async () => {
    await commitTracked(['schema-cache.json'])
    await fs.rm(metaPath('schema-cache.json'))

    await expect(restoreRetiredSchemaCache(git, await git.status())).resolves.toBe(true)
    await expect(fs.readFile(metaPath('schema-cache.json'), 'utf8')).resolves.toBe(
      'committed schema-cache.json',
    )
  })

  it('does nothing when the schema cache is untracked', async () => {
    await git.add(['.'])
    await git.commit('no canopycms state tracked')
    await fs.mkdir(path.join(repo, '.canopy-meta'))
    await fs.writeFile(metaPath('schema-cache.json'), 'untracked')

    await expect(restoreRetiredSchemaCache(git, await git.status())).resolves.toBe(false)
    await expect(fs.readFile(metaPath('schema-cache.json'), 'utf8')).resolves.toBe('untracked')
  })

  it('does nothing when the schema cache is staged but not in HEAD', async () => {
    await git.add(['.'])
    await git.commit('no canopycms state tracked')
    await fs.mkdir(path.join(repo, '.canopy-meta'))
    await fs.writeFile(metaPath('schema-cache.json'), 'staged')
    await git.add(['.canopy-meta/schema-cache.json'])

    await expect(restoreRetiredSchemaCache(git, await git.status())).resolves.toBe(false)
    await expect(fs.readFile(metaPath('schema-cache.json'), 'utf8')).resolves.toBe('staged')
  })

  it('does nothing when the tracked schema cache is unmodified', async () => {
    await commitTracked(['schema-cache.json'])

    await expect(restoreRetiredSchemaCache(git, await git.status())).resolves.toBe(false)
  })
})
