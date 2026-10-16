/**
 * The not-ready 503 driven through real prod provisioning, with no remote.git in the workspace:
 * the typed error reaches the handler's catch through every layer it crosses in production, so a
 * layer that wraps it fails here rather than passing a test that injects it.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { simpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AuthPlugin } from '../auth/plugin'
import { defineCanopyTestConfig } from '../config-test'
import { clearStrategyCache } from '../operating-mode/client-unsafe-strategy'
import { writeWorkerStatus } from '../task-queue/worker-status'
import { mockConsole, type MockConsole } from '../test-utils'
import { BaseBranchUnresolvedError } from '../utils/base-branch'
import { createCanopyRequestHandlerFromConfig } from './handler'
import { isCanopyBinaryResponse } from './types'
import { WORKER_NOT_READY_MESSAGE } from './worker-not-ready'

let signedInAs = 'admin-1'

const authPlugin: AuthPlugin = {
  verifiesCredentials: true,
  authenticate: async () => ({ success: true, user: { userId: signedInAs, externalGroups: [] } }),
  searchUsers: async () => [],
  getUserMetadata: async () => null,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
}

describe('the not-ready 503 under real prod provisioning', () => {
  let workspaceRoot: string
  let previousRoot: string | undefined
  let previousAdmins: string | undefined
  let consoleSpy: MockConsole

  beforeEach(async () => {
    consoleSpy = mockConsole()
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-not-ready-'))
    previousRoot = process.env.CANOPYCMS_WORKSPACE_ROOT
    process.env.CANOPYCMS_WORKSPACE_ROOT = workspaceRoot
    previousAdmins = process.env.CANOPY_BOOTSTRAP_ADMIN_IDS
    process.env.CANOPY_BOOTSTRAP_ADMIN_IDS = 'admin-1'
    signedInAs = 'admin-1'
    clearStrategyCache()
  })

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env.CANOPYCMS_WORKSPACE_ROOT
    else process.env.CANOPYCMS_WORKSPACE_ROOT = previousRoot
    if (previousAdmins === undefined) delete process.env.CANOPY_BOOTSTRAP_ADMIN_IDS
    else process.env.CANOPY_BOOTSTRAP_ADMIN_IDS = previousAdmins
    clearStrategyCache()
    consoleSpy.restore()
    await fs.rm(workspaceRoot, { recursive: true, force: true })
  })

  const createHandler = () =>
    createCanopyRequestHandlerFromConfig({
      config: defineCanopyTestConfig({ schema: {}, mode: 'prod' }),
      authPlugin,
    })

  const getBranches = async (handler?: Awaited<ReturnType<typeof createHandler>>) => {
    const response = await (handler ?? (await createHandler()))(
      {
        method: 'GET',
        url: 'http://localhost/api/canopycms/branches',
        header: () => null,
        json: async () => undefined,
      },
      ['branches'],
    )
    if (isCanopyBinaryResponse(response)) throw new Error('expected a JSON response')
    return response
  }

  const recordStatus = (startedAt: string, fatalAt: string) =>
    writeWorkerStatus(path.join(workspaceRoot, '.tasks'), {
      version: 1,
      startedAt,
      updatedAt: fatalAt,
      lastFatalError: {
        message:
          'Secret arn:aws:secretsmanager:us-east-1:123456789012:secret:bot-token has no field "token" (read for /opt/canopy-worker/.env).',
        at: fatalAt,
        phase: 'startup',
      },
    })

  it('asks the caller to retry while the worker has recorded nothing', async () => {
    const response = await getBranches()

    expect(response.status).toBe(503)
    expect(response.headers?.['Retry-After']).toBe('30')
    expect(response.body).toMatchObject({ ok: false, error: WORKER_NOT_READY_MESSAGE })
  })

  it("names the worker's failed start, with no Retry-After and the account id masked", async () => {
    await recordStatus('2026-10-09T10:00:00.000Z', '2026-10-09T10:00:02.000Z')

    const response = await getBranches()

    expect(response.status).toBe(503)
    expect(response.headers?.['Retry-After']).toBeUndefined()
    expect(response.body).toMatchObject({ ok: false, code: 'WORKER_FAILED' })
    const { error } = response.body as { error: string }
    expect(error).toContain('The CMS worker failed to start')
    expect(error).toContain(
      'arn:aws:secretsmanager:us-east-1:************:secret:bot-token has no field "token" (read for <path>).',
    )
    expect(error).not.toMatch(/[0-9]{12}/)
  })

  it('names the failure to admins only, as System health does', async () => {
    await recordStatus('2026-10-09T10:00:00.000Z', '2026-10-09T10:00:02.000Z')
    signedInAs = 'editor-1'

    const response = await getBranches()

    expect(response.status).toBe(503)
    expect(response.headers?.['Retry-After']).toBeUndefined()
    expect(response.body).toMatchObject({ ok: false, code: 'WORKER_FAILED' })
    const { error } = response.body as { error: string }
    expect(error).toContain('The CMS worker failed to start.')
    expect(error).not.toContain('secretsmanager')
  })

  it('stays retriable while a newer worker starts again after the failure', async () => {
    await recordStatus('2026-10-09T10:05:00.000Z', '2026-10-09T10:00:02.000Z')

    const response = await getBranches()

    expect(response.status).toBe(503)
    expect(response.headers?.['Retry-After']).toBe('30')
    const { error } = response.body as { error: string }
    expect(error).toContain('starting again after a failure')
    expect(error).toContain('has no field "token"')
  })

  it('fails at creation, not as "not ready", when remote.git is not a directory', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'remote.git'), 'not a repository')

    await expect(createHandler()).rejects.toThrow('is not a directory')
  })

  it('fails at creation, naming defaultBaseBranch, when remote.git has no readable HEAD', async () => {
    await simpleGit().raw([
      'init',
      '--bare',
      '--initial-branch=production',
      path.join(workspaceRoot, 'remote.git'),
    ])

    await expect(createHandler()).rejects.toThrow(BaseBranchUnresolvedError)
    await expect(createHandler()).rejects.toThrow(/Set defaultBaseBranch/)
  })

  it('resolves the base branch from remote.git once the worker creates it', async () => {
    const handler = await createHandler()

    const before = await getBranches(handler)
    expect(before.status).toBe(503)
    expect(before.body).toMatchObject({ ok: false, error: WORKER_NOT_READY_MESSAGE })

    // What the worker leaves: a bare clone whose HEAD names the repository's default branch.
    const source = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-not-ready-src-'))
    const git = simpleGit({ baseDir: source })
    await git.init(['--initial-branch=production'])
    await git.addConfig('user.name', 'Test')
    await git.addConfig('user.email', 'test@test.com')
    await fs.writeFile(path.join(source, 'README.md'), '# site\n')
    await git.add('-A')
    await git.commit('initial commit')
    await simpleGit().clone(source, path.join(workspaceRoot, 'remote.git'), ['--bare'])
    await fs.rm(source, { recursive: true, force: true })

    const after = await getBranches(handler)
    expect(after.status).toBe(200)
    await expect(
      fs.stat(path.join(workspaceRoot, 'content-branches', 'production')),
    ).resolves.toBeTruthy()
    await expect(fs.stat(path.join(workspaceRoot, 'content-branches', 'main'))).rejects.toThrow()
  })
})
