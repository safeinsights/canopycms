/**
 * [PROV-1] under real SIGKILLs: a child process (`__integration__/fixtures/provision-child.ts`)
 * provisions a branch or the settings workspace, and is killed at every step boundary, at random
 * points, and with only its git child killed mid-clone. After each kill the final path is absent
 * or complete, never residue, and a retry of the same name succeeds.
 *
 * The child runs under `node --import tsx` rather than the tsx CLI, whose IPC pipe the sandbox
 * refuses. It is spawned `detached`, so killing its process group takes git with it. Kills are
 * triggered by its stdout step lines, never by sleeps: the child pauses after writing the line a
 * kill targets, so the kill lands at that boundary.
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { simpleGit } from 'simple-git'

import { classifyFinalDir, sweepProvisioningLeftovers } from './branch-provisioning'
import { BranchWorkspaceManager } from './branch-workspace'
import { defineCanopyTestConfig } from './config-test'
import { SettingsWorkspaceManager } from './settings-workspace'
import { initTestRepo, mockConsole } from './test-utils'

const PACKAGE_ROOT = path.resolve(__dirname, '..')
const CHILD = path.join(__dirname, '__integration__', 'fixtures', 'provision-child.ts')
const SETTINGS_BRANCH = 'canopycms-settings-kill'
const CHILD_TIMEOUT_MS = 30_000

let tmpDir: string
let sourceDir: string
let scenario = 0

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-prov-kill-'))
  sourceDir = path.join(tmpDir, 'source')
  await fs.mkdir(path.join(sourceDir, 'content'), { recursive: true })
  const source = await initTestRepo(sourceDir)
  await source.raw(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  // Enough files that a checkout is not instantaneous.
  for (let i = 0; i < 300; i++) {
    await fs.writeFile(path.join(sourceDir, 'content', `entry-${i}.md`), `# entry ${i}\n`)
  }
  await source.add('.')
  await source.commit('initial')
})

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

/** A fresh workspace root with its own `remote.git`, where prod auto-detects it. */
async function newWorkspace(): Promise<{ workspaceRoot: string; remoteUrl: string }> {
  const workspaceRoot = path.join(tmpDir, `ws-${scenario++}`)
  const remoteUrl = path.join(workspaceRoot, 'remote.git')
  await fs.mkdir(workspaceRoot, { recursive: true })
  await simpleGit().raw(['clone', '-q', '--bare', sourceDir, remoteUrl])
  return { workspaceRoot, remoteUrl }
}

type Kind = 'branch' | 'settings'

interface ChildRun {
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

interface KillPlan {
  /**
   * Kill the process group on the first stdout line containing `text`, after `delayMs`. With
   * `pause`, the child holds still after writing that line until it is killed.
   */
  onLine?: { text: string; delayMs: number; pause: boolean }
  /** Once the PATH shim reports a stalled git clone, kill just that git, or the whole group. */
  onStalledGit?: { pidFile: string; target: 'git' | 'group' }
  env?: Record<string, string>
}

function runChild(kind: Kind, workspaceRoot: string, remoteUrl: string, plan: KillPlan) {
  return new Promise<ChildRun>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CHILD, kind, workspaceRoot, remoteUrl],
      {
        cwd: PACKAGE_ROOT,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...plan.env,
          ...(plan.onLine?.pause ? { PROVISION_CHILD_PAUSE_AT: plan.onLine.text } : {}),
        },
      },
    )
    const pid = child.pid
    if (pid === undefined) {
      reject(new Error('child did not start'))
      return
    }
    const killGroup = () => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    let stdout = ''
    let stderr = ''
    let triggered = false
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (triggered || !plan.onLine) return
      if (stdout.includes(plan.onLine.text)) {
        triggered = true
        setTimeout(killGroup, plan.onLine.delayMs)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    let pollTimer: NodeJS.Timeout | undefined
    const stalledGit = plan.onStalledGit
    if (stalledGit) {
      const poll = async () => {
        const gitPid = Number(await fs.readFile(stalledGit.pidFile, 'utf8').catch(() => ''))
        if (gitPid > 0) {
          if (stalledGit.target === 'git') process.kill(gitPid, 'SIGKILL')
          else killGroup()
          return
        }
        pollTimer = setTimeout(() => void poll(), 20)
      }
      void poll()
    }

    const watchdog = setTimeout(() => {
      killGroup()
      reject(new Error(`child outlived ${CHILD_TIMEOUT_MS} ms:\n${stdout}\n${stderr}`))
    }, CHILD_TIMEOUT_MS)
    child.on('exit', (_code, signal) => {
      clearTimeout(watchdog)
      clearTimeout(pollTimer)
      // A grandchild that outlived the child is a test leak; the group kill should leave none.
      killGroup()
      resolve({ signal, stdout, stderr })
    })
  })
}

