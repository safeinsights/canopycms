/**
 * The GitHub gateway's bundle transfer against real git: "GitHub" and remote.git are local bare
 * repositories, and pushed bundles are real ones, built by git and, for the hostile cases, edited
 * by hand. Pins what the gateway runs, where it runs it, and that nothing a pushed bundle carries
 * reaches the mirror or GitHub unless it is exactly the commit asked for.
 */

import childProcess, { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'

import type { SimpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initTestRepo, mockConsole, type MockConsole } from '../test-utils'
import { resolveWorkerGitHubAuth } from './github-auth'
import {
  createLocalGitHubGateway,
  type GitHubGateway,
  type GitHubPushAnswer,
  type GitHubPushRequest,
  type LocalGitHubGatewayOptions,
} from './github-gateway'
import { GitHubTransientError, RefusedPushError } from './github-mirror'
import { fetchGitHubIntoRemoteGit, pushToGitHub, type TransferContext } from './github-transfer'

const execFileAsync = promisify(execFile)

let root: string
let githubPath: string
let remoteGitPath: string
let stateDirectory: string
let seedPath: string
let seed: SimpleGit
let consoleSpy: MockConsole

const git = async (...args: string[]) =>
  (await execFileAsync('git', args, { maxBuffer: 64 * 1024 * 1024 })).stdout.trim()
const tip = async (gitDir: string, ref: string) =>
  git('--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', ref).catch(() => null)
const mirrorDir = () => path.join(stateDirectory, 'github.git')

/** Commit `file` on the seed's current branch and push it to `target`'s `ref`. */
async function commitAndPush(target: string, ref: string, file: string): Promise<string> {
  await fs.writeFile(path.join(seedPath, file), `${file}\n`)
  await seed.add('.')
  await seed.commit(file)
  await seed.raw(['push', '-q', '--force', target, `HEAD:${ref}`])
  return (await seed.revparse(['HEAD'])).trim()
}

function gateway(overrides: Partial<LocalGitHubGatewayOptions> = {}): GitHubGateway {
  return createLocalGitHubGateway({
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    auth: resolveWorkerGitHubAuth({ githubToken: 'fake-token' }),
    githubApp: false,
    stateDirectory,
    workspacePath: path.join(root, 'workspace'),
    timeoutMs: 30_000,
    remoteUrl: githubPath,
    ...overrides,
  })
}

function transfer(github: GitHubGateway): TransferContext {
  return { github: () => github, remoteGitPath, taskTimeoutMs: 30_000 }
}

/** Push `branch`'s tip in remote.git as the worker does, reading the tip with `readSha`. */
function pushVia(
  github: GitHubGateway,
  branch: string,
  readSha: () => Promise<string> = async () =>
    git('--git-dir', remoteGitPath, 'rev-parse', `refs/heads/${branch}`),
) {
  return pushToGitHub(
    transfer(github),
    { branch, protectedBranches: [], prerequisiteBranches: [branch, 'main'] },
    readSha,
  )
}

/** A bundle file of `revs` in `repo`, built by git. */
async function bundleOf(repo: string, ...revs: string[]): Promise<string> {
  const file = path.join(root, `bundle-${Math.random().toString(36).slice(2)}.bundle`)
  await git('--git-dir', repo, 'bundle', 'create', '-q', file, ...revs)
  return file
}

/** `file`'s pack under a header of the given lines: a bundle edited by hand. */
async function withHeader(file: string, lines: (string | Buffer)[]): Promise<string> {
  const original = await fs.readFile(file)
  const pack = original.subarray(original.indexOf('\n\n') + 2)
  const header = Buffer.concat(
    lines.map((line) => Buffer.concat([Buffer.from(line), Buffer.from('\n')])),
  )
  const edited = `${file}.edited`
  await fs.writeFile(edited, Buffer.concat([header, Buffer.from('\n'), pack]))
  return edited
}

const streamOf = async (file: string): Promise<Readable> => (await fs.open(file)).createReadStream()

const request = (branch: string, sha: string): GitHubPushRequest => ({
  branch,
  sha,
  prerequisites: [],
  protectedBranches: [],
})

/** Every file in the mirror, by path, with a hash of its bytes. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (current: string) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else {
        out[path.relative(dir, full)] = createHash('sha256')
          .update(await fs.readFile(full))
          .digest('hex')
      }
    }
  }
  await walk(dir)
  return out
}

/** Every file under `dir` whose name ends in `suffix`. */
async function filesEnding(dir: string, suffix: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (current: string) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith(suffix)) found.push(full)
    }
  }
  await walk(dir)
  return found
}

