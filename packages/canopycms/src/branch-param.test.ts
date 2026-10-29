import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildInitialBranchMetadata } from './branch-metadata'
import { resolveBranchParam, shortNameOf, type BranchParamConfig } from './branch-param'
import { operatingStrategy } from './operating-mode'
import { sanitizeBranchName } from './paths/branch-name'

let root: string
let branchesRoot: string

/** A workspace at `key` (the sanitized `name` unless given) whose branch.json names `name`. */
async function workspace(name: string, key: string = sanitizeBranchName(name)): Promise<void> {
  const dir = path.join(branchesRoot, key, '.canopy-meta')
  await fs.mkdir(dir, { recursive: true })
  const meta = buildInitialBranchMetadata({ branch: { name, createdBy: 'u1' } })
  await fs.writeFile(path.join(dir, 'branch.json'), JSON.stringify(meta))
}

const config: BranchParamConfig = {
  mode: 'dev',
  defaultBaseBranch: 'main',
  defaultActiveBranch: 'develop',
}

/** The stored name of the branch `param` resolves to, or null. */
async function resolved(param: string, overrides: Partial<BranchParamConfig> = {}) {
  const context = await resolveBranchParam(
    param,
    { ...config, ...overrides },
    { basePathOverride: root },
  )
  return context?.branch.name ?? null
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-branch-param-'))
  branchesRoot = operatingStrategy('dev').getContentBranchesRoot(root)
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('resolveBranchParam', () => {
  it('resolves a namespace branch by its short name, and by its full ref', async () => {
    await workspace('canopycms/local/spring')
    expect(await resolved('spring')).toBe('canopycms/local/spring')
    expect(await resolved('canopycms/local/spring')).toBe('canopycms/local/spring')
  })

  it('resolves a branch outside the namespace by its full name only', async () => {
    await workspace('legacy/update')
    expect(await resolved('legacy/update')).toBe('legacy/update')
    // Its key is not its name.
    expect(await resolved('legacy-update')).toBeNull()
  })

  it('opens a branch outside the namespace that a short name shadows only by its exact form', async () => {
    await workspace('canopycms/local/spring')
    await workspace('spring')
    expect(await resolved('spring')).toBe('canopycms/local/spring')
    expect(await resolved('canopycms/local/spring')).toBe('canopycms/local/spring')
    expect(await resolved('refs/heads/spring')).toBe('spring')
    expect(await resolved('refs/heads/canopycms/local/spring')).toBe('canopycms/local/spring')
  })

  it('never resolves the exact form by a short name, or by a key that is not the name', async () => {
    await workspace('canopycms/local/summer')
    await workspace('canopycms-local-autumn')
    expect(await resolved('refs/heads/summer')).toBeNull()
    expect(await resolved('refs/heads/canopycms/local/autumn')).toBeNull()
  })

  it('refuses a workspace whose stored name is not the ref its key was built from', async () => {
    // `canopycms-local-spring` is the key of `canopycms/local/spring`, and of this name too.
    await workspace('canopycms-local-spring')
    expect(await resolved('spring')).toBeNull()
    expect(await resolved('canopycms-local-spring')).toBe('canopycms-local-spring')
  })

  it('resolves the base and active branches first, so no namespace branch shadows them', async () => {
    await workspace('main')
    await workspace('develop')
    await workspace('canopycms/local/main')
    await workspace('canopycms/local/develop')
    expect(await resolved('main')).toBe('main')
    expect(await resolved('develop')).toBe('develop')
  })

  it('resolves the base and active branches by their key, whatever name the workspace holds', async () => {
    await workspace('feat-x', 'feat-x')
    expect(await resolved('feat/x', { defaultActiveBranch: 'feat/x' })).toBe('feat-x')
  })

  it("follows the config's namespace", async () => {
    await workspace('cms/local/spring')
    expect(await resolved('spring', { branchNamespace: 'cms/{deployment}/' })).toBe(
      'cms/local/spring',
    )
    expect(await resolved('spring')).toBeNull()
  })

  it('still resolves a full name when the namespace cannot be resolved', async () => {
    await workspace('legacy-update')
    expect(await resolved('legacy-update', { branchNamespace: 'no-slash' })).toBe('legacy-update')
  })

  it('answers null for a name with no workspace', async () => {
    expect(await resolved('nothing-here')).toBeNull()
  })
})

describe('shortNameOf', () => {
  it("strips this CMS's namespace, and leaves any other name whole", () => {
    expect(shortNameOf(config, 'canopycms/local/spring')).toBe('spring')
    expect(shortNameOf(config, 'canopycms/prod/spring')).toBe('canopycms/prod/spring')
    expect(shortNameOf({ ...config, mode: 'prod' }, 'canopycms/prod/spring')).toBe('spring')
  })

  it('keeps the full ref when the short name is the base or active branch, which resolve first', async () => {
    expect(shortNameOf(config, 'canopycms/local/main')).toBe('canopycms/local/main')
    expect(shortNameOf(config, 'canopycms/local/develop')).toBe('canopycms/local/develop')
    const noActive = { mode: 'dev', defaultBaseBranch: 'trunk' } as const
    expect(shortNameOf(noActive, 'canopycms/local/trunk')).toBe('canopycms/local/trunk')
    expect(shortNameOf(noActive, 'canopycms/local/main')).toBe('main')

    // The name it gives resolves back to the branch.
    await workspace('main')
    await workspace('canopycms/local/main')
    expect(await resolved(shortNameOf(config, 'canopycms/local/main'))).toBe('canopycms/local/main')
  })
})
