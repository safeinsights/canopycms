/**
 * The GitHub mirror's upkeep against real git: what a killed gateway leaves in the mirror, a
 * mirror that would lie about GitHub, and maintenance beside sessions. "GitHub" is a local bare
 * repository.
 */

import childProcess, { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { SimpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fixtureCredential, initTestRepo, mockConsole, type MockConsole } from '../test-utils'
import { resolveWorkerGitHubAuth } from './github-auth'
import { createLocalGitHubGateway, type GitHubGateway } from './github-gateway'
import { GitHubMirror, GitHubTransientError } from './github-mirror'
import type { MaintenanceMutex } from './github-mirror-upkeep'

const execFileAsync = promisify(execFile)
const git = async (...args: string[]) => (await execFileAsync('git', args)).stdout.trim()

let root: string
let githubPath: string
let stateDirectory: string
let mirrorDir: string
let seedPath: string
let seed: SimpleGit
let consoleSpy: MockConsole

async function commitAndPush(file: string): Promise<string> {
  await fs.writeFile(path.join(seedPath, file), `${file}\n`)
  await seed.add('.')
  await seed.commit(file)
  await seed.raw(['push', '-q', '--force', githubPath, 'HEAD:refs/heads/main'])
  return (await seed.revparse(['HEAD'])).trim()
}

function gateway(remoteUrl: string | (() => Promise<string>) = githubPath): GitHubGateway {
  return createLocalGitHubGateway({
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    auth: resolveWorkerGitHubAuth({ githubToken: 'fake-token' }),
    githubApp: false,
    stateDirectory,
    workspacePath: path.join(root, 'workspace'),
    timeoutMs: 30_000,
    remoteUrl,
  })
}

const exists = (file: string) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  )

/** A head naming an object the mirror does not have. */
const GHOST = '1'.repeat(40)
const plantGhostHead = (gitDir = mirrorDir) =>
  fs.writeFile(path.join(gitDir, 'refs', 'heads', 'ghost'), `${GHOST}\n`)

const warnings = () => consoleSpy.all().warn

/** The git subcommand of an argv, after its `-c` pairs. */
function subcommand(args: readonly string[]): string {
  let i = 0
  while (args[i] === '-c') i += 2
  return args[i]
}

interface MirrorInternals {
  maintenance: MaintenanceMutex
}

beforeEach(async () => {
  consoleSpy = mockConsole()
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-mirror-upkeep-')))
  githubPath = path.join(root, 'github.git')
  stateDirectory = path.join(root, 'state')
  mirrorDir = path.join(stateDirectory, 'github.git')
  seedPath = path.join(root, 'seed')
  await fs.mkdir(seedPath)
  seed = await initTestRepo(seedPath)
  await seed.raw(['checkout', '-q', '-b', 'main'])
  await git('init', '-q', '--bare', githubPath)
  await commitAndPush('base.txt')
})

afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  consoleSpy.restore()
  await fs.rm(root, { recursive: true, force: true })
})

describe('what a stopped gateway left', () => {
  it("is swept at the next gateway's first session, which then fetches past it", async () => {
    await gateway().fetch({ have: [] })
    const next = await commitAndPush('next.txt')
    const planted = [
      'refs/heads/main.lock',
      'packed-refs.lock',
      'HEAD.lock',
      'config.lock',
      'shallow.lock',
      'objects/pack/tmp_pack_planted',
      'objects/pack/tmp_idx_planted',
      'objects/pack/.tmp-1-pack-planted.pack',
      'objects/pack/pack-planted.keep',
      'objects/pack/multi-pack-index.lock',
      'objects/info/commit-graph.lock',
      'objects/info/tmp_graph_planted',
      'objects/info/commit-graphs/commit-graph-chain.lock',
      'objects/info/commit-graphs/tmp_graph_planted',
    ]
    for (const file of planted) {
      await fs.mkdir(path.dirname(path.join(mirrorDir, file)), { recursive: true })
      await fs.writeFile(path.join(mirrorDir, file), '')
    }

    const fetched = await gateway().fetch({ have: [] })

    expect(fetched.refs.get('main')).toBe(next)
    for (const file of planted) expect(await exists(path.join(mirrorDir, file)), file).toBe(false)
    const swept = warnings().find((w) => w.includes('Removed what a stopped gateway left'))
    for (const file of planted) expect(swept, file).toContain(file)
  })

  it('finishes a swap a crash interrupted, keeping the rebuilt mirror over the old one', async () => {
    const main = (await gateway().fetch({ have: [] })).refs.get('main')
    // Killed between the swap's renames: the old mirror parked, the rebuilt one not yet in place.
    await fs.cp(mirrorDir, `${mirrorDir}.old`, { recursive: true })
    await plantGhostHead(`${mirrorDir}.old`)
    await fs.rename(mirrorDir, `${mirrorDir}.rebuild`)

    const fetched = await gateway().fetch({ have: [] })

    expect(fetched.refs.get('main')).toBe(main)
    expect(await exists(path.join(mirrorDir, 'refs', 'heads', 'ghost'))).toBe(false)
    expect(await exists(`${mirrorDir}.old`)).toBe(false)
    expect(await exists(`${mirrorDir}.rebuild`)).toBe(false)
    expect(consoleSpy).not.toHaveWarned(/Rebuilt the GitHub mirror/)
  })

  it('removes a leftover .rebuild and .old beside a whole mirror, keeping the mirror', async () => {
    await gateway().fetch({ have: [] })
    for (const leftover of [`${mirrorDir}.rebuild`, `${mirrorDir}.old`]) {
      await fs.cp(mirrorDir, leftover, { recursive: true })
      await plantGhostHead(leftover)
    }
    const next = await commitAndPush('next.txt')

    const fetched = await gateway().fetch({ have: [] })

    expect(fetched.refs.get('main')).toBe(next)
    expect(await exists(`${mirrorDir}.rebuild`)).toBe(false)
    expect(await exists(`${mirrorDir}.old`)).toBe(false)
    expect(consoleSpy).not.toHaveWarned(/Rebuilt the GitHub mirror/)
  })
})