interface Spawned {
  args: string[]
  cwd: string | undefined
  env: Record<string, string | undefined>
}

const originalSpawn = childProcess.spawn

/** Record every process spawned from here on, letting `before` act first. */
function spySpawns(before?: (spawned: Spawned) => void): Spawned[] {
  const observed: Spawned[] = []
  vi.spyOn(childProcess, 'spawn').mockImplementation(((
    command: string,
    args: readonly string[],
    options: { cwd?: string; env?: Record<string, string | undefined> },
  ) => {
    const spawned = { args: [...args], cwd: options?.cwd, env: { ...(options?.env ?? {}) } }
    observed.push(spawned)
    before?.(spawned)
    return originalSpawn(command, args, options)
  }) as typeof childProcess.spawn)
  syncBuiltinESMExports()
  return observed
}

/** The git subcommand of an argv, after its `-c` pairs. */
function subcommand(args: readonly string[]): string {
  let i = 0
  while (args[i] === '-c') i += 2
  return args[i]
}

const inside = (dir: string, candidate: string) => {
  const relative = path.relative(dir, path.resolve(candidate))
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

beforeEach(async () => {
  consoleSpy = mockConsole()
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-gateway-bundle-')))
  githubPath = path.join(root, 'github.git')
  remoteGitPath = path.join(root, 'workspace', 'remote.git')
  stateDirectory = path.join(root, 'state')
  seedPath = path.join(root, 'seed')
  await fs.mkdir(seedPath)
  seed = await initTestRepo(seedPath)
  await seed.raw(['checkout', '-q', '-b', 'main'])
  await git('init', '-q', '--bare', githubPath)
  await git('init', '-q', '--bare', remoteGitPath)
})

afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  consoleSpy.restore()
  await fs.rm(root, { recursive: true, force: true })
})

/** GitHub and remote.git both at `main`, and remote.git's `feature` one commit ahead of it. */
async function featureAhead(): Promise<{ main: string; feature: string }> {
  const main = await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
  await git('--git-dir', githubPath, 'push', '-q', remoteGitPath, 'main:main')
  const feature = await commitAndPush(remoteGitPath, 'refs/heads/feature', 'feature.txt')
  return { main, feature }
}

describe('where the gateway runs git', () => {
  it('only in its state directory, with --end-of-options and no lazy fetch or replace refs', async () => {
    const { main, feature } = await featureAhead()
    const bundle = await bundleOf(remoteGitPath, 'refs/heads/feature', `^${main}`)
    const github = gateway()
    const observed = spySpawns()

    await github.prepare()
    const fetched = await github.fetch({ have: [main] })
    const opened = await github.openBundle(fetched.bundleId ?? 'none').catch(() => null)
    opened?.destroy()
    expect(await github.push(request('feature', feature))).toMatchObject({ kind: 'need-objects' })
    expect(await github.push(request('feature', feature), await streamOf(bundle))).toMatchObject({
      kind: 'pushed',
    })
    expect(await github.push(request('feature', feature))).toMatchObject({
      kind: 'pushed',
      moved: false,
    })
    await github.maintain()

    const ran = new Set(observed.map((s) => subcommand(s.args)))
    for (const expected of [
      'init',
      'fetch',
      'for-each-ref',
      'bundle',
      'cat-file',
      'rev-list',
      'rev-parse',
      'ls-remote',
      'push',
      'check-ref-format',
      'count-objects',
    ]) {
      expect(ran).toContain(expected)
    }
    for (const spawned of observed) {
      const label = spawned.args.join(' ')
      expect(spawned.cwd, label).toBeDefined()
      expect(inside(stateDirectory, spawned.cwd!), `cwd of ${label}`).toBe(true)
      expect(spawned.env.GIT_DIR, label).toBeDefined()
      expect(inside(stateDirectory, spawned.env.GIT_DIR!), `GIT_DIR of ${label}`).toBe(true)
      const gitDirArg = spawned.args.indexOf('--git-dir')
      if (gitDirArg !== -1) expect(inside(stateDirectory, spawned.args[gitDirArg + 1])).toBe(true)
      expect(spawned.env.GIT_NO_LAZY_FETCH, label).toBe('1')
      expect(spawned.env.GIT_NO_REPLACE_OBJECTS, label).toBe('1')
      if (subcommand(spawned.args) === 'check-ref-format') {
        const at = spawned.args.indexOf('check-ref-format')
        expect(spawned.args.slice(at + 1)).toEqual(['--branch', 'feature'])
      } else {
        expect(spawned.args, label).toContain('--end-of-options')
      }
    }
  })
})

