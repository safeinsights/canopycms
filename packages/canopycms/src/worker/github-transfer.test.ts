import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { GitHubGateway } from './github-gateway'
import { unreachableFrom, type TransferContext } from './github-transfer'

const execFileAsync = promisify(execFile)
const git = async (...args: string[]) => (await execFileAsync('git', args)).stdout.trim()

let root: string
let repo: string
const ctx = (): TransferContext => ({
  github: () => ({}) as GitHubGateway,
  remoteGitPath: repo,
  taskTimeoutMs: 30_000,
})

/** A commit in `repo` on `parent`, if any, with nothing else in it. */
async function commit(message: string, parent?: string): Promise<string> {
  const tree = await git('--git-dir', repo, 'hash-object', '-t', 'tree', '-w', '/dev/null')
  return git(
    '--git-dir',
    repo,
    '-c',
    'user.name=x',
    '-c',
    'user.email=x@y',
    'commit-tree',
    tree,
    ...(parent ? ['-p', parent] : []),
    '-m',
    message,
  )
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-transfer-')))
  repo = path.join(root, 'repo.git')
  await git('init', '-q', '--bare', repo)
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('unreachableFrom', () => {
  it('names exactly the IDs that are not a commit a tip reaches', async () => {
    const base = await commit('base')
    const tipCommit = await commit('tip', base)
    const aside = await commit('aside', base)
    const blob = await git('--git-dir', repo, 'hash-object', '-w', '/dev/null')
    const missing = 'e'.repeat(40)

    const unreachable = await unreachableFrom(
      ctx(),
      repo,
      [base, tipCommit, aside, blob, missing, 'not-an-id'],
      [tipCommit],
    )

    expect([...unreachable].sort()).toEqual([aside, blob, missing, 'not-an-id'].sort())
  })

  it('counts an annotated tag as the commit it points at', async () => {
    const base = await commit('base')
    const aside = await commit('aside')
    const tagFile = path.join(root, 'tag')
    const tagOf = async (target: string, name: string) => {
      await fs.writeFile(
        tagFile,
        `object ${target}\ntype commit\ntag ${name}\ntagger x <x@y> 1700000000 +0000\n\n${name}\n`,
      )
      return git('--git-dir', repo, 'hash-object', '-t', 'tag', '-w', tagFile)
    }
    const onTip = await tagOf(base, 'on-tip')
    const offTip = await tagOf(aside, 'off-tip')

    const unreachable = await unreachableFrom(ctx(), repo, [onTip, offTip], [base])

    expect([...unreachable]).toEqual([offTip])
  })

  it('names none when there is nothing to check', async () => {
    expect(await unreachableFrom(ctx(), repo, [], [])).toEqual(new Set())
  })
})
