import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GITHUB_TRACKING_REF_PREFIX } from '../git-manager'
import { BUNDLE_HEADER_MAX_BYTES } from './bundle-header'
import type { GitHubGateway } from './github-gateway'
import { fetchGitHubIntoRemoteGit, unreachableFrom, type TransferContext } from './github-transfer'

const execFileAsync = promisify(execFile)
const git = async (...args: string[]) => (await execFileAsync('git', args)).stdout.trim()

let root: string
let repo: string
const ctx = (): TransferContext => ({
  github: () => ({}) as GitHubGateway,
  remoteGitPath: repo,
  taskTimeoutMs: 30_000,
})

/** A commit in `repo` (or `into`) on `parent`, if any, with nothing else in it. */
async function commit(message: string, parent?: string, into = repo): Promise<string> {
  const tree = await git('--git-dir', into, 'hash-object', '-t', 'tree', '-w', '/dev/null')
  return git(
    '--git-dir',
    into,
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

describe('fetchGitHubIntoRemoteGit', () => {
  let github: string

  beforeEach(async () => {
    github = path.join(root, 'github.git')
    await git('init', '-q', '--bare', github)
  })

  /**
   * `github`'s `branches` as a fetch would answer with them, bundled less `exclude`, the bundle's
   * bytes as `open` serves them from its file.
   */
  async function gatewayFor(
    branches: string[],
    exclude: string[],
    open: (file: string) => Readable | Promise<Readable> = createReadStream,
  ): Promise<TransferContext> {
    const tips = new Map(
      (await git('--git-dir', github, 'for-each-ref', '--format=%(refname:lstrip=2) %(objectname)'))
        .split('\n')
        .map((line) => line.split(' ') as [string, string]),
    )
    const refs = new Map(branches.map((branch) => [branch, tips.get(branch) ?? '']))
    const file = path.join(root, 'fetch.bundle')
    await git(
      '--git-dir',
      github,
      'bundle',
      'create',
      '-q',
      file,
      ...branches,
      ...exclude.map((id) => `^${id}`),
    )
    return {
      ...ctx(),
      github: () =>
        ({
          fetch: async () => ({ refs, bundleId: 'b' }),
          openBundle: async () => open(file),
        }) as unknown as GitHubGateway,
    }
  }

  const trackingRefs = () =>
    git('--git-dir', repo, 'for-each-ref', '--format=%(refname)', GITHUB_TRACKING_REF_PREFIX)

  it('refuses a bundle whose prerequisite is not a commit here, before any ref moves', async () => {
    // `bundle unbundle`'s own check is not run (see `unbundle`), so nothing else stops a tracking
    // ref landing on a commit whose parent this repository never had.
    const base = await commit('base', undefined, github)
    const tip = await commit('tip', base, github)
    await git('--git-dir', github, 'update-ref', 'refs/heads/main', tip)

    await expect(fetchGitHubIntoRemoteGit(await gatewayFor(['main'], [base]))).rejects.toThrow(
      `Refusing the bundle: its prerequisite ${base} is not a commit here`,
    )
    expect(await trackingRefs()).toBe('')
    await expect(git('--git-dir', repo, 'cat-file', '-e', tip)).rejects.toThrow()
  })

  it('refuses a prerequisite that is here but is not a commit', async () => {
    const base = await commit('base', undefined, github)
    const tip = await commit('tip', base, github)
    await git('--git-dir', github, 'update-ref', 'refs/heads/main', tip)
    await commit('base', undefined, repo)
    const blob = await git('--git-dir', repo, 'hash-object', '-w', '/dev/null')
    const asBlob = async (file: string) =>
      Readable.from([
        Buffer.from((await fs.readFile(file, 'latin1')).replace(base, blob), 'latin1'),
      ])

    await expect(
      fetchGitHubIntoRemoteGit(await gatewayFor(['main'], [base], asBlob)),
    ).rejects.toThrow(`Refusing the bundle: its prerequisite ${blob} is not a commit here`)
    expect(await trackingRefs()).toBe('')
  })

  it('fails, moving no ref, when the bundle ends before its header does', async () => {
    await git(
      '--git-dir',
      github,
      'update-ref',
      'refs/heads/main',
      await commit('tip', undefined, github),
    )
    const cut = () => Readable.from([Buffer.from('# v2 git bundle\n')])

    await expect(fetchGitHubIntoRemoteGit(await gatewayFor(['main'], [], cut))).rejects.toThrow(
      'The bundle ended before its header did',
    )
    expect(await trackingRefs()).toBe('')
  })

  it('stops waiting for a header that never arrives, on abort and on inactivity', async () => {
    // No git runs while the header is read, so nothing else would end the wait.
    await git(
      '--git-dir',
      github,
      'update-ref',
      'refs/heads/main',
      await commit('tip', undefined, github),
    )
    const silent = new PassThrough()
    const aborted = new AbortController()
    // Aborted once the bundle is open, so it is the header's wait that the abort ends.
    const gateway = await gatewayFor(['main'], [], () => {
      setTimeout(() => aborted.abort(), 50)
      return silent
    })

    await expect(fetchGitHubIntoRemoteGit(gateway, aborted.signal)).rejects.toThrow(
      'Reading the bundle was aborted',
    )
    expect(silent.destroyed).toBe(true)

    const idle = {
      ...(await gatewayFor(['main'], [], () => new PassThrough())),
      taskTimeoutMs: 100,
    }
    await expect(fetchGitHubIntoRemoteGit(idle)).rejects.toThrow(
      'The bundle sent nothing for 100ms',
    )
    expect(await trackingRefs()).toBe('')
  })

  it("takes a bundle whose header outgrows a pushed bundle's bound", async () => {
    // A fetch bundle names every branch GitHub moved; a push bundle names one.
    const tip = await commit('tip', undefined, github)
    const name = (i: number) => `refs/heads/branch-${String(i).padStart(200, '0')}`
    const count = Math.ceil(BUNDLE_HEADER_MAX_BYTES / (41 + name(0).length)) + 1
    await execFileAsync('sh', [
      '-c',
      `for i in $(seq 0 ${count - 1}); do printf 'create refs/heads/branch-%0200d ${tip}\\n' "$i"; done | git --git-dir="$1" update-ref --stdin`,
      'sh',
      github,
    ])
    const branches = Array.from({ length: count }, (_, i) => name(i).slice('refs/heads/'.length))

    const { refs } = await fetchGitHubIntoRemoteGit(await gatewayFor(branches, []))

    expect(refs.size).toBe(count)
    expect((await trackingRefs()).split('\n')).toHaveLength(count)
  })
})