describe('pushing with a bundle', () => {
  it('accepts a branch forked below the usable prerequisite: the bundle names the fork point', async () => {
    const m1 = await commitAndPush(githubPath, 'refs/heads/main', 'm1.txt')
    await commitAndPush(githubPath, 'refs/heads/main', 'm2.txt')
    const m3 = await commitAndPush(githubPath, 'refs/heads/main', 'm3.txt')
    const github = gateway()
    await fetchGitHubIntoRemoteGit(transfer(github))
    await seed.raw(['checkout', '-q', '-b', 'feature', m1])
    await commitAndPush(remoteGitPath, 'refs/heads/feature', 'f1.txt')
    const f2 = await commitAndPush(remoteGitPath, 'refs/heads/feature', 'f2.txt')
    const answers: GitHubPushAnswer[] = []
    const push = github.push.bind(github)
    vi.spyOn(github, 'push').mockImplementation(async (...args) => {
      const answer = await push(...args)
      answers.push(answer)
      return answer
    })

    await pushVia(github, 'feature')

    expect(answers[0]).toEqual({ kind: 'need-objects', usable: [m3] })
    expect(answers[1]).toMatchObject({ kind: 'pushed', to: f2 })
    expect(await tip(githubPath, 'refs/heads/feature')).toBe(f2)
  })

  it('accepts a prerequisite whose subject holds a tab and bytes that are not UTF-8', async () => {
    const base = await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    // Written as an object, since commit-tree would re-encode the message as UTF-8.
    const tree = await git('--git-dir', githubPath, 'rev-parse', `${base}^{tree}`)
    const raw = path.join(root, 'raw-commit')
    await fs.writeFile(
      raw,
      Buffer.concat([
        Buffer.from(
          `tree ${tree}\nparent ${base}\nauthor a <a@x> 1700000000 +0000\n` +
            `committer a <a@x> 1700000000 +0000\n\nt`,
        ),
        Buffer.from([0x09, 0x22, 0xff, 0xfe, 0x0a]),
      ]),
    )
    const odd = await git('--git-dir', githubPath, 'hash-object', '-t', 'commit', '-w', raw)
    await git('--git-dir', githubPath, 'update-ref', 'refs/heads/main', odd)
    await git('--git-dir', githubPath, 'push', '-q', remoteGitPath, 'main:main')
    await seed.raw(['fetch', '-q', githubPath, 'main'])
    await seed.raw(['checkout', '-q', '-B', 'feature', 'FETCH_HEAD'])
    const feature = await commitAndPush(remoteGitPath, 'refs/heads/feature', 'feature.txt')
    const bundle = await bundleOf(remoteGitPath, 'refs/heads/feature', `^${odd}`)
    expect((await fs.readFile(bundle)).includes(Buffer.from([0x09, 0x22, 0xff, 0xfe]))).toBe(true)

    const answer = await gateway().push(request('feature', feature), await streamOf(bundle))

    expect(answer).toMatchObject({ kind: 'pushed', to: feature })
    expect(await tip(githubPath, 'refs/heads/feature')).toBe(feature)
  })

  it('leaves the mirror byte for byte as it was when the ingest fails', async () => {
    const main = await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    await git('--git-dir', githubPath, 'push', '-q', remoteGitPath, 'main:main')
    const tree = await git('--git-dir', remoteGitPath, 'rev-parse', 'main^{tree}')
    const file = path.join(root, 'malformed')
    await fs.writeFile(
      file,
      `tree ${tree}\nparent ${main}\nauthor No Email 1700000000 +0000\ncommitter x <x@y> 1700000000 +0000\n\nbad\n`,
    )
    const bad = await git(
      '--git-dir',
      remoteGitPath,
      'hash-object',
      '--literally',
      '-t',
      'commit',
      '-w',
      file,
    )
    await git('--git-dir', remoteGitPath, 'update-ref', 'refs/heads/bad', bad)
    const bundle = await bundleOf(remoteGitPath, 'refs/heads/bad', `^${main}`)
    const github = gateway()
    await github.fetch({ have: [] })
    const before = await snapshot(mirrorDir())

    const caught = await github
      .push(request('bad', bad), await streamOf(bundle))
      .catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(GitHubTransientError)
    expect((caught as GitHubTransientError).code).toBe('bundle-rejected')
    expect(await snapshot(mirrorDir())).toEqual(before)
    expect(await tip(githubPath, 'refs/heads/bad')).toBeNull()
    expect(await fs.readdir(path.join(stateDirectory, 'incoming'))).toEqual([])
  })

  it('leaves every mirror head resolvable when a repack runs during the ingest', async () => {
    for (let i = 0; i < 20; i++) await commitAndPush(githubPath, 'refs/heads/main', `m${i}.txt`)
    await git('--git-dir', githubPath, 'push', '-q', remoteGitPath, 'main:main')
    const main = await tip(githubPath, 'refs/heads/main')
    const feature = await commitAndPush(remoteGitPath, 'refs/heads/feature', 'feature.txt')
    const bundle = await bundleOf(remoteGitPath, 'refs/heads/feature', `^${main}`)
    const github = gateway()
    // Loose in the mirror, so a repack moves every object.
    await github.fetch({ have: [] })
    let repack: Promise<unknown> | undefined
    spySpawns((spawned) => {
      if (subcommand(spawned.args) === 'fetch' && spawned.cwd?.endsWith('repo.git')) {
        repack = new Promise((resolve, reject) => {
          const child = originalSpawn(
            'git',
            ['--git-dir', mirrorDir(), 'repack', '-a', '-d', '--cruft', '-q'],
            { stdio: 'ignore' },
          )
          child.on('exit', (code) => (code === 0 ? resolve(undefined) : reject(code)))
        })
      }
    })

    const answer = await github.push(request('feature', feature), await streamOf(bundle))
    await repack

    expect(repack).toBeDefined()
    expect(answer).toMatchObject({ kind: 'pushed', to: feature })
    await expect(
      git('--git-dir', mirrorDir(), 'fsck', '--connectivity-only', '--no-dangling'),
    ).resolves.toBeDefined()
    expect(await tip(mirrorDir(), 'refs/heads/main^{commit}')).toBe(main)
  })

  it('walks no further than the mirror heads when it checks a pushed bundle', async () => {
    // An old blob, missing from the mirror: a walk of the whole history reaches it and fails.
    await fs.writeFile(path.join(seedPath, 'old.txt'), 'first\n')
    await seed.add('.')
    await seed.commit('old')
    const oldBlob = (await seed.raw(['rev-parse', 'HEAD:old.txt'])).trim()
    for (let i = 0; i < 10; i++) await commitAndPush(githubPath, 'refs/heads/main', `d${i}.txt`)
    await fs.writeFile(path.join(seedPath, 'old.txt'), 'second\n')
    const main = await commitAndPush(githubPath, 'refs/heads/main', 'old.txt')
    await git('--git-dir', githubPath, 'push', '-q', remoteGitPath, 'main:main')
    const feature = await commitAndPush(remoteGitPath, 'refs/heads/feature', 'feature.txt')
    const bundle = await bundleOf(remoteGitPath, 'refs/heads/feature', `^${main}`)
    const github = gateway()
    await github.fetch({ have: [] })
    const loose = path.join(mirrorDir(), 'objects', oldBlob.slice(0, 2), oldBlob.slice(2))
    await fs.rm(loose)

    const answer = await github.push(request('feature', feature), await streamOf(bundle))

    expect(answer).toMatchObject({ kind: 'pushed', to: feature })
  })
})

