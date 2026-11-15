/** `isCleanMergeOf`'s key-blindness: a merge differing in entries' item keys alone is still clean. */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SimpleGit } from 'simple-git'

import { initTestRepo } from '../test-utils'
import { isCleanMergeOf } from './branch-merge'

const ENTRY = 'content/post.page.abc123def456.json'
const entry = (keys: [string, string], extra: Record<string, unknown> = { e: '' }) =>
  `${JSON.stringify(
    {
      title: 'T',
      items: [
        { _key: keys[0], v: 1 },
        { _key: keys[1], v: 2 },
      ],
      ...extra,
    },
    null,
    2,
  )}\n`

describe('isCleanMergeOf', () => {
  let dir: string
  let git: SimpleGit
  let [from, other] = ['', '']

  const write = async (files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) {
      await fs.mkdir(path.join(dir, path.dirname(name)), { recursive: true })
      await fs.writeFile(path.join(dir, name), text)
    }
  }
  const commit = async (message: string) => {
    await git.add(['.'])
    await git.commit(message)
    return (await git.revparse(['HEAD'])).trim()
  }
  /** The clean merge of `from` and `other`, then `change` on top of it. */
  const mergedWith = async (change: () => Promise<void>) => {
    await git.raw(['checkout', '-q', '-B', 'm', from])
    await git.raw(['merge', '-q', '--no-edit', other])
    await change()
    return commit('after the merge')
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-clean-merge-'))
    git = await initTestRepo(dir)
    await write({ [ENTRY]: entry(['k1', 'k2']), 'config/site.json': '{"a":"","n":"x"}\n' })
    const root = await commit('root')
    await write({ 'one.txt': '1\n' })
    from = await commit('one')
    await git.raw(['checkout', '-q', '-B', 'o', root])
    await write({ 'two.txt': '2\n' })
    other = await commit('two')
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('holds the clean merge, and one whose entries differ in item keys alone', async () => {
    expect(
      await isCleanMergeOf(git, await mergedWith(async () => {}), from, other, 'content'),
    ).toBe(true)
    const rekeyed = await mergedWith(() => write({ [ENTRY]: entry(['k9', 'k2']) }))
    expect(await isCleanMergeOf(git, rekeyed, from, other, 'content')).toBe(true)
  })

  it('refuses any other change, empty or outside the content root', async () => {
    const emptied = await mergedWith(() => write({ [ENTRY]: entry(['k1', 'k2'], {}) }))
    expect(await isCleanMergeOf(git, emptied, from, other, 'content')).toBe(false)
    const config = await mergedWith(() => write({ 'config/site.json': '{"n":"x"}\n' }))
    expect(await isCleanMergeOf(git, config, from, other, 'content')).toBe(false)
    const keysOutside = await mergedWith(async () => {
      await fs.mkdir(path.join(dir, 'other'), { recursive: true })
      await fs.copyFile(path.join(dir, ENTRY), path.join(dir, 'other/post.page.abc123def456.json'))
    })
    expect(await isCleanMergeOf(git, keysOutside, from, other, 'content')).toBe(false)
    const mode = await mergedWith(() => fs.chmod(path.join(dir, ENTRY), 0o755))
    expect(await isCleanMergeOf(git, mode, from, other, 'content')).toBe(false)
  })
})
