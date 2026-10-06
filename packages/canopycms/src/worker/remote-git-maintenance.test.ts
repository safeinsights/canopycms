import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { simpleGit } from 'simple-git'

import {
  REMOTE_GIT_CONFIG,
  ensureRemoteGitConfig,
  maintainRemoteGit,
} from './remote-git-maintenance'

let tmpDir: string
let gitDir: string

const bare = (args: string[]) => simpleGit().raw(['--git-dir', gitDir, ...args])

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-remote-git-maint-'))
  gitDir = path.join(tmpDir, 'remote.git')
  await simpleGit().raw(['init', '-q', '--bare', '--initial-branch=main', gitDir])
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('ensureRemoteGitConfig', () => {
  it('corrects a differing value and sets no extensions.* key', async () => {
    await bare(['config', 'transfer.unpackLimit', '100'])

    await ensureRemoteGitConfig(gitDir)

    for (const [key, value] of REMOTE_GIT_CONFIG) {
      expect((await bare(['config', '--get', key])).trim()).toBe(value)
    }
    expect(await bare(['config', '--local', '--list'])).not.toMatch(/^extensions\./m)
  })
})

describe('maintainRemoteGit', () => {
  it('leaves a repo under both thresholds untouched', async () => {
    const work = path.join(tmpDir, 'work')
    await simpleGit().clone(gitDir, work)
    const git = simpleGit({ baseDir: work })
    await git.addConfig('user.name', 'Test Bot')
    await git.addConfig('user.email', 'test@canopycms.test')
    await fs.writeFile(path.join(work, 'a.txt'), 'a')
    await git.add('.')
    await git.commit('a')
    await git.raw(['push', '-q', 'origin', 'HEAD:main'])
    const objectsBefore = (await fs.readdir(path.join(gitDir, 'objects'))).sort()

    const result = await maintainRemoteGit(gitDir)

    expect(result).toEqual({ repacked: false, before: { loose: 3, packs: 0 } })
    expect((await fs.readdir(path.join(gitDir, 'objects'))).sort()).toEqual(objectsBefore)
  })
})