describe('refusing a hostile bundle', () => {
  /** The quarantine fetches spawned, which a refusal before git must not reach. */
  const quarantineFetches = (observed: Spawned[]) =>
    observed.filter((s) => subcommand(s.args) === 'fetch' && s.cwd?.endsWith('repo.git'))

  async function expectNothingPlanted(): Promise<void> {
    expect(await filesEnding(stateDirectory, '.promisor')).toEqual([])
    await expect(
      git('--git-dir', mirrorDir(), 'config', '--get-regexp', '^(remote\\..*|extensions)\\.'),
    ).rejects.toThrow()
    expect(await fs.readdir(path.join(stateDirectory, 'incoming'))).toEqual([])
  }

  it('refuses a filtered bundle before git reads it, and plants no promisor', async () => {
    const { main, feature } = await featureAhead()
    const file = path.join(root, 'filtered.bundle')
    await git(
      '--git-dir',
      remoteGitPath,
      'bundle',
      'create',
      '-q',
      file,
      '--filter=blob:none',
      'refs/heads/feature',
      `^${main}`,
    )
    const observed = spySpawns()

    const caught = await gateway()
      .push(request('feature', feature), await streamOf(file))
      .catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(GitHubTransientError)
    expect(String(caught)).toMatch(/capability/)
    expect(quarantineFetches(observed)).toEqual([])
    expect(await tip(githubPath, 'refs/heads/feature')).toBeNull()
    await expectNothingPlanted()
  })

  it('refuses a header refname that is an option, before git reads it, and plants nothing', async () => {
    const { main, feature } = await featureAhead()
    const file = await withHeader(await bundleOf(remoteGitPath, 'refs/heads/feature', `^${main}`), [
      '# v2 git bundle',
      `-${main} main.txt`,
      `${feature} --filter=blob:none`,
    ])
    const observed = spySpawns()

    const caught = await gateway()
      .push(request('feature', feature), await streamOf(file))
      .catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(GitHubTransientError)
    expect(String(caught)).toMatch(/its one head must be/)
    expect(quarantineFetches(observed)).toEqual([])
    await expectNothingPlanted()
  })

  it('refuses a head that is a blob as not a commit, and pushes nothing', async () => {
    const { main } = await featureAhead()
    const blob = await git(
      '--git-dir',
      remoteGitPath,
      'rev-parse',
      'refs/heads/feature:feature.txt',
    )
    await git('--git-dir', remoteGitPath, 'update-ref', 'refs/tags/blob', blob)
    const file = await withHeader(await bundleOf(remoteGitPath, 'refs/tags/blob', `^${main}`), [
      '# v2 git bundle',
      `${blob} refs/heads/feature`,
    ])

    const caught = await gateway()
      .push(request('feature', blob), await streamOf(file))
      .catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(RefusedPushError)
    expect(String(caught)).toMatch(/is not a commit/)
    expect(await tip(githubPath, 'refs/heads/feature')).toBeNull()
  })

  it('refuses a bundle whose head is another commit', async () => {
    const { main, feature } = await featureAhead()
    const bundle = await bundleOf(remoteGitPath, 'refs/heads/feature', `^${main}`)

    const caught = await gateway()
      .push(request('feature', main), await streamOf(bundle))
      .catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(GitHubTransientError)
    expect(String(caught)).toContain(`its one head must be ${main}`)
    expect(await tip(githubPath, 'refs/heads/feature')).toBeNull()
    expect(feature).not.toBe(main)
  })

  it.each([
    [
      'an extra head',
      (main: string, feature: string) => [
        '# v2 git bundle',
        `-${main} m`,
        `${feature} refs/heads/feature`,
        `${main} refs/heads/other`,
      ],
    ],
    [
      'a renamed head',
      (main: string, feature: string) => [
        '# v2 git bundle',
        `-${main} m`,
        `${feature} refs/heads/other`,
      ],
    ],
    [
      'a space-embedded head',
      (main: string, feature: string) => [
        '# v2 git bundle',
        `-${main} m`,
        `${feature} refs/heads/feature extra`,
      ],
    ],
  ])('refuses %s, so what is pushed is the request or nothing', async (_label, lines) => {
    const { main, feature } = await featureAhead()
    const file = await withHeader(
      await bundleOf(remoteGitPath, 'refs/heads/feature', `^${main}`),
      lines(main, feature),
    )

    const observed = spySpawns()

    const caught = await gateway()
      .push(request('feature', feature), await streamOf(file))
      .catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(GitHubTransientError)
    // Refused in node, before git parses the header its own way.
    expect(quarantineFetches(observed)).toEqual([])
    expect(await tip(githubPath, 'refs/heads/feature')).toBeNull()
    expect(await tip(githubPath, 'refs/heads/other')).toBeNull()
  })

  it('refuses a bundle larger than its cap', async () => {
    const { main, feature } = await featureAhead()
    const bundle = await bundleOf(remoteGitPath, 'refs/heads/feature', `^${main}`)
    const size = (await fs.stat(bundle)).size

    const caught = await gateway({ maxBundleBytes: size - 1 })
      .push(request('feature', feature), await streamOf(bundle))
      .catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(GitHubTransientError)
    expect(String(caught)).toContain(`larger than ${size - 1} bytes`)
    expect(await tip(githubPath, 'refs/heads/feature')).toBeNull()
    expect(
      await gateway({ maxBundleBytes: size }).push(
        request('feature', feature),
        await streamOf(bundle),
      ),
    ).toMatchObject({ kind: 'pushed' })
  })

  it('refuses a 2 MiB header line without reading it all', async () => {
    const { feature } = await featureAhead()
    let pulled = 0
    const body = Readable.from(
      (function* () {
        yield Buffer.from(`# v2 git bundle\n-${'b'.repeat(40)} `)
        for (let i = 0; i < 128; i++) {
          pulled += 16 * 1024
          yield Buffer.alloc(16 * 1024, 0x61)
        }
      })(),
    )

    const caught = await gateway()
      .push(request('feature', feature), body)
      .catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(GitHubTransientError)
    expect(String(caught)).toMatch(/does not end within 65536 bytes/)
    expect(pulled).toBeLessThan(256 * 1024)
  })

  it('refuses a prerequisite GitHub no longer has as transient', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    await seed.raw(['checkout', '-q', '-b', 'side'])
    const side = await commitAndPush(githubPath, 'refs/heads/side', 'side.txt')
    await git('--git-dir', githubPath, 'push', '-q', remoteGitPath, 'side:feature')
    const feature = await commitAndPush(remoteGitPath, 'refs/heads/feature', 'feature.txt')
    const bundle = await bundleOf(remoteGitPath, 'refs/heads/feature', `^${side}`)
    const github = gateway()
    await github.fetch({ have: [] })
    // GitHub drops the branch the bundle builds on after the worker read it.
    await git('--git-dir', githubPath, 'update-ref', '-d', 'refs/heads/side')

    const caught = await github
      .push(request('feature', feature), await streamOf(bundle))
      .catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(GitHubTransientError)
    expect((caught as GitHubTransientError).code).toBe('prerequisite-gone')
    expect(await tip(githubPath, 'refs/heads/feature')).toBeNull()
  })
})