function config(remoteUrl: string) {
  return defineCanopyTestConfig({
    mode: 'prod',
    defaultBaseBranch: 'main',
    defaultRemoteUrl: remoteUrl,
    deploymentName: 'kill',
    schema: { collections: [] },
  })
}

/** A lock a killed holder left behind goes stale after 90 s; age it past that instead of waiting. */
async function ageLockMarkers(workspaceRoot: string): Promise<void> {
  const old = new Date(Date.now() - 120_000)
  for (const marker of [
    path.join(workspaceRoot, 'content-branches', '.feat.init.lock'),
    path.join(workspaceRoot, '.settings-init', 'lock'),
  ]) {
    await fs.utimes(marker, old, old).catch(() => {})
  }
}

async function expectCleanCheckout(root: string, branch: string): Promise<void> {
  const head = await fs.readFile(path.join(root, '.git', 'HEAD'), 'utf8')
  expect(head.trim()).toBe(`ref: refs/heads/${branch}`)
  expect(await simpleGit({ baseDir: root }).raw(['status', '--porcelain'])).toBe('')
}

/** Absent, or a complete branch workspace: never residue. */
async function expectBranchAbsentOrComplete(workspaceRoot: string, remoteUrl: string) {
  const finalPath = path.join(workspaceRoot, 'content-branches', 'feat')
  const state = await classifyFinalDir(finalPath, remoteUrl)
  expect(['vacant', 'live']).toContain(state.kind)
  if (state.kind === 'live') await expectCleanCheckout(finalPath, 'feat')
}

async function expectSettingsAbsentOrComplete(workspaceRoot: string) {
  const settingsRoot = path.join(workspaceRoot, 'settings')
  const exists = await fs.stat(settingsRoot).then(
    () => true,
    () => false,
  )
  if (exists) await expectCleanCheckout(settingsRoot, SETTINGS_BRANCH)
}

async function retryBranch(workspaceRoot: string, remoteUrl: string): Promise<void> {
  await ageLockMarkers(workspaceRoot)
  vi.stubEnv('CANOPYCMS_WORKSPACE_ROOT', workspaceRoot)
  try {
    const outcome = await new BranchWorkspaceManager(config(remoteUrl)).provisionBranch({
      branchName: 'feat',
      mode: 'prod',
      createdBy: 'retry',
    })
    expect(['created', 'exists']).toContain(outcome.kind)
    await expectCleanCheckout(path.join(workspaceRoot, 'content-branches', 'feat'), 'feat')
  } finally {
    vi.unstubAllEnvs()
  }
  // Whatever the kill stranded is the worker's to sweep once it is old enough.
  const later = Date.now() + 21 * 60_000
  await sweepProvisioningLeftovers(
    path.join(workspaceRoot, 'content-branches'),
    workspaceRoot,
    later,
  )
  const left = await fs.readdir(path.join(workspaceRoot, 'content-branches'))
  expect(left.filter((name) => /^\.(prov|repair|deleting)-/.test(name))).toEqual([])
}

async function retrySettings(workspaceRoot: string, remoteUrl: string): Promise<void> {
  await ageLockMarkers(workspaceRoot)
  const settingsRoot = path.join(workspaceRoot, 'settings')
  await new SettingsWorkspaceManager(config(remoteUrl)).ensureGitWorkspace({
    settingsRoot,
    branchName: SETTINGS_BRANCH,
    mode: 'prod',
    remoteUrl,
  })
  await expectCleanCheckout(settingsRoot, SETTINGS_BRANCH)
  await sweepProvisioningLeftovers(
    path.join(workspaceRoot, 'content-branches'),
    workspaceRoot,
    Date.now() + 21 * 60_000,
  )
  const left = await fs.readdir(workspaceRoot)
  expect(left.filter((name) => name.startsWith('.prov-'))).toEqual([])
}

const boundaries = (steps: string[]) => [
  ...steps.flatMap((step) => [`step=${step} start`, `step=${step} done`]),
  'outcome=',
]

const BRANCH_BOUNDARIES = boundaries([
  'clone',
  'checkout',
  'exclude',
  'metadata',
  'publish',
  'register',
])
const SETTINGS_BOUNDARIES = boundaries(['clone', 'checkout', 'exclude', 'publish'])

