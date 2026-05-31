import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { diffContentTrees, isContentTreeDiffEmpty } from './sync-core'

describe('diffContentTrees', () => {
  let root: string
  let workingTree: string
  let branch: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-sync-core-'))
    workingTree = path.join(root, 'wt')
    branch = path.join(root, 'br')
    await fs.mkdir(workingTree, { recursive: true })
    await fs.mkdir(branch, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  const write = async (dir: string, rel: string, content: string) => {
    const full = path.join(dir, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content)
  }

  it('reports identical trees as no divergence', async () => {
    await write(workingTree, 'a.json', '{"x":1}')
    await write(branch, 'a.json', '{"x":1}')

    const diff = await diffContentTrees(workingTree, branch)

    expect(isContentTreeDiffEmpty(diff)).toBe(true)
    expect(diff).toEqual({ added: [], removed: [], changed: [] })
  })

  it('detects added, removed, and changed files (content-based, mtime-independent)', async () => {
    await write(workingTree, 'only-wt.json', '1')
    await write(workingTree, 'shared.json', 'new')
    await write(branch, 'shared.json', 'old')
    await write(branch, 'only-br.json', '1')

    const diff = await diffContentTrees(workingTree, branch)

    expect(diff.added).toEqual(['only-wt.json'])
    expect(diff.removed).toEqual(['only-br.json'])
    expect(diff.changed).toEqual(['shared.json'])
    expect(isContentTreeDiffEmpty(diff)).toBe(false)
  })

  it('treats same content with different mtime as unchanged', async () => {
    await write(workingTree, 'a.json', 'same')
    // Write the branch copy later so its mtime differs.
    await new Promise((r) => setTimeout(r, 10))
    await write(branch, 'a.json', 'same')

    const diff = await diffContentTrees(workingTree, branch)

    expect(diff.changed).toEqual([])
    expect(isContentTreeDiffEmpty(diff)).toBe(true)
  })

  it('lists a missing branch directory as everything added', async () => {
    await write(workingTree, 'a.json', '1')
    await write(workingTree, 'sub/b.json', '2')

    const diff = await diffContentTrees(workingTree, path.join(root, 'does-not-exist'))

    expect(diff.added).toEqual(['a.json', 'sub/b.json'])
    expect(diff.removed).toEqual([])
    expect(diff.changed).toEqual([])
  })
})