describe('pushing without a bundle', () => {
  it('asks a fresh mirror for objects, naming the usable prerequisites', async () => {
    const { main, feature } = await featureAhead()

    const answer = await gateway().push({
      ...request('feature', feature),
      prerequisites: [main, 'f'.repeat(40)],
    })

    expect(answer).toEqual({ kind: 'need-objects', usable: [main] })
  })

  it('refuses a blob as not a commit, permanently', async () => {
    const main = await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const blob = await git('--git-dir', githubPath, 'rev-parse', `${main}:main.txt`)

    await expect(gateway().push(request('feature', blob))).rejects.toBeInstanceOf(RefusedPushError)
    expect(await tip(githubPath, 'refs/heads/feature')).toBeNull()
  })

  it('pushes an up-to-date branch in one request, with no bundle', async () => {
    await featureAhead()
    await git('--git-dir', remoteGitPath, 'push', '-q', githubPath, 'feature:feature')
    const github = gateway()
    const push = vi.spyOn(github, 'push')

    const { outcome } = await pushVia(github, 'feature')

    expect(outcome).toEqual({ moved: false, pastStaleLease: false })
    expect(push).toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0][1]).toBeUndefined()
  })

  it('never deadlocks the mirror session, whatever runs beside it', async () => {
    const { main, feature } = await featureAhead()
    const bundle = await bundleOf(remoteGitPath, 'refs/heads/feature', `^${main}`)
    const github = gateway()

    const settled = await Promise.allSettled([
      github.fetch({ have: [] }),
      github.push(request('feature', feature)),
      github.push(request('feature', feature), await streamOf(bundle)),
      github.fetch({ have: [main] }),
      github.push(request('feature', feature)),
      github.maintain(),
    ])

    expect(settled.map((s) => s.status)).toEqual(Array(6).fill('fulfilled'))
    expect(await tip(githubPath, 'refs/heads/feature')).toBe(feature)
  })
})

