/**
 * Provisioning step lines are printed through the ordinary logger, without
 * CANOPYCMS_DEBUG, so a request killed mid-step still shows its last step.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simpleGit } from 'simple-git'

import { BranchWorkspaceManager } from './branch-workspace'
import { defineCanopyTestConfig } from './config-test'
import { initTestRepo } from './test-utils'
import { resetCanopyLogger, setCanopyLogger } from './utils/logger'
import { setProvisionLogSink } from './utils/provision-log'

let tmpDir: string
let lines: string[]
let warnings: string[]

beforeEach(async () => {
  vi.stubEnv('CANOPYCMS_DEBUG', 'false')
  setProvisionLogSink()
  lines = []
  warnings = []
  setCanopyLogger({
    log: (...args: unknown[]) => lines.push(args.join(' ')),
    warn: (...args: unknown[]) => warnings.push(args.join(' ')),
    error: (...args: unknown[]) => warnings.push(args.join(' ')),
  })
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-provision-log-'))
})

afterEach(async () => {
  resetCanopyLogger()
  vi.unstubAllEnvs()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function makeRemote(): Promise<string> {
  const sourceDir = path.join(tmpDir, 'source')
  await fs.mkdir(sourceDir)
  const source = await initTestRepo(sourceDir)
  await source.raw(['branch', '-M', 'main'])
  await fs.writeFile(path.join(sourceDir, 'README.md'), '# hi\n')
  await source.add('.')
  await source.commit('initial')
  const remotePath = path.join(tmpDir, 'remote.git')
  await simpleGit().raw(['clone', '-q', '--bare', sourceDir, remotePath])
  return remotePath
}

function manager(remoteUrl: string): BranchWorkspaceManager {
  return new BranchWorkspaceManager(
    defineCanopyTestConfig({
      defaultBaseBranch: 'main',
      defaultRemoteUrl: remoteUrl,
      schema: { collections: [] },
    }),
  )
}

const STEP_LINE =
  /^\[canopy\] provision id=([0-9a-f]{6}) dir=(\S+) step=(\w+) (start|done ms=\d+|failed ms=\d+)$/

describe('branch provisioning step log', () => {
  it('prints a start and a done line for every step, then a summary', async () => {
    const remoteUrl = await makeRemote()

    await manager(remoteUrl).openOrCreateBranch({
      branchName: 'feature-x',
      mode: 'dev',
      basePathOverride: tmpDir,
      createdBy: 'user-1',
    })

    const provision = lines.filter((line) => line.startsWith('[canopy] provision '))
    const steps = provision.slice(0, -1).map((line) => {
      const match = STEP_LINE.exec(line)
      expect(match, line).not.toBeNull()
      return `${match?.[3]} ${match?.[4].split(' ')[0]}`
    })
    expect(steps).toEqual([
      'clone start',
      'clone done',
      'checkout start',
      'checkout done',
      'exclude start',
      'exclude done',
      'metadata start',
      'metadata done',
      'publish start',
      'publish done',
      'register start',
      'register done',
    ])
    const ids = new Set(provision.map((line) => /id=(\w+)/.exec(line)?.[1]))
    expect(ids.size).toBe(1)
    expect(provision.every((line) => line.includes(' dir=feature-x '))).toBe(true)
    expect(provision.at(-1)).toMatch(
      /outcome=ok total=\d+ clone=\d+ checkout=\d+ exclude=\d+ metadata=\d+ publish=\d+ register=\d+$/,
    )
  })

  it('names the failing step and ends with outcome=error', async () => {
    await expect(
      manager(path.join(tmpDir, 'no-such-remote.git')).openOrCreateBranch({
        branchName: 'feature-y',
        mode: 'dev',
        basePathOverride: tmpDir,
        createdBy: 'user-1',
      }),
    ).rejects.toThrow(/Failed to clone/)

    const provision = lines.filter((line) => line.startsWith('[canopy] provision '))
    expect(provision).toContainEqual(expect.stringMatching(/step=clone failed ms=\d+$/))
    expect(provision.at(-1)).toMatch(/outcome=error total=\d+ clone=\d+$/)
    expect(warnings).toContainEqual(expect.stringMatching(/retrying once/))
  })
})