describe('a mirror that would lie about GitHub', () => {
  const corruptions: [string, () => Promise<unknown>, RegExp][] = [
    [
      'a head naming a missing object',
      () => plantGhostHead(),
      /refs\/heads\/ghost names a missing object/,
    ],
    [
      'a remote.*.promisor key',
      () =>
        git('config', '--file', path.join(mirrorDir, 'config'), 'remote.origin.promisor', 'true'),
      /remote\.origin\.promisor/,
    ],
    [
      'a remote.*.partialclonefilter key',
      () =>
        git(
          'config',
          '--file',
          path.join(mirrorDir, 'config'),
          'remote.origin.partialclonefilter',
          'blob:none',
        ),
      /remote\.origin\.partialclonefilter/,
    ],
    [
      'extensions.partialClone',
      () =>
        git(
          'config',
          '--file',
          path.join(mirrorDir, 'config'),
          'extensions.partialClone',
          'origin',
        ),
      /extensions\.partialclone/,
    ],
    [
      'a promisor pack',
      () => fs.writeFile(path.join(mirrorDir, 'objects', 'pack', 'pack-planted.promisor'), ''),
      /promisor pack \(pack-planted\.promisor\)/,
    ],
  ]

  it.each(corruptions)(
    'is rebuilt from GitHub at the next session when it has %s, and the next session goes ahead',
    async (_label, corrupt, reason) => {
      await gateway().fetch({ have: [] })
      await corrupt()
      const next = await commitAndPush('next.txt')
      const github = gateway()

      const fetched = await github.fetch({ have: [] })

      expect(fetched.refs.get('main')).toBe(next)
      const rebuilt = warnings().filter((w) => /Rebuilt the GitHub mirror from GitHub/.test(w))
      expect(rebuilt).toHaveLength(1)
      expect(rebuilt[0]).toMatch(reason)
      expect(await exists(path.join(mirrorDir, 'refs', 'heads', 'ghost'))).toBe(false)
      expect(await git('--git-dir', mirrorDir, 'config', '--get-regexp', '.')).not.toMatch(
        /promisor|partialclone/i,
      )
      expect(await exists(`${mirrorDir}.rebuild`)).toBe(false)
      expect(await exists(`${mirrorDir}.old`)).toBe(false)

      const again = await commitAndPush('again.txt')
      await new Promise((resolve) => setTimeout(resolve, 1))
      expect((await gateway().fetch({ have: [] })).refs.get('main')).toBe(again)
      expect(warnings().filter((w) => /Rebuilt the GitHub mirror/.test(w))).toHaveLength(1)
    },
  )

  it('is kept when its rebuild fails, and not rebuilt again until the backoff has passed', async () => {
    await gateway().fetch({ have: [] })
    await plantGhostHead()
    let url = path.join(root, 'missing.git')
    const github = gateway(async () => url)

    const failed = await github.fetch({ have: [] }).catch((err: unknown) => err)

    expect(failed).toBeInstanceOf(GitHubTransientError)
    expect((failed as GitHubTransientError).code).toBe('mirror-corrupt')
    expect(String(failed)).toMatch(/the rebuild failed/)
    expect(await exists(path.join(mirrorDir, 'refs', 'heads', 'ghost'))).toBe(true)
    expect(await exists(`${mirrorDir}.rebuild`)).toBe(false)

    url = githubPath
    const held = await github.fetch({ have: [] }).catch((err: unknown) => err)

    expect(held).toBeInstanceOf(GitHubTransientError)
    expect(String(held)).toMatch(/the next fetch from GitHub does it/)
    expect(await exists(path.join(mirrorDir, 'refs', 'heads', 'ghost'))).toBe(true)

    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60 * 1000)
    const next = await commitAndPush('next.txt')

    expect((await github.fetch({ have: [] })).refs.get('main')).toBe(next)
    expect(await exists(path.join(mirrorDir, 'refs', 'heads', 'ghost'))).toBe(false)
  })
})