describe('the worker side of a push', () => {
  /** A gateway over the real one whose answers `onNeed` sees first. */
  function watched(onNeed: () => Promise<void>): GitHubGateway {
    const github = gateway()
    const push = github.push.bind(github)
    vi.spyOn(github, 'push').mockImplementation(async (req, body, signal) => {
      const answer = await push(req, body, signal)
      if (answer.kind === 'need-objects') await onNeed()
      return answer
    })
    return github
  }

  it('restarts the push from a fresh read when the branch moves while it bundles, and pushes that', async () => {
    await featureAhead()
    let moves = 0
    const github = watched(async () => {
      if (moves++ === 0) await commitAndPush(remoteGitPath, 'refs/heads/feature', 'moved.txt')
    })
    const reads: string[] = []
    const readSha = async () => {
      const sha = await git('--git-dir', remoteGitPath, 'rev-parse', 'refs/heads/feature')
      reads.push(sha)
      return sha
    }

    const pushed = await pushVia(github, 'feature', readSha)

    expect(reads).toHaveLength(2)
    expect(reads[0]).not.toBe(reads[1])
    expect(pushed.sha).toBe(reads[1])
    expect(await tip(githubPath, 'refs/heads/feature')).toBe(reads[1])
  })

  it('gives up as transient after three restarts when the branch keeps moving', async () => {
    await featureAhead()
    let moves = 0
    const github = watched(async () => {
      await commitAndPush(remoteGitPath, 'refs/heads/feature', `moved-${moves++}.txt`)
    })
    const readSha = vi.fn(async () =>
      git('--git-dir', remoteGitPath, 'rev-parse', 'refs/heads/feature'),
    )

    const caught = await pushVia(github, 'feature', readSha).catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(GitHubTransientError)
    expect((caught as GitHubTransientError).code).toBe('ref-kept-moving')
    expect(readSha).toHaveBeenCalledTimes(4)
    expect(await tip(githubPath, 'refs/heads/feature')).toBeNull()
  })

  it('reports an abort that lands before the bundle header is read as the abort', async () => {
    await featureAhead()
    const controller = new AbortController()
    const github = watched(async () => controller.abort())

    const caught = await pushToGitHub(
      transfer(github),
      { branch: 'feature', protectedBranches: [], prerequisiteBranches: ['feature', 'main'] },
      async () => git('--git-dir', remoteGitPath, 'rev-parse', 'refs/heads/feature'),
      controller.signal,
    ).catch((err: unknown) => err)

    expect(String(caught)).toMatch(/git bundle was aborted/)
    expect(await tip(githubPath, 'refs/heads/feature')).toBeNull()
  })

  it('fails at once when the gateway refuses a bundle it never read', async () => {
    await featureAhead()
    const github = gateway()
    const push = github.push.bind(github)
    vi.spyOn(github, 'push').mockImplementation(async (req, body, signal) => {
      if (body === undefined) return push(req, body, signal)
      // As a failed token mint does, before the gateway reads a byte.
      await new Promise((resolve) => setTimeout(resolve, 300))
      body.destroy()
      throw new Error('the token could not be minted')
    })
    const started = Date.now()

    const caught = await pushVia(github, 'feature').catch((err: unknown) => err)

    expect(String(caught)).toContain('the token could not be minted')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('fails at once on a prerequisite whose subject outgrows the header bound', async () => {
    const base = await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const tree = await git('--git-dir', githubPath, 'rev-parse', `${base}^{tree}`)
    const raw = path.join(root, 'long-subject')
    await fs.writeFile(
      raw,
      `tree ${tree}\nparent ${base}\nauthor a <a@x> 1700000000 +0000\n` +
        `committer a <a@x> 1700000000 +0000\n\n${'s'.repeat(70 * 1024)}\n`,
    )
    const long = await git('--git-dir', githubPath, 'hash-object', '-t', 'commit', '-w', raw)
    await git('--git-dir', githubPath, 'update-ref', 'refs/heads/main', long)
    const github = gateway()
    await fetchGitHubIntoRemoteGit(transfer(github))
    await git('--git-dir', remoteGitPath, 'update-ref', 'refs/heads/main', long)
    await seed.raw(['fetch', '-q', githubPath, 'main'])
    await seed.raw(['checkout', '-q', '-B', 'feature', 'FETCH_HEAD'])
    await commitAndPush(remoteGitPath, 'refs/heads/feature', 'feature.txt')
    const started = Date.now()

    const caught = await pushVia(github, 'feature').catch((err: unknown) => err)

    expect(String(caught)).toContain('does not end within 65536 bytes')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('fails transient on a second need-objects for the same push', async () => {
    const { feature } = await featureAhead()
    const github = gateway()
    // A gateway that keeps asking, offered a bundle that is empty: it names the commit itself.
    vi.spyOn(github, 'push').mockResolvedValue({ kind: 'need-objects', usable: [feature] })

    const caught = await pushVia(github, 'feature').catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(GitHubTransientError)
    expect((caught as GitHubTransientError).code).toBe('objects-still-needed')
    expect(github.push).toHaveBeenCalledTimes(2)
  })
})

describe('outgoing bundles', () => {
  it('fails a bundle a later fetch replaced as transient, and keeps the open one readable', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const github = gateway()
    const first = await github.fetch({ have: [] })
    const second = await github.fetch({ have: [] })
    expect(first.bundleId).not.toBe(second.bundleId)

    const caught = await github.openBundle(first.bundleId!).catch((err: unknown) => err)
    expect(caught).toBeInstanceOf(GitHubTransientError)
    expect((caught as GitHubTransientError).code).toBe('bundle-gone')

    const open = await github.openBundle(second.bundleId!)
    await github.fetch({ have: [] })
    const target = path.join(root, 'target.git')
    await git('init', '-q', '--bare', target)
    const out = path.join(root, 'read.bundle')
    await fs.writeFile(out, open)
    await expect(git('--git-dir', target, 'bundle', 'unbundle', out)).resolves.toMatch(
      /refs\/heads\/main/,
    )
    await expect(github.openBundle(second.bundleId!)).rejects.toBeInstanceOf(GitHubTransientError)
  })
})

describe('the tracking namespace', () => {
  it('follows a branch GitHub renamed onto a path under its old name (a → a/b)', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const release = await commitAndPush(githubPath, 'refs/heads/release', 'release.txt')
    const github = gateway()
    await fetchGitHubIntoRemoteGit(transfer(github))
    expect(await tip(remoteGitPath, 'refs/remotes/github/release')).toBe(release)
    await git('--git-dir', githubPath, 'update-ref', '-d', 'refs/heads/release')
    await git('--git-dir', githubPath, 'update-ref', 'refs/heads/release/1.0', release)
    const observed = spySpawns()

    await fetchGitHubIntoRemoteGit(transfer(github))

    expect(await tip(remoteGitPath, 'refs/remotes/github/release')).toBeNull()
    expect(await tip(remoteGitPath, 'refs/remotes/github/release/1.0')).toBe(release)
    // The deletions, then the creates and updates: no transaction failed and fell back.
    expect(observed.filter((s) => subcommand(s.args) === 'update-ref')).toHaveLength(2)
  })

  it('fails the fetch, rather than logging a lost race, when the move is aborted', async () => {
    const main = await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const github = gateway()
    await fetchGitHubIntoRemoteGit(transfer(github))
    // A new branch at a commit remote.git has: no bundle, one ref to move.
    await git('--git-dir', githubPath, 'update-ref', 'refs/heads/also', main)
    const controller = new AbortController()
    const fetch = github.fetch.bind(github)
    vi.spyOn(github, 'fetch').mockImplementation(async (request, signal) => {
      const answered = await fetch(request, signal)
      controller.abort()
      return answered
    })

    const caught = await fetchGitHubIntoRemoteGit(transfer(github), controller.signal).catch(
      (err: unknown) => err,
    )

    expect(String(caught)).toContain('git update-ref was aborted')
    expect(consoleSpy).not.toHaveWarned(/Could not move/)
  })

  it('still moves the updates when a stale packed-refs lock holds back the deletions', async () => {
    await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    await commitAndPush(githubPath, 'refs/heads/gone', 'gone.txt')
    const github = gateway()
    await fetchGitHubIntoRemoteGit(transfer(github))
    await git('--git-dir', githubPath, 'update-ref', '-d', 'refs/heads/gone')
    const next = await commitAndPush(githubPath, 'refs/heads/main', 'next.txt')
    // As a writer killed mid-delete leaves it.
    await fs.writeFile(path.join(remoteGitPath, 'packed-refs.lock'), '')

    await fetchGitHubIntoRemoteGit(transfer(github))

    expect(await tip(remoteGitPath, 'refs/remotes/github/main')).toBe(next)
    expect(await tip(remoteGitPath, 'refs/remotes/github/gone')).not.toBeNull()
    expect(consoleSpy).toHaveWarned(
      /Could not move 1 GitHub tracking ref.*refs\/remotes\/github\/gone/,
    )
  })

  it('moves the refs that can move when one lost a race, and names the one that did not', async () => {
    const main = await commitAndPush(githubPath, 'refs/heads/main', 'main.txt')
    const other = await commitAndPush(githubPath, 'refs/heads/other', 'other.txt')
    const github = gateway()
    await fetchGitHubIntoRemoteGit(transfer(github))
    const nextMain = await commitAndPush(githubPath, 'refs/heads/main', 'next.txt')
    const nextOther = await commitAndPush(githubPath, 'refs/heads/other', 'next-other.txt')
    // Something moves one tracking ref between the worker's read and its update.
    let raced = false
    spySpawns((spawned) => {
      if (!raced && subcommand(spawned.args) === 'update-ref') {
        raced = true
        childProcess.execFileSync('git', [
          '--git-dir',
          remoteGitPath,
          'update-ref',
          'refs/remotes/github/other',
          main,
        ])
      }
    })

    await fetchGitHubIntoRemoteGit(transfer(github))

    expect(raced).toBe(true)
    expect(await tip(remoteGitPath, 'refs/remotes/github/main')).toBe(nextMain)
    expect(await tip(remoteGitPath, 'refs/remotes/github/other')).toBe(main)
    expect(consoleSpy).toHaveWarned(
      /Could not move 1 GitHub tracking ref.*refs\/remotes\/github\/other/,
    )
    expect(other).not.toBe(nextOther)

    await fetchGitHubIntoRemoteGit(transfer(github))
    expect(await tip(remoteGitPath, 'refs/remotes/github/other')).toBe(nextOther)
  })
})