describe('content branch provisioning under SIGKILL', () => {
  it.each(BRANCH_BOUNDARIES)('killed at "%s"', async (boundary) => {
    const { workspaceRoot, remoteUrl } = await newWorkspace()

    const run = await runChild('branch', workspaceRoot, remoteUrl, {
      onLine: { text: `dir=feat ${boundary}`, delayMs: 0, pause: true },
    })

    expect(run.signal, run.stdout).toBe('SIGKILL')
    await expectBranchAbsentOrComplete(workspaceRoot, remoteUrl)
    await retryBranch(workspaceRoot, remoteUrl)
  })

  it.each([0, 1, 2, 3])('killed at a random point (run %i)', async () => {
    const { workspaceRoot, remoteUrl } = await newWorkspace()
    const delayMs = Math.floor(Math.random() * 120)

    const run = await runChild('branch', workspaceRoot, remoteUrl, {
      onLine: { text: 'dir=feat step=clone start', delayMs, pause: false },
    })

    await expectBranchAbsentOrComplete(workspaceRoot, remoteUrl).catch((err: unknown) => {
      throw new Error(`after a kill ${delayMs} ms into the clone (${run.signal}): ${String(err)}`)
    })
    await retryBranch(workspaceRoot, remoteUrl)
  })

  describe('with git stalled mid-clone', () => {
    /**
     * A `git` on PATH that, once, writes partial clone output into the target and then stalls
     * as `sleep`, reporting its pid; every other call is the real git.
     */
    async function stallingGitShim(): Promise<{ env: Record<string, string>; pidFile: string }> {
      const shimDir = path.join(tmpDir, `shim-${scenario++}`)
      await fs.mkdir(shimDir)
      const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim()
      const flag = path.join(shimDir, 'stall-once')
      const pidFile = path.join(shimDir, 'stalled.pid')
      await fs.writeFile(flag, '')
      const shim = [
        '#!/bin/sh',
        'for last; do :; done',
        `if [ -f '${flag}' ] && [ "$(echo " $* " | grep -c ' clone ')" = 1 ]; then`,
        `  rm -f '${flag}'`,
        '  mkdir -p "$last/.git/objects" && : > "$last/.git/config.lock"',
        `  echo $$ > '${pidFile}.tmp' && mv '${pidFile}.tmp' '${pidFile}'`,
        '  exec sleep 60',
        'fi',
        `exec '${realGit}' "$@"`,
        '',
      ].join('\n')
      await fs.writeFile(path.join(shimDir, 'git'), shim, { mode: 0o755 })
      return { env: { PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}` }, pidFile }
    }

    it('survives its git child being killed: the clone is retried and the branch provisioned', async () => {
      const { workspaceRoot, remoteUrl } = await newWorkspace()
      const { env, pidFile } = await stallingGitShim()

      const run = await runChild('branch', workspaceRoot, remoteUrl, {
        onStalledGit: { pidFile, target: 'git' },
        env,
      })

      expect(run.stdout).toContain('CHILD done created')
      expect(run.stderr).toMatch(/failed, retrying once/)
      await expectBranchAbsentOrComplete(workspaceRoot, remoteUrl)
      await expect(
        classifyFinalDir(path.join(workspaceRoot, 'content-branches', 'feat'), remoteUrl),
      ).resolves.toEqual({ kind: 'live' })
    })

    it('leaves nothing at the branch name when the whole group dies with git mid-clone', async () => {
      const { workspaceRoot, remoteUrl } = await newWorkspace()
      const { env, pidFile } = await stallingGitShim()

      const run = await runChild('branch', workspaceRoot, remoteUrl, {
        onStalledGit: { pidFile, target: 'group' },
        env,
      })

      expect(run.signal).toBe('SIGKILL')
      // The group kill took the stalled git with it (polled: init reaps it asynchronously).
      const stalledPid = Number(await fs.readFile(pidFile, 'utf8'))
      await vi.waitFor(() => expect(() => process.kill(stalledPid, 0)).toThrow(/ESRCH/), {
        timeout: 5_000,
      })
      await expectBranchAbsentOrComplete(workspaceRoot, remoteUrl)
      await retryBranch(workspaceRoot, remoteUrl)
    })
  })
})

describe('settings workspace provisioning under SIGKILL', () => {
  it.each(SETTINGS_BOUNDARIES)('killed at "%s"', async (boundary) => {
    const { workspaceRoot, remoteUrl } = await newWorkspace()

    const run = await runChild('settings', workspaceRoot, remoteUrl, {
      onLine: { text: `dir=settings ${boundary}`, delayMs: 0, pause: true },
    })

    expect(run.signal, run.stdout).toBe('SIGKILL')
    await expectSettingsAbsentOrComplete(workspaceRoot)
    const consoleSpy = mockConsole()
    try {
      await retrySettings(workspaceRoot, remoteUrl)
    } finally {
      consoleSpy.restore()
    }
  })

  it.each([0, 1])('killed at a random point (run %i)', async () => {
    const { workspaceRoot, remoteUrl } = await newWorkspace()
    const delayMs = Math.floor(Math.random() * 200)

    await runChild('settings', workspaceRoot, remoteUrl, {
      onLine: { text: 'dir=settings step=clone start', delayMs, pause: false },
    })

    await expectSettingsAbsentOrComplete(workspaceRoot)
    const consoleSpy = mockConsole()
    try {
      await retrySettings(workspaceRoot, remoteUrl)
    } finally {
      consoleSpy.restore()
    }
  })
})