describe('maintenance', () => {
  it('holds the mutex a rebuild waits on, never waits for a session, and both finish', async () => {
    const credential = fixtureCredential(githubPath)
    const mirror = new GitHubMirror(stateDirectory, 30_000, 0)
    await mirror.exclusive((session) => mirror.fetchFromGitHub(session, credential))
    await plantGhostHead()
    // A failed session makes the next one check the mirror again.
    await mirror.exclusive(() => Promise.reject(new Error('planted'))).catch(() => undefined)
    const events: string[] = []
    const mutex = (mirror as unknown as MirrorInternals).maintenance
    const tryAcquire = mutex.tryAcquire.bind(mutex)
    let holders = 0
    vi.spyOn(mutex, 'tryAcquire').mockImplementation(() => {
      const release = tryAcquire()
      if (release === null) {
        events.push('busy')
        return null
      }
      const holder = ++holders
      events.push(`acquired ${holder}`)
      return () => {
        events.push(`released ${holder}`)
        release()
      }
    })
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      events.push(`rename ${path.basename(String(from))}`)
      return rename(from, to)
    })
    let open!: () => void
    const opened = new Promise<void>((resolve) => (open = resolve))

    // The session the rebuild runs in is held until maintenance is running.
    const rebuild = mirror.exclusive(async (session) => {
      await opened
      await mirror.heal(session, credential)
    })
    await mirror.afterFetch()
    expect(events).toEqual(['acquired 1'])
    open()
    await rebuild

    expect(events).toEqual([
      'acquired 1',
      'busy',
      'released 1',
      'acquired 2',
      'rename github.git',
      'rename github.git.rebuild',
      'released 2',
    ])
    expect(consoleSpy).toHaveWarned(/Rebuilt the GitHub mirror from GitHub/)
    expect(await exists(path.join(mirrorDir, 'refs', 'heads', 'ghost'))).toBe(false)
  })

  it('runs git only in the state directory, with --end-of-options, and never with a credential', async () => {
    const credential = fixtureCredential(githubPath)
    const mirror = new GitHubMirror(stateDirectory, 30_000, 0)
    await mirror.exclusive((session) => mirror.fetchFromGitHub(session, credential))
    // More loose objects than maintenance tolerates, so it repacks.
    const blobs = path.join(root, 'blobs')
    await fs.mkdir(blobs)
    const files: string[] = []
    for (let i = 0; i < 60; i++) {
      files.push(path.join(blobs, `${i}.txt`))
      await fs.writeFile(files[i], `${i}\n`)
    }
    await git('--git-dir', mirrorDir, 'hash-object', '-w', '--', ...files)
    const observed: { args: string[]; cwd?: string; env: Record<string, string | undefined> }[] = []
    const spawn = childProcess.spawn
    vi.spyOn(childProcess, 'spawn').mockImplementation(((
      command: string,
      args: readonly string[],
      options: { cwd?: string; env?: Record<string, string | undefined> },
    ) => {
      observed.push({ args: [...args], cwd: options?.cwd, env: { ...(options?.env ?? {}) } })
      return spawn(command, args, options)
    }) as typeof childProcess.spawn)
    syncBuiltinESMExports()
    const mutex = (mirror as unknown as MirrorInternals).maintenance

    await mirror.afterFetch()
    // Maintenance is detached: done once the mutex is free again.
    const release = await mutex.acquire()
    release()

    const subcommands = observed.map((s) => subcommand(s.args))
    expect(subcommands).toEqual(
      expect.arrayContaining(['count-objects', 'repack', 'commit-graph', 'pack-refs']),
    )
    expect(subcommands.at(-1)).toBe('pack-refs')
    for (const spawned of observed) {
      const label = spawned.args.join(' ')
      const relative = path.relative(stateDirectory, spawned.cwd ?? '/')
      expect(relative.startsWith('..') || path.isAbsolute(relative), `cwd of ${label}`).toBe(false)
      expect(spawned.args, label).toContain('--end-of-options')
      expect(spawned.env.GIT_CONFIG_GLOBAL, label).toBeUndefined()
    }
    expect(consoleSpy).toHaveLogged(/GitHub mirror repacked/)
    expect(
      Number(/count: (\d+)/.exec(await git('--git-dir', mirrorDir, 'count-objects', '-v'))?.[1]),
    ).toBe(0)
  })
})
